"""Générateur de charge RADIUS de la mesure de performance (ticket 10). TEST SEULEMENT.

Ticket : .scratch/phase-1-coeur-radius/issues/10-performance.md
Boucle ouverte : `debit` Access-Request par seconde pendant `duree` secondes, répartis sur les
routeurs de mesure (une socket par routeur, liée à son IP overlay), CHAP avec
Message-Authenticator, comme le hotspot MikroTik. Chaque réponse est VÉRIFIÉE
(authentificateur et Message-Authenticator, radlib._verifier) ; une réponse fausse est une erreur.

  python3 charge.py --mode accept|reject|interim --debit 200 --duree 30 [--routeurs N] [--sessions S]

  accept : tickets valides, chacun toujours depuis la MÊME MAC (un appareil par ticket) ;
  reject : codes inexistants, MAC aléatoire à chaque requête (l'anti-devinette bloque une
           MAC après 10 échecs en 60 s : sans cela, on mesurerait le blocage, pas authorize).
  interim : Accounting-Request Interim-Update de S sessions (une par ticket), compteurs croissants,
           pour remplir le spool base arrêtée (rattrapage du lecteur detail).
Sortie : une ligne JSON (envoyés, reçus, perdus, latences côté client en ms).
"""
import argparse
import asyncio
import hashlib
import json
import os
import random
import struct
import time

import psycopg

import radlib

# Nœud visé : A par défaut ; B (10.213.0.2) pour la phase « ha » (phase 5, ticket 07).
SERVEUR = (os.environ.get("WAKATNET_PERF_SERVEUR", "10.213.0.1"), 1812)
SERVEUR_ACCT = (SERVEUR[0], 1813)
PG = dict(host="172.29.215.5", dbname="wakatnet", user="wakatnet_admin", password=os.environ["POSTGRES_PASSWORD"])
SECRET = os.environ["WAKATNET_SECRET_R1"].encode()
ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"


def paquet(code: str, mac: str) -> tuple[bytes, bytes, int]:
    """Access-Request CHAP + Message-Authenticator (même construction que radlib.access_request)."""
    auth_req, ident = os.urandom(16), os.urandom(1)[0]
    chap_id, defi = os.urandom(1), os.urandom(16)
    corps = (radlib._attr(1, code.encode())
             + radlib._attr(3, chap_id + hashlib.md5(chap_id + code.encode() + defi).digest())
             + radlib._attr(60, defi) + radlib._attr(32, b"perf") + radlib._attr(31, mac.encode())
             + radlib._attr(30, b"hotspot1"))
    corps = radlib._attr(80, b"\x00" * 16) + corps
    p = struct.pack("!BBH", 1, ident, 20 + len(corps)) + auth_req + corps
    import hmac
    mac_attr = hmac.new(SECRET, p, hashlib.md5).digest()
    return p[:22] + mac_attr + p[38:], auth_req, ident


def paquet_interim(code: str, sid: str, rang: int) -> tuple[bytes, bytes, int]:
    """Accounting-Request Interim-Update (RFC 2866), comme radlib.accounting_request."""
    ident = os.urandom(1)[0]
    entier = lambda t, v: radlib._attr(t, struct.pack("!I", v))
    corps = (entier(40, 3) + radlib._attr(44, sid.encode()) + radlib._attr(1, code.encode())
             + entier(42, 1000 * rang) + entier(43, 5000 * rang) + entier(46, 120 * rang)
             + radlib._attr(31, b"02-EE-00-00-00-01") + radlib._attr(32, b"perf"))
    entete = struct.pack("!BBH", 4, ident, 20 + len(corps))
    auth_req = hashlib.md5(entete + b"\x00" * 16 + corps + SECRET).digest()
    return entete + auth_req + corps, auth_req, ident


class Routeur(asyncio.DatagramProtocol):
    def __init__(self, resultats):
        self.attente: dict[int, tuple[float, bytes]] = {}
        self.resultats = resultats
        self.libres = list(range(256))

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        ident = data[1] if len(data) > 1 else -1
        en_cours = self.attente.pop(ident, None)
        if en_cours is None:
            self.resultats["inattendus"] += 1
            return
        envoi, auth_req = en_cours
        self.libres.append(ident)
        try:
            r = radlib._verifier(data, auth_req, SECRET, ident)
        except Exception:
            self.resultats["invalides"] += 1
            return
        self.resultats["latences"].append((time.monotonic() - envoi) * 1000)
        self.resultats[r.nom] = self.resultats.get(r.nom, 0) + 1
        if r.nom == "Access-Reject":   # cause du refus (Reply-Message), pour expliquer un Reject inattendu
            cause = (r.un("Reply-Message") or b"").decode(errors="replace") if isinstance(r.un("Reply-Message"), bytes) \
                else str(r.un("Reply-Message"))
            causes = self.resultats.setdefault("causes_reject", {})
            causes[cause] = causes.get(cause, 0) + 1

    def envoyer(self, code: str, mac: str, interim: tuple[str, int] | None = None) -> bool:
        if not self.libres:
            self.resultats["sans_identifiant"] += 1
            return False
        while True:
            p, auth_req, ident = paquet_interim(code, *interim) if interim else paquet(code, mac)
            if ident in self.libres:
                break
        self.libres.remove(ident)
        self.attente[ident] = (time.monotonic(), auth_req)
        self.transport.sendto(p, SERVEUR_ACCT if interim else SERVEUR)
        return True

    def expirer(self, delai: float):
        maintenant = time.monotonic()
        for ident, (envoi, _) in list(self.attente.items()):
            if maintenant - envoi > delai:
                del self.attente[ident]
                self.libres.append(ident)
                self.resultats["perdus"] += 1


def quantile(valeurs: list[float], q: float) -> float | None:
    if not valeurs:
        return None
    v = sorted(valeurs)
    return round(v[min(len(v) - 1, int(q * len(v)))], 2)


def cibles(routeurs: int) -> tuple[list[str], list[str]]:
    with psycopg.connect(**PG) as c:
        ips = [r[0] for r in c.execute("""SELECT host(r.overlay_ip) FROM app.router r JOIN app.tenant t ON t.id = r.tenant_id
                                          WHERE t.nom = 'Propriétaire de mesure' ORDER BY r.id LIMIT %s""",
                                       (routeurs,)).fetchall()]
        codes = [r[0] for r in c.execute("""SELECT v.code FROM app.voucher v JOIN app.tenant t ON t.id = v.tenant_id
                                            WHERE t.nom = 'Propriétaire de mesure' ORDER BY v.id LIMIT 20000""").fetchall()]
    return ips, codes


async def principal(args) -> dict:
    # Base arrêtée (mode interim) : les cibles ont été exportées avant l'arrêt (--exporter).
    if args.depuis:
        with open(args.depuis) as f:
            ips, codes = json.load(f)
    else:
        ips, codes = cibles(args.routeurs)
    resultats = {"envoyes": 0, "perdus": 0, "inattendus": 0, "invalides": 0, "sans_identifiant": 0, "latences": []}
    boucle = asyncio.get_running_loop()
    routeurs = []
    for ip in ips:
        _, proto = await boucle.create_datagram_endpoint(lambda: Routeur(resultats), local_addr=(ip, 0))
        routeurs.append(proto)
    # Un ticket accepté reste attaché à un routeur et à une MAC (le même appareil revient).
    interims = [(routeurs[i % len(routeurs)], code, f"perf-int-{i}") for i, code in enumerate(codes[:args.sessions])]
    affectation = [(routeurs[i % len(routeurs)], code, "02-CC-" + "-".join(hashlib.md5(code.encode()).hexdigest()[j:j + 2]
                                                                        for j in range(0, 8, 2)).upper())
                   for i, code in enumerate(codes)]
    debut = time.monotonic()
    n = 0
    while (ecoule := time.monotonic() - debut) < args.duree:
        attendu = int(ecoule * args.debit)
        while n < attendu:
            if args.mode == "interim":
                routeur, code, sid = interims[n % len(interims)]
                if routeur.envoyer(code, "", (sid, n // len(interims) + 1)):
                    resultats["envoyes"] += 1
                n += 1
                continue
            if args.mode == "accept":
                routeur, code, mac = affectation[n % len(affectation)]
            else:
                routeur = routeurs[n % len(routeurs)]
                code = "".join(random.choice(ALPHABET) for _ in range(8))
                mac = "02-DD-" + "-".join(f"{random.randrange(256):02X}" for _ in range(4))
            if routeur.envoyer(code, mac):
                resultats["envoyes"] += 1
            n += 1
        for r in routeurs:
            r.expirer(2.0)
        await asyncio.sleep(0.002)
    await asyncio.sleep(2.2)
    for r in routeurs:
        r.expirer(2.0)
        r.transport.close()
    lat = resultats.pop("latences")
    duree = time.monotonic() - debut - 2.2
    return {**resultats, "mode": args.mode, "debit_vise": args.debit, "duree_s": round(duree, 1),
            "routeurs": len(ips), "recus": len(lat), "debit_obtenu": round(len(lat) / duree, 1),
            "latence_ms": {"p50": quantile(lat, 0.50), "p95": quantile(lat, 0.95), "p99": quantile(lat, 0.99),
                           "max": quantile(lat, 1.0)}}


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("--mode", choices=["accept", "reject", "interim"])
    a.add_argument("--sessions", type=int, default=1000)
    a.add_argument("--debit", type=float, default=0)
    a.add_argument("--duree", type=float, default=30)
    a.add_argument("--routeurs", type=int, default=50)
    a.add_argument("--exporter", help="écrit les cibles (IP, codes) dans ce fichier, puis s'arrête")
    a.add_argument("--depuis", help="lit les cibles dans ce fichier au lieu de la base")
    args = a.parse_args()
    if args.exporter:
        with open(args.exporter, "w") as f:
            json.dump(cibles(args.routeurs), f)
        print(json.dumps({"exporte": args.exporter}), flush=True)
    elif args.mode and args.debit > 0:
        print(json.dumps(asyncio.run(principal(args))), flush=True)
    else:
        a.error("--mode et --debit (> 0) sont exigés, sauf avec --exporter")
