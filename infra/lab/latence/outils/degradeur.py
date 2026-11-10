#!/usr/bin/env python3
"""Dégradeur UDP en espace utilisateur, pour le labo de latence WAKATNET.

Remplace `tc netem` là où le noyau n'a pas le module `sch_netem` (c'était le
cas du conteneur cloud où le protocole a été testé). Ce n'est PAS un outil de
mesure : il ne sert qu'à injecter un profil connu pour vérifier que
`analyse.py` le retrouve.

Fonctionnement : relais UDP. Il écoute sur --ecoute, transmet vers --cible.
Chaque adresse cliente a sa propre socket amont (relais « NAT »).

- Délai et gigue : appliqués dans le sens aller (client -> cible) seulement,
  donc le RTT vaut à peu près délai ± gigue. Gigue gaussienne, écart-type
  --gigue-ms, délai jamais négatif. Les paquets peuvent se réordonner, comme
  avec netem.
- Perte : sens aller seulement. Soit indépendante (--perte, en %), soit modèle
  de Gilbert simple (--ge-p, --ge-r, en % : p = passage bon -> mauvais,
  r = retour mauvais -> bon ; tout est perdu en état mauvais ; perte moyenne
  p / (p + r) ; rafale moyenne 1 / r paquets).
- Coupure : --coupure DEBUT:DUREE (secondes depuis le lancement). Tout est
  perdu, dans les deux sens, pendant la fenêtre.

Bibliothèque standard seulement.
"""

import argparse
import asyncio
import random
import signal
import sys
import time


def adresse(texte):
    hote, _, port = texte.rpartition(":")
    return hote, int(port)


class Profil:
    def __init__(self, a):
        self.delai = a.delai_ms / 1000.0
        self.gigue = a.gigue_ms / 1000.0
        self.perte = a.perte / 100.0
        self.ge_p = a.ge_p / 100.0 if a.ge_p is not None else None
        self.ge_r = a.ge_r / 100.0 if a.ge_r is not None else None
        self.etat_mauvais = False
        self.coupures = []
        for c in a.coupure or []:
            d, _, l = c.partition(":")
            self.coupures.append((float(d), float(d) + float(l)))
        self.t0 = time.monotonic()
        self.rng = random.Random(a.graine)
        self.compteurs = {"aller": 0, "perdus_aller": 0, "coupes": 0}

    def coupe(self):
        t = time.monotonic() - self.t0
        return any(d <= t < f for d, f in self.coupures)

    def perdu_aller(self):
        if self.ge_p is not None:
            if self.etat_mauvais:
                if self.rng.random() < self.ge_r:
                    self.etat_mauvais = False
            else:
                if self.rng.random() < self.ge_p:
                    self.etat_mauvais = True
            return self.etat_mauvais
        return self.rng.random() < self.perte

    def delai_aller(self):
        if self.gigue <= 0:
            return self.delai
        return max(0.0, self.rng.gauss(self.delai, self.gigue))


class Amont(asyncio.DatagramProtocol):
    """Socket vers la cible pour un client donné ; renvoie les réponses."""

    def __init__(self, relais, client):
        self.relais = relais
        self.client = client
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, _addr):
        if self.relais.profil.coupe():
            self.relais.profil.compteurs["coupes"] += 1
            return
        self.relais.transport.sendto(data, self.client)


class Relais(asyncio.DatagramProtocol):
    def __init__(self, cible, profil):
        self.cible = cible
        self.profil = profil
        self.amonts = {}
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, client):
        p = self.profil
        p.compteurs["aller"] += 1
        if p.coupe():
            p.compteurs["coupes"] += 1
            return
        if p.perdu_aller():
            p.compteurs["perdus_aller"] += 1
            return
        loop = asyncio.get_running_loop()
        loop.call_later(p.delai_aller(), self._envoyer, data, client)

    def _envoyer(self, data, client):
        amont = self.amonts.get(client)
        if amont is None or amont.transport is None:
            asyncio.ensure_future(self._ouvrir_et_envoyer(data, client))
            return
        amont.transport.sendto(data)

    async def _ouvrir_et_envoyer(self, data, client):
        if client not in self.amonts:
            loop = asyncio.get_running_loop()
            amont = Amont(self, client)
            self.amonts[client] = amont
            await loop.create_datagram_endpoint(lambda: amont, remote_addr=self.cible)
        amont = self.amonts[client]
        if amont.transport is not None:
            amont.transport.sendto(data)


async def principal(a):
    profil = Profil(a)
    loop = asyncio.get_running_loop()
    await loop.create_datagram_endpoint(
        lambda: Relais(adresse(a.cible), profil), local_addr=adresse(a.ecoute)
    )
    print(
        f"degradeur {a.ecoute} -> {a.cible} delai={a.delai_ms}ms gigue={a.gigue_ms}ms "
        f"perte={a.perte}% ge_p={a.ge_p} ge_r={a.ge_r} coupures={a.coupure}",
        flush=True,
    )
    fin = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, fin.set)
    try:
        if a.duree:
            await asyncio.wait_for(fin.wait(), timeout=a.duree)
        else:
            await fin.wait()
    except asyncio.TimeoutError:
        pass
    finally:
        print(f"degradeur fin {profil.compteurs}", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--ecoute", required=True, help="ADRESSE:PORT d'écoute")
    ap.add_argument("--cible", required=True, help="ADRESSE:PORT de destination")
    ap.add_argument("--delai-ms", type=float, default=0.0)
    ap.add_argument("--gigue-ms", type=float, default=0.0)
    ap.add_argument("--perte", type=float, default=0.0, help="perte indépendante, en %%")
    ap.add_argument("--ge-p", type=float, default=None, help="Gilbert : bon->mauvais, en %%")
    ap.add_argument("--ge-r", type=float, default=None, help="Gilbert : mauvais->bon, en %%")
    ap.add_argument("--coupure", action="append", help="DEBUT:DUREE en secondes (répétable)")
    ap.add_argument("--duree", type=float, default=0.0, help="arrêt après N s (0 = jamais)")
    ap.add_argument("--graine", type=int, default=None, help="graine aléatoire (rejeu)")
    a = ap.parse_args()
    if (a.ge_p is None) != (a.ge_r is None):
        ap.error("--ge-p et --ge-r vont ensemble")
    try:
        asyncio.run(principal(a))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
