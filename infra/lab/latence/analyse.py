#!/usr/bin/env python3
"""analyse.py — indicateurs de latence WAKATNET à partir des captures irtt.

Lit les fichiers JSON d'irtt (`.json` ou `.json.gz`, format `json_format: 1`
d'irtt 0.9.0, vérifié en exécutant irtt) produits par `sonde.sh`, les journaux
`*.sonde.log`, les journaux du routeur reçus par syslog (`*.routeros.log`,
écrits par `outils/recepteur-syslog.py`) et les journaux du flux clairsemé
(`*.rare.log`, écrits par `rare.sh`). Écrit un tableau Markdown et des CSV.

Nommage attendu (celui des outils du dossier) :
    AAAA-MM-JJ-<site>-<acces>-<cible>.THHMMSSZ.json[.gz]   tranche irtt
    AAAA-MM-JJ-<site>-<acces>.sonde.log                    journal de sonde.sh
    AAAA-MM-JJ-<site>-<acces>.routeros.log                 journal du routeur (syslog)
    AAAA-MM-JJ-<site>-<acces>-<nom>.rare.log               flux clairsemé (rare.sh)
site et acces en [a-z0-9], cible et nom en [a-z0-9-]. Le *groupe* d'une cible
est ce qui précède le premier « - » (fsn-wg -> fsn) ; le *transport* est le
reste (wg, udp). Les groupes de --groupes-hetzner sont les candidats Hetzner ;
tous les autres groupes sont des *témoins* qui servent à reconnaître une panne
locale (voir PROTOCOLE §6.2).

Usage :
    analyse.py [options] FICHIER_OU_DOSSIER... --sortie PREFIXE
Produit PREFIXE.md, .csv, -heures.csv, -correlation.csv, -soirees.csv,
-appariement.csv, -rare.csv.

Bibliothèque standard seulement. Les heures sont en UTC (= heure du Burkina).
"""

import argparse
import bisect
import csv
import gzip
import json
import math
import os
import random
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone

NOM = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2})-(?P<site>[a-z0-9]+)-(?P<acces>[a-z0-9]+)-"
    r"(?P<cible>[a-z0-9-]+?)\.T(?P<heure>\d{6})Z\.json(?:\.gz)?$"
)
NOM_LOG = re.compile(r"^(?P<date>\d{4}-\d{2}-\d{2})-(?P<site>[a-z0-9]+)-(?P<acces>[a-z0-9]+)\.(?P<type>sonde|routeros)\.log$")
NOM_RARE = re.compile(r"^(?P<date>\d{4}-\d{2}-\d{2})-(?P<site>[a-z0-9]+)-(?P<acces>[a-z0-9]+)-(?P<nom>[a-z0-9-]+?)\.rare\.log$")
NS = 1_000_000_000
TROU_MAX_NS = 15 * NS   # au-delà, deux paquets successifs ne sont plus « contigus »
INF = float("inf")
QUANTILES = (0.50, 0.95, 0.99, 0.999)


def n_min(q):
    """Nombre de valeurs pour qu'un centile q laisse au moins 10 valeurs dans la queue."""
    return math.ceil(10 / (1 - q) - 1e-9)


class Paquet:
    __slots__ = ("t", "rtt", "perdu", "virtuel", "sens")

    def __init__(self, t, rtt, perdu, virtuel=False, sens=""):
        self.t = t              # envoi, ns epoch (voir lire_irtt pour l'horloge)
        self.rtt = rtt          # ns, ou None si perdu
        self.perdu = perdu
        self.virtuel = virtuel  # perte déduite d'un échec d'ouverture (journal)
        self.sens = sens        # "up", "down", "" (perte sans direction connue)


def ouvrir(chemin):
    if chemin.endswith(".gz"):
        return gzip.open(chemin, "rt", encoding="utf-8")
    return open(chemin, encoding="utf-8")


def lister(entrees):
    fichiers = []
    for e in entrees:
        if os.path.isdir(e):
            for racine, _, noms in os.walk(e):
                if os.path.basename(racine) == "en-cours":
                    continue
                fichiers += [os.path.join(racine, n) for n in noms]
        else:
            fichiers.append(e)
    return sorted(fichiers)


def date_iso_ns(texte):
    """ISO 8601 UTC -> ns epoch, y compris avec 9 décimales (irtt) et sous Python < 3.11."""
    m = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$", texte.strip())
    if not m:
        raise ValueError(f"date illisible : {texte}")
    base = datetime.fromisoformat(m[1] + (m[3] or "Z").replace("Z", "+00:00"))
    frac = (m[2] or "0")[:9].ljust(9, "0")
    return int(base.timestamp()) * NS + int(frac)


def centile(valeurs_triees, q):
    """Rang le plus proche : la plus petite valeur dont le rang est >= q·n."""
    if not valeurs_triees:
        return None
    k = max(0, math.ceil(q * len(valeurs_triees)) - 1)
    return valeurs_triees[k]


def lire_irtt(chemin, interrompue):
    """Lit une tranche irtt.

    Horloge : l'instant d'envoi est l'horloge murale du PREMIER paquet de la
    tranche, plus l'écart d'horloge monotone d'irtt (send.monotonic). Un pas de
    NTP en pleine tranche ne déforme donc ni les rafales ni l'émulation ; il est
    signalé (saut_horloge) si l'horloge murale s'écarte de plus de 1 s.

    Fin anticipée (durée réelle < durée demandée - 1 s) : irtt n'a pas attendu
    les réponses des derniers paquets. On retire les pertes de queue envoyées
    dans la dernière fenêtre min(2 s ; 2 x p99 du RTT de la tranche) — 2 s si
    aucun RTT. La cause est notée : « sigterm » (journal : interrompue=oui),
    « erreur_envoi » (champ send_err d'irtt, par exemple interface tombée) ou
    « inexpliquee ». Les pertes plus anciennes sont gardées.
    """
    with ouvrir(chemin) as f:
        d = json.load(f)
    if d.get("version", {}).get("json_format") != 1:
        raise ValueError(f"{chemin} : json_format inattendu {d.get('version')}")
    params = d["config"]["params"]
    intervalle = int(params["interval"])
    debut_ns = date_iso_ns(d["stats"]["start_time"])
    paquets = []
    w0 = m0 = None
    saut = False
    for rt in d.get("round_trips") or []:
        envoi = rt.get("timestamps", {}).get("client", {}).get("send", {})
        w, m = envoi.get("wall"), envoi.get("monotonic")
        if w is not None and m is not None:
            if w0 is None:
                w0, m0 = int(w), int(m)
            t = w0 + int(m) - m0
            if abs(int(w) - t) > NS:
                saut = True
        elif w is not None:
            t = int(w)
        else:
            t = debut_ns + int(rt["seqno"]) * intervalle
        perdu = rt["lost"]
        if perdu == "false":
            paquets.append(Paquet(t, int(rt["delay"]["rtt"]), False))
        else:
            sens = {"true_up": "up", "true_down": "down"}.get(perdu, "")
            paquets.append(Paquet(t, None, True, sens=sens))
    retires, cause = 0, ""
    duree_demandee = int(params.get("duration") or 0)
    duree_reelle = int(d["stats"].get("duration") or 0)
    if paquets and duree_demandee and duree_reelle < duree_demandee - NS:
        cause = "sigterm" if interrompue else ("erreur_envoi" if d.get("send_err") else "inexpliquee")
        p99 = centile(sorted(p.rtt for p in paquets if not p.perdu), 0.99)
        fenetre = min(2 * NS, 2 * p99) if p99 else 2 * NS
        fin = max(paquets[-1].t, (w0 if w0 is not None else debut_ns) + duree_reelle)
        while paquets and paquets[-1].perdu and paquets[-1].t >= fin - fenetre:
            paquets.pop()
            retires += 1
    return {"intervalle": intervalle, "paquets": paquets, "retires": retires, "cause": cause,
            "saut": saut, "send_err": str(d.get("send_err") or "")}


def kv_de(champs):
    return dict(c.split("=", 1) for c in champs if "=" in c)


def lire_journal(chemin):
    """Journal de sonde.sh : échecs d'ouverture, tranches interrompues, événements."""
    echecs, evenements, interrompues = [], defaultdict(int), set()
    with open(chemin, encoding="utf-8") as f:
        for ligne in f:
            champs = ligne.split()
            if len(champs) < 3:
                continue
            ev = champs[2]
            kv = kv_de(champs[3:])
            evenements[ev] += 1
            if ev == "echec_ouverture":
                echecs.append((kv.get("cible"), int(kv["debut"]) * NS, int(kv["fin"]) * NS))
            if ev == "tranche_ok" and kv.get("interrompue") == "oui" and "fichier" in kv:
                interrompues.add(kv["fichier"])
            if ev == "tranche_ok" and kv.get("send_err") == "oui":
                evenements["tranche_arretee_sur_erreur_envoi"] += 1
            if ev == "demarrage":
                try:
                    if float(kv.get("uptime_s", "1e9")) < 300:
                        evenements["demarrage_apres_redemarrage_machine"] += 1
                except ValueError:
                    pass
                if kv.get("ntp_synchronise") not in ("yes", None):
                    evenements[f"demarrage_ntp_{kv.get('ntp_synchronise')}"] += 1
    return echecs, evenements, interrompues


def lire_routeros(chemin):
    """Journal du routeur reçu par recepteur-syslog.py : compteurs WAN, redémarrages."""
    wan, evenements = [], defaultdict(int)
    with open(chemin, encoding="utf-8", errors="replace") as f:
        for ligne in f:
            champs = ligne.split()
            kv = kv_de(champs)
            if "epoch" not in kv:
                continue
            if "wakatnet-labo wan " in ligne and "rx=" in ligne and "tx=" in ligne:
                try:
                    wan.append((int(kv["epoch"]), int(kv["rx"]), int(kv["tx"])))
                except ValueError:
                    evenements["ligne_wan_illisible"] += 1
            elif "wakatnet-labo demarrage" in ligne:
                evenements["routeur_demarrage"] += 1
    return sorted(wan), evenements


def lire_rare(chemin):
    """Flux clairsemé (rare.sh) : (epoch_ns, rtt_ns ou None)."""
    mesures = []
    with open(chemin, encoding="utf-8") as f:
        for ligne in f:
            kv = kv_de(ligne.split())
            if "epoch_ms" not in kv or ("rtt_ms" not in kv and kv.get("perdu") != "oui"):
                continue
            t = int(kv["epoch_ms"]) * 1_000_000
            mesures.append((t, None if kv.get("perdu") == "oui" else int(float(kv["rtt_ms"]) * 1e6)))
    return mesures


def ms(ns):
    if ns is None:
        return None
    return INF if ns == INF else ns / 1e6


def fmt(x, nd=1):
    if x is None:
        return "—"
    if x == INF:
        return "perdu"
    return f"{x:.{nd}f}"


def jour(t_ns):
    return datetime.fromtimestamp(t_ns / NS, tz=timezone.utc).strftime("%Y-%m-%d")


def dans_plage(h, plage):
    a, b = plage
    return a <= h < b if a < b else (h >= a or h < b)


def segments(paquets):
    """Numéro de segment contigu : nouveau segment après plus de 15 s sans paquet."""
    seg, s, prec = [], 0, None
    for p in paquets:
        if prec is not None and p.t - prec > TROU_MAX_NS:
            s += 1
        seg.append(s)
        prec = p.t
    return seg


def filtrer(paquets, seg, garder):
    """Garde les paquets pour lesquels garder(p) est vrai ; coupe un segment là où on a retiré."""
    out, oseg, s, prec_i, prec_seg = [], [], -1, None, None
    for i, p in enumerate(paquets):
        if not garder(p):
            continue
        if prec_i is None or i != prec_i + 1 or seg[i] != prec_seg:
            s += 1
        out.append(p)
        oseg.append(s)
        prec_i, prec_seg = i, seg[i]
    return out, oseg


def rafales(paquets, seg, intervalle):
    """Rafales de pertes consécutives (réelles ou virtuelles) dans un même segment.

    Renvoie des tuples (i_debut, i_fin, nb_paquets, duree_perte_ns, duree_silence_ns, t_debut).
    - duree_perte = nb_paquets x intervalle : temps couvert par des pertes MESURÉES
      (ou par une indisponibilité d'ouverture journalisée) ;
    - duree_silence = du dernier paquet reçu avant la rafale au premier reçu après,
      moins un intervalle : elle ajoute les silences de la sonde (trou entre deux
      tranches, attente d'ouverture), pendant lesquels on ne sait rien du réseau.
    """
    res, i, n = [], 0, len(paquets)
    while i < n:
        if not paquets[i].perdu:
            i += 1
            continue
        j = i
        while j + 1 < n and paquets[j + 1].perdu and seg[j + 1] == seg[i]:
            j += 1
        nb = j - i + 1
        t0 = paquets[i - 1].t if i > 0 and seg[i - 1] == seg[i] else paquets[i].t - intervalle
        t1 = paquets[j + 1].t if j + 1 < n and seg[j + 1] == seg[i] else paquets[j].t + intervalle
        res.append((i, j, nb, nb * intervalle, max(intervalle, t1 - t0 - intervalle), paquets[i].t))
        i = j + 1
    return res


def indicateurs(paquets, seg, intervalle):
    reels = [p for p in paquets if not p.virtuel]
    rtts = sorted(p.rtt for p in reels if not p.perdu)
    effectifs = rtts + [INF] * (len(reels) - len(rtts))   # une perte = délai infini
    n, perdus = len(reels), len(reels) - len(rtts)
    gigue, nb_g, prec, prec_seg = 0, 0, None, None
    for p, s in zip(paquets, seg):
        if p.perdu:
            prec = None
            continue
        if prec is not None and s == prec_seg and p.t - prec.t <= 2 * intervalle:
            gigue += abs(p.rtt - prec.rtt)
            nb_g += 1
        prec, prec_seg = p, s
    rf = rafales(paquets, seg, intervalle)
    plus_longue = max(rf, key=lambda r: (r[3], r[4]), default=None)
    # Profil de Gilbert (LABO-16), hors rafales de plus de 10 s : une coupure
    # longue n'est pas une « perte en rafale » à rejouer, elle est donnée à part.
    longues = [r for r in rf if r[3] > 10 * NS]
    dans_longue = bytearray(len(paquets))
    for r in longues:
        for k in range(r[0], r[1] + 1):
            dans_longue[k] = 1
    bb = bm = mb = mm = 0
    for k in range(len(paquets) - 1):
        a, b = paquets[k], paquets[k + 1]
        if a.virtuel or b.virtuel or dans_longue[k] or dans_longue[k + 1]:
            continue
        if seg[k] != seg[k + 1] or b.t - a.t > 2 * intervalle:
            continue
        if not a.perdu:
            if b.perdu:
                bm += 1
            else:
                bb += 1
        else:
            if b.perdu:
                mm += 1
            else:
                mb += 1
    ind = {
        "envoyes": n,
        "recus": len(rtts),
        "perte_pct": 100.0 * perdus / n if n else None,
        "perte_montante": sum(1 for p in reels if p.sens == "up"),
        "perte_descendante": sum(1 for p in reels if p.sens == "down"),
        "virtuels": len(paquets) - n,
        "min": ms(rtts[0]) if rtts else None,
        "max": ms(rtts[-1]) if rtts else None,
        "gigue": ms(gigue / nb_g) if nb_g else None,
        "rafale_max_paquets": plus_longue[2] if plus_longue else 0,
        "rafale_max_s": plus_longue[3] / NS if plus_longue else 0.0,
        "rafale_max_silence_s": plus_longue[4] / NS if plus_longue else 0.0,
        "rafale_max_debut": plus_longue[5] if plus_longue else None,
        "silence_max_s": max((r[4] for r in rf), default=0) / NS,
        "rafales_1s": sum(1 for r in rf if r[3] >= 1 * NS),
        "rafales_3s": sum(1 for r in rf if r[3] >= 3 * NS),
        "rafales_10s": sum(1 for r in rf if r[3] >= 10 * NS),
        "coupures_longues": [(r[5], r[3] / NS) for r in longues],
        "ge_p_pct": 100.0 * bm / (bb + bm) if bb + bm else None,
        "ge_r_pct": 100.0 * mb / (mb + mm) if mb + mm else None,
    }
    for q in QUANTILES:
        cle = f"p{q * 100:g}".replace(".", "")
        ind[cle] = ms(centile(rtts, q))
        ind[cle + "e"] = ms(centile(effectifs, q))
        ind[cle + "_fiable"] = len(rtts) >= n_min(q)
        ind[cle + "e_fiable"] = len(reels) >= n_min(q)
    return ind


# Seaux d'agrégation de l'émulation : 0 = tout, 1 = pic, 2 = creuses, 3+ = soirées (pic).
def heure(t_ns):
    return (t_ns // NS // 3600) % 24


def soiree(t_ns, pic):
    """Date de la soirée de pic à laquelle appartient l'instant (pic à cheval sur minuit compris)."""
    return jour(t_ns - pic[0] * 3600 * NS)


def seaux_instants(paquets, pic, creuses, id_soiree):
    res = []
    for p in paquets:
        h = heure(p.t)
        if dans_plage(h, pic):
            res.append((0, 1, id_soiree[soiree(p.t, pic)]))
        elif dans_plage(h, creuses):
            res.append((0, 2))
        else:
            res.append((0,))
    return res


def emuler(paquets, seg, intervalle, timeout_s, essais, ts_ns, seaux, nb_seaux):
    """Requête RADIUS émulée à chaque paquet : K essais vers A, chacun attend T.

    Variante stricte : un essai échoue si son paquet est perdu ou si RTT + temps
    serveur > T ; la requête expire sur A si les K essais échouent.
    Variante « réponse tardive acceptée » (dépend de LABO-16) : la requête réussit
    s'il existe un essai j avec j·T + RTT_j + S <= K·T.
    Renvoie, par seau : [instants évalués, échecs stricts, échecs tardifs,
    épisodes stricts, épisodes tardifs].
    Seuls les instants dont le premier essai échoue sont examinés en détail :
    tous les autres réussissent d'emblée, dans les deux variantes.
    """
    T = int(timeout_s * NS)
    KT = essais * T
    n = len(paquets)
    temps = [p.t for p in paquets]
    echec0 = [p.perdu or p.rtt + ts_ns > T for p in paquets]
    pas = max(1, round(T / intervalle))
    tol = 2 * intervalle
    acc = [[0, 0, 0, 0, 0] for _ in range(nb_seaux)]
    for sx in seaux:
        for b in sx:
            acc[b][0] += 1
    es_set, et_set = set(), set()
    for i in (i for i in range(n) if echec0[i]):
        ti, si = temps[i], seg[i]
        p0 = paquets[i]
        ok_s = False
        ok_t = essais > 1 and not p0.perdu and p0.rtt + ts_ns <= KT
        evaluable = True
        for j in range(1, essais):
            cible = ti + j * T
            k = i + j * pas
            if k >= n or seg[k] != si or abs(temps[k] - cible) > tol:
                k = bisect.bisect_left(temps, cible)
                if k >= n or seg[k] != si or temps[k] - cible > tol:
                    evaluable = False
                    break
            pk = paquets[k]
            if not pk.perdu:
                r = pk.rtt + ts_ns
                if r <= T:
                    ok_s = ok_t = True
                    break
                if j * T + r <= KT:
                    ok_t = True
        if not evaluable:
            for b in seaux[i]:
                acc[b][0] -= 1
            continue
        if not ok_s:
            es_set.add(i)
        if not ok_t:
            et_set.add(i)
    for ens, col in ((es_set, 1), (et_set, 2)):
        for i in ens:
            debut = not (i - 1 in ens and seg[i - 1] == seg[i])
            for b in seaux[i]:
                acc[b][col] += 1
                if debut:
                    acc[b][col + 2] += 1
    return acc


def partitionner(paquets, seg, clef):
    """Comme filtrer(), mais en une passe pour toutes les valeurs de clef(p) (None = écarté)."""
    res = {}
    prec = {}
    for i, p in enumerate(paquets):
        c = clef(p)
        if c is None:
            continue
        if c not in res:
            res[c] = ([], [], [-1])
        out, oseg, s = res[c]
        pi = prec.get(c)
        if pi is None or i != pi + 1 or seg[i] != seg[pi]:
            s[0] += 1
        out.append(p)
        oseg.append(s[0])
        prec[c] = i
    return {c: (v[0], v[1]) for c, v in res.items()}


def secondes_en_panne(paquets):
    envoyes, ok = set(), set()
    for p in paquets:
        s = p.t // NS
        envoyes.add(s)
        if not p.perdu:
            ok.add(s)
    return envoyes, envoyes - ok


def episodes(secondes, duree_min_s):
    """Suites de secondes consécutives d'un ensemble, de durée >= duree_min_s."""
    res, debut, prec = [], None, None
    for s in sorted(secondes):
        if prec is None or s != prec + 1:
            if debut is not None and prec - debut + 1 >= duree_min_s:
                res.append((debut, prec))
            debut = s
        prec = s
    if debut is not None and prec - debut + 1 >= duree_min_s:
        res.append((debut, prec))
    return res


def groupe(cible):
    return cible.split("-", 1)[0]


def transport(cible):
    base = cible.split("@", 1)[0]
    return base.split("-", 1)[1] if "-" in base else ""


def bootstrap(blocs, nb, graine=12345):
    """IC à 90 % par bootstrap en blocs (un bloc = une heure de pic d'une soirée).

    blocs : liste de (effectifs, reçus). Renvoie {"p95e": (bas, haut), "p999": (bas, haut)}.
    """
    if nb <= 0 or len(blocs) < 4:
        return None
    rng = random.Random(graine)
    p95e, p999 = [], []
    for _ in range(nb):
        tirage = [blocs[rng.randrange(len(blocs))] for _ in blocs]
        e = sorted(v for b in tirage for v in b[0])
        r = sorted(v for b in tirage for v in b[1])
        p95e.append(centile(e, 0.95))
        if r:
            p999.append(centile(r, 0.999))
    p95e.sort()
    p999.sort()
    borne = lambda L: (ms(centile(L, 0.05)), ms(centile(L, 0.95))) if L else None
    return {"p95e": borne(p95e), "p999": borne(p999)}


def main():
    ap = argparse.ArgumentParser(description="Indicateurs de latence WAKATNET (captures irtt)")
    ap.add_argument("entrees", nargs="+", help="fichiers ou dossiers")
    ap.add_argument("--sortie", required=True, help="préfixe des fichiers produits")
    ap.add_argument("--timeouts", default="0.5,1,1.1,1.5,2,2.3,3,5", help="secondes, séparées par des virgules")
    ap.add_argument("--essais", default="1,2,3", help="nombres d'essais vers A avant bascule")
    ap.add_argument("--temps-serveur-ms", type=float, default=50.0,
                    help="temps de traitement serveur ajouté au RTT (défaut 50 = objectif p95 §5.6)")
    ap.add_argument("--pic", default="19-23", help="heures du pic du soir, UTC, début-fin exclue")
    ap.add_argument("--creuses", default="2-6", help="heures creuses, UTC, début-fin exclue")
    ap.add_argument("--groupes-hetzner", default="fsn,nbg,hel",
                    help="groupes de cibles candidats chez Hetzner ; tout autre groupe est un témoin de panne locale")
    ap.add_argument("--auth-par-jour", type=float, default=300.0,
                    help="HYPOTHÈSE : authentifications par jour et par routeur (fausses bascules attendues)")
    ap.add_argument("--episode-min-s", type=int, default=2,
                    help="durée minimale d'un épisode de panne de X pour P(Y|X) en épisodes (défaut 2 s = K·T pour K=2, T=1 s)")
    ap.add_argument("--episodes-min", type=int, default=10,
                    help="sous ce nombre d'épisodes de X hors panne locale, P(Y|X) est « indéterminé »")
    ap.add_argument("--bootstrap", type=int, default=200, help="tirages du bootstrap en blocs horaires (0 = aucun)")
    ap.add_argument("--sans-heures", action="store_true", help="ne pas détailler heure par heure dans le .md")
    ap.add_argument("--exclure", action="append", default=[],
                    help="fenêtre à exclure, DEBUT/FIN en UTC ISO (ex. 2026-11-12T19:05:00Z/2026-11-12T20:40:00Z) ; "
                         "répétable ; pour une coupure de courant notée sur la fiche du site")
    a = ap.parse_args()

    timeouts = [float(x) for x in a.timeouts.split(",")]
    essais = [int(x) for x in a.essais.split(",")]
    pic = tuple(int(x) for x in a.pic.split("-"))
    creuses = tuple(int(x) for x in a.creuses.split("-"))
    hetzner = set(x for x in a.groupes_hetzner.split(",") if x)
    ts_ns = int(a.temps_serveur_ms * 1e6)

    fichiers = lister(a.entrees)
    # 1er passage : journaux (il faut savoir quelles tranches sont interrompues).
    echecs_journal, evenements = [], defaultdict(lambda: defaultdict(int))
    interrompues, wan = set(), defaultdict(list)
    rares = defaultdict(list)
    for chemin in fichiers:
        base = os.path.basename(chemin)
        m = NOM_LOG.match(base)
        if m and m["type"] == "sonde":
            ech, ev, intr = lire_journal(chemin)
            for cible, d, f in ech:
                echecs_journal.append(((m["site"], m["acces"], cible), d, f))
            for k, v in ev.items():
                evenements[(m["site"], m["acces"])][k] += v
            interrompues |= intr
        elif m and m["type"] == "routeros":
            w, ev = lire_routeros(chemin)
            wan[(m["site"], m["acces"])] += w
            for k, v in ev.items():
                evenements[(m["site"], m["acces"])][k] += v
        m = NOM_RARE.match(base)
        if m:
            rares[(m["site"], m["acces"], m["nom"])] += lire_rare(chemin)

    # 2e passage : captures irtt, regroupées par (site, accès, cible, intervalle).
    brutes = defaultdict(list)
    qualite = defaultdict(lambda: defaultdict(int))
    debuts_tranches = defaultdict(list)
    ignores = []
    for chemin in fichiers:
        base = os.path.basename(chemin)
        m = NOM.match(base)
        if not m:
            if base.endswith((".json", ".json.gz")):
                ignores.append(f"{base} (nom non conforme)")
            continue
        try:
            tr = lire_irtt(chemin, base in interrompues)
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as e:
            ignores.append(f"{base} ({e.__class__.__name__})")
            continue
        cle = (m["site"], m["acces"], m["cible"], tr["intervalle"])
        brutes[cle] += tr["paquets"]
        q = qualite[cle]
        q["fichiers"] += 1
        if tr["paquets"]:
            debuts_tranches[cle].append(tr["paquets"][0].t)
        if tr["cause"]:
            q[f"fin_{tr['cause']}"] += 1
            q["en_vol_retires"] += tr["retires"]
        if tr["saut"]:
            q["sauts_horloge"] += 1
        queue = 0
        for p in reversed(tr["paquets"]):
            if not p.perdu:
                break
            queue += 1
        if tr["paquets"] and queue * tr["intervalle"] >= 30 * NS:
            q["fins_de_tranche_perdues"] += 1

    if not brutes:
        print("aucune capture irtt reconnue", file=sys.stderr)
        return 1

    # Intervalles mélangés pour une même cible : une série par intervalle (cible@500ms).
    ivs_par_cible = defaultdict(set)
    for (s, ac, c, iv) in brutes:
        ivs_par_cible[(s, ac, c)].add(iv)
    series, intervalles, qual, etiquette = {}, {}, {}, {}
    for (s, ac, c, iv), paquets in brutes.items():
        nom = c if len(ivs_par_cible[(s, ac, c)]) == 1 else f"{c}@{iv / 1e6:g}ms"
        cle = (s, ac, nom)
        series[cle], intervalles[cle], qual[cle] = paquets, iv, qualite[(s, ac, c, iv)]
        etiquette[(s, ac, c, iv)] = cle

    # Pertes virtuelles : fenêtres où la sonde n'a pas pu ouvrir de session. Elles
    # vont à la série dont la tranche suivante commence le plus tôt après la fenêtre.
    for (s, ac, c), d, f in echecs_journal:
        candidats = [(s, ac, c, iv) for iv in ivs_par_cible.get((s, ac, c), ())]
        if not candidats:
            continue
        apres = lambda k: min((t for t in debuts_tranches[k] if t >= d), default=INF)
        k = min(candidats, key=apres)
        cle, iv = etiquette[k], k[3]
        t = d
        while t < f:
            series[cle].append(Paquet(t, None, True, virtuel=True))
            t += iv

    fenetres = []
    for e in a.exclure:
        d_txt, _, f_txt = e.partition("/")
        fenetres.append((date_iso_ns(d_txt), date_iso_ns(f_txt)))
    exclus = defaultdict(int)
    segs = {}
    for cle in list(series):
        paquets = sorted(series[cle], key=lambda p: p.t)
        seg = segments(paquets)
        if fenetres:
            avant = len(paquets)
            paquets, seg = filtrer(paquets, seg, lambda p: not any(d <= p.t < f for d, f in fenetres))
            exclus[cle] = avant - len(paquets)
        if not paquets:
            del series[cle]
            continue
        series[cle], segs[cle] = paquets, seg

    # Panne locale, par source : seconde où au moins un TÉMOIN (cible hors Hetzner)
    # a des paquets et où TOUTES les cibles qui ont des paquets sont muettes.
    par_source = defaultdict(list)
    for (site, acces, cible) in series:
        par_source[(site, acces)].append(cible)
    sec = {cle: secondes_en_panne(series[cle]) for cle in series}
    locale, non_classables, temoins = {}, {}, {}
    for src, cibles in par_source.items():
        tem = [c for c in cibles if groupe(c) not in hetzner]
        temoins[src] = tem
        if not tem:
            locale[src] = None
            non_classables[src] = set()
            continue
        envoyes_tem = set().union(*(sec[src + (c,)][0] for c in tem))
        loc = set()
        for s_ in set().union(*(sec[src + (c,)][1] for c in tem)):
            avec = [c for c in cibles if s_ in sec[src + (c,)][0]]
            if all(s_ in sec[src + (c,)][1] for c in avec):
                loc.add(s_)
        locale[src] = loc
        toutes_pannes = set().union(*(sec[src + (c,)][1] for c in cibles))
        non_classables[src] = {s_ for s_ in toutes_pannes if s_ not in envoyes_tem}

    # Séries hors panne locale.
    hl = {}
    for cle in series:
        loc = locale[cle[:2]]
        if loc:
            hl[cle] = filtrer(series[cle], segs[cle], lambda p: p.t // NS not in loc)
        else:
            hl[cle] = (series[cle], segs[cle])   # même objet : l'émulation brute n'est pas refaite

    resultats = {}
    for cle in sorted(series):
        paquets, seg = series[cle], segs[cle]
        iv = intervalles[cle]
        ind = indicateurs(paquets, seg, iv)
        pq_hl, seg_hl = hl[cle]
        ind_hl = indicateurs(pq_hl, seg_hl, iv) if pq_hl else None
        q = qual[cle]
        ind.update({
            "intervalle_ms": iv / 1e6, "fichiers": q["fichiers"], "exclus": exclus[cle],
            "fins_de_tranche_perdues": q["fins_de_tranche_perdues"], "sauts_horloge": q["sauts_horloge"],
            "fin_sigterm": q["fin_sigterm"], "fin_erreur_envoi": q["fin_erreur_envoi"],
            "fin_inexpliquee": q["fin_inexpliquee"], "en_vol_retires": q["en_vol_retires"],
            "locale": "indéterminée (aucun témoin)" if locale[cle[:2]] is None else "témoin : " + ", ".join(temoins[cle[:2]]),
            "locale_s": len(locale[cle[:2]] or ()), "hl_retires": len(paquets) - len(pq_hl),
        })
        t0, t1 = paquets[0].t, paquets[-1].t + iv
        ind["debut"] = datetime.fromtimestamp(t0 / NS, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        ind["fin"] = datetime.fromtimestamp(t1 / NS, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        ind["duree_h"] = (t1 - t0) / NS / 3600
        ind["jours"] = (t1 - t0) / NS / 86400
        ind["couverture_pct"] = 100.0 * ind["envoyes"] * iv / (t1 - t0) if t1 > t0 else None

        # Émulation du timeout : brut (tout) et hors panne locale (tout, pic, creuses, soirées).
        jours_soiree = {}
        for p in pq_hl:
            if dans_plage(heure(p.t), pic):
                jours_soiree.setdefault(soiree(p.t, pic), None)
        dates = sorted(jours_soiree)
        id_soiree = {dte: 3 + i for i, dte in enumerate(dates)}
        seaux_b = [(0,)] * len(paquets)
        seaux_h = seaux_instants(pq_hl, pic, creuses, id_soiree)
        meme = pq_hl is paquets
        ind["timeouts"], ind["timeouts_brut"], ind["timeouts_soirees"] = {}, {}, {}
        ind["timeouts_pic"], ind["timeouts_creuses"] = {}, {}
        vide = [[0] * 5 for _ in range(3 + len(dates))]
        for k in essais:
            for T in timeouts:
                h = emuler(pq_hl, seg_hl, iv, T, k, ts_ns, seaux_h, 3 + len(dates)) if pq_hl else vide
                b = h[0] if meme else emuler(paquets, seg, iv, T, k, ts_ns, seaux_b, 1)[0]
                ind["timeouts_brut"][(k, T)] = b
                ind["timeouts"][(k, T)] = h[0]
                ind["timeouts_pic"][(k, T)] = h[1]
                ind["timeouts_creuses"][(k, T)] = h[2]
                for dte, i_s in id_soiree.items():
                    ind["timeouts_soirees"][(dte, k, T)] = h[i_s]

        # Périodes, soirées, heures : sur la série hors panne locale.
        def periode(p):
            h = heure(p.t)
            return "pic" if dans_plage(h, pic) else ("creuses" if dans_plage(h, creuses) else None)
        parts = partitionner(pq_hl, seg_hl, periode)
        ind["periodes"] = {nom_p: indicateurs(*parts[nom_p], iv) if nom_p in parts else None
                           for nom_p in ("creuses", "pic")}
        parts = partitionner(pq_hl, seg_hl, lambda p: soiree(p.t, pic) if dans_plage(heure(p.t), pic) else None)
        ind["soirees"] = {dte: indicateurs(*parts[dte], iv) for dte in dates}
        blocs = []
        ind["blocs_pic"] = {}
        parts = partitionner(pq_hl, seg_hl,
                             lambda p: (soiree(p.t, pic), heure(p.t)) if dans_plage(heure(p.t), pic) else None)
        for bk in sorted(parts):
            reels_b = [p for p in parts[bk][0] if not p.virtuel]
            r = sorted(p.rtt for p in reels_b if not p.perdu)
            e = r + [INF] * (len(reels_b) - len(r))
            blocs.append((e, r))
            ind["blocs_pic"][bk] = (centile(e, 0.95), len(reels_b))
        ind["bootstrap_pic"] = bootstrap(blocs, a.bootstrap)
        parts = partitionner(pq_hl, seg_hl, lambda p: heure(p.t))
        ind["heures"] = {h: indicateurs(*parts[h], iv) for h in sorted(parts)}
        ind["hl"] = ind_hl
        resultats[cle] = ind

    # Corrélation des pannes : cibles d'une même source, même transport.
    correl = []
    for src, cibles in sorted(par_source.items()):
        loc, nc = locale[src], non_classables[src]
        for i, x in enumerate(sorted(cibles)):
            for y in sorted(cibles)[i + 1:]:
                if transport(x) != transport(y):
                    continue
                ex, px = sec[src + (x,)]
                ey, py = sec[src + (y,)]
                communes = ex & ey
                px, py = px & communes, py & communes
                deux = px & py
                ligne = {"site": src[0], "acces": src[1], "cible_x": x, "cible_y": y,
                         "secondes_communes": len(communes), "panne_x_s": len(px), "panne_y_s": len(py),
                         "panne_simultanee_s": len(deux),
                         "p_y_sachant_x_pct": 100.0 * len(deux) / len(px) if px else None,
                         "panne_locale_s": None if loc is None else len(loc & communes),
                         "non_classables_s": len(nc & communes),
                         "p_y_sachant_x_hors_locale_pct": None, "episodes_x_hors_locale": None,
                         "p_y_sachant_x_episodes_pct": None, "statut": ""}
                if loc is None:
                    ligne["statut"] = "indéterminé : aucun témoin hors Hetzner"
                else:
                    pxl = px - loc - nc
                    if pxl:
                        ligne["p_y_sachant_x_hors_locale_pct"] = 100.0 * len(pxl & py) / len(pxl)
                    eps = episodes(pxl, a.episode_min_s)
                    coinc = 0
                    for d0, d1 in eps:
                        dans = set(range(d0, d1 + 1))
                        mesure = dans & ey
                        if mesure and len(dans & py) >= 0.5 * len(mesure):
                            coinc += 1
                    ligne["episodes_x_hors_locale"] = len(eps)
                    if len(eps) >= a.episodes_min:
                        ligne["p_y_sachant_x_episodes_pct"] = 100.0 * coinc / len(eps)
                        ligne["statut"] = "mesuré"
                    else:
                        ligne["statut"] = f"indéterminé : {len(eps)} épisode(s) < {a.episodes_min}"
                correl.append(ligne)

    # Comparaison appariée, heure par heure du pic (même source, même transport).
    appariement = []
    for src, cibles in sorted(par_source.items()):
        for i, x in enumerate(sorted(cibles)):
            for y in sorted(cibles)[i + 1:]:
                if transport(x) != transport(y):
                    continue
                bx, by = resultats[src + (x,)]["blocs_pic"], resultats[src + (y,)]["blocs_pic"]
                diffs = []
                for bk in sorted(set(bx) & set(by)):
                    (vx, nx), (vy, ny) = bx[bk], by[bk]
                    if nx < n_min(0.95) or ny < n_min(0.95) or vx is None or vy is None:
                        continue
                    if vx == vy:
                        diffs.append((bk[0], 0.0))
                    else:
                        diffs.append((bk[0], (vx - vy) / 1e6 if INF not in (vx, vy) else (INF if vx > vy else -INF)))
                n = len(diffs)
                moins = sum(1 for _, dv in diffs if dv < 0)
                plus = sum(1 for _, dv in diffs if dv > 0)
                par_s = defaultdict(list)
                for dte, dv in diffs:
                    par_s[dte].append(dv)
                signes = {dte: (sorted(v)[len(v) // 2] if v else 0) for dte, v in par_s.items()}
                verdict = "indistinct"
                if n and moins >= 0.8 * n and all(v < 0 for v in signes.values()):
                    verdict = f"{x} meilleur"
                elif n and plus >= 0.8 * n and all(v > 0 for v in signes.values()):
                    verdict = f"{y} meilleur"
                finies = sorted(dv for _, dv in diffs if abs(dv) != INF)
                appariement.append({"site": src[0], "acces": src[1], "cible_x": x, "cible_y": y, "heures": n,
                                    "x_meilleur_pct": 100.0 * moins / n if n else None,
                                    "y_meilleur_pct": 100.0 * plus / n if n else None,
                                    "ecart_median_ms": finies[len(finies) // 2] if finies else None,
                                    "soirees": len(signes),
                                    "soirees_x_meilleur": sum(1 for v in signes.values() if v < 0),
                                    "soirees_y_meilleur": sum(1 for v in signes.values() if v > 0),
                                    "verdict": verdict})

    # Charge WAN (compteurs du routeur, via syslog), moyenne par heure UTC.
    charge = {}
    for src, mesures in wan.items():
        par_h = defaultdict(lambda: [0.0, 0.0, 0])
        for (t0_, rx0, tx0), (t1_, rx1, tx1) in zip(mesures, mesures[1:]):
            dt = t1_ - t0_
            if not (30 <= dt <= 180) or rx1 < rx0 or tx1 < tx0:
                continue
            h = heure((t0_ + dt / 2) * NS)
            c = par_h[h]
            c[0] += (rx1 - rx0) * 8 / dt / 1e6
            c[1] += (tx1 - tx0) * 8 / dt / 1e6
            c[2] += 1
        charge[src] = {h: (v[0] / v[2], v[1] / v[2], v[2]) for h, v in par_h.items()}

    # Flux clairsemé.
    rare_res = []
    for (s, ac, nom), mes in sorted(rares.items()):
        r = sorted(v for _, v in mes if v is not None)
        dense = resultats.get((s, ac, nom[:-5])) if nom.endswith("-rare") else None
        p50 = ms(centile(r, 0.5))
        rare_res.append({"site": s, "acces": ac, "nom": nom, "envoyes": len(mes), "recus": len(r),
                         "perte_pct": 100.0 * (len(mes) - len(r)) / len(mes) if mes else None,
                         "p50": p50, "p95": ms(centile(r, 0.95)), "max": ms(r[-1]) if r else None,
                         "dense_p50": dense["p50"] if dense else None,
                         "surcout_p50_ms": (p50 - dense["p50"]) if dense and p50 is not None and dense["p50"] is not None else None})

    ecrire_csv(a, resultats, correl, appariement, rare_res, timeouts, essais, charge)
    ecrire_md(a, resultats, correl, appariement, rare_res, timeouts, essais, pic, creuses, evenements, ignores, charge)
    print(f"écrit : {a.sortie}.md {a.sortie}.csv {a.sortie}-heures.csv {a.sortie}-correlation.csv "
          f"{a.sortie}-soirees.csv {a.sortie}-appariement.csv {a.sortie}-rare.csv")
    return 0


COLONNES = ["envoyes", "recus", "perte_pct", "perte_montante", "perte_descendante", "virtuels",
            "min", "p50", "p95", "p99", "p999", "max", "p95e", "p99e", "p999e", "gigue",
            "rafale_max_paquets", "rafale_max_s", "rafale_max_silence_s", "silence_max_s",
            "rafales_1s", "rafales_3s", "rafales_10s", "ge_p_pct", "ge_r_pct"]
COL_PERIODE = ["envoyes", "perte_pct", "p50", "p95", "p99", "p999", "p95e", "p99e", "p999e", "rafale_max_s"]


def rnd(x, nd=3):
    if x is None:
        return ""
    if x == INF:
        return "inf"
    if isinstance(x, float):
        return round(x, nd)
    return x


def taux(cellule, variante=1):
    n = cellule[0]
    return 100.0 * cellule[variante] / n if n else None


def ecrire_csv(a, resultats, correl, appariement, rare_res, timeouts, essais, charge):
    prefixe = a.sortie
    grille = [(k, T) for k in essais for T in timeouts]
    with open(prefixe + ".csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        tete = ["site", "acces", "cible", "debut", "fin", "duree_h", "couverture_pct", "intervalle_ms", "fichiers",
                "fins_de_tranche_perdues", "fin_sigterm", "fin_erreur_envoi", "fin_inexpliquee", "en_vol_retires",
                "sauts_horloge", "panne_locale_s", "hl_retires"] + COLONNES
        tete += [f"hl_{c}" for c in COLONNES]
        tete += [f"brut_echec_k{k}_t{T}s_pct" for k, T in grille]
        tete += [f"hl_echec_k{k}_t{T}s_pct" for k, T in grille]
        tete += [f"hl_episodes_k{k}_t{T}s" for k, T in grille]
        tete += [f"pic_echec_k{k}_t{T}s_pct" for k, T in grille]
        tete += [f"pic_tardif_k{k}_t{T}s_pct" for k, T in grille]
        tete += [f"pic_bascules_jour_k{k}_t{T}s" for k, T in grille]
        for per in ("creuses", "pic"):
            tete += [f"{per}_{c}" for c in COL_PERIODE]
        tete += ["pic_p95e_ic90_bas", "pic_p95e_ic90_haut", "pic_p999_ic90_bas", "pic_p999_ic90_haut"]
        w.writerow(tete)
        for (site, acces, cible), ind in sorted(resultats.items()):
            hl = ind["hl"] or {}
            r = [site, acces, cible, ind["debut"], ind["fin"], round(ind["duree_h"], 3), rnd(ind["couverture_pct"]),
                 ind["intervalle_ms"], ind["fichiers"], ind["fins_de_tranche_perdues"], ind["fin_sigterm"],
                 ind["fin_erreur_envoi"], ind["fin_inexpliquee"], ind["en_vol_retires"], ind["sauts_horloge"],
                 ind["locale_s"], ind["hl_retires"]] + [rnd(ind[c]) for c in COLONNES]
            r += [rnd(hl.get(c)) for c in COLONNES]
            r += [rnd(taux(ind["timeouts_brut"][g]), 4) for g in grille]
            r += [rnd(taux(ind["timeouts"][g]), 4) for g in grille]
            r += [ind["timeouts"][g][3] for g in grille]
            r += [rnd(taux(ind["timeouts_pic"][g]), 4) for g in grille]
            r += [rnd(taux(ind["timeouts_pic"][g], 2), 4) for g in grille]
            r += [rnd(None if taux(ind["timeouts_pic"][g]) is None else taux(ind["timeouts_pic"][g]) / 100 * a.auth_par_jour, 3)
                  for g in grille]
            for per in ("creuses", "pic"):
                pp = ind["periodes"][per]
                r += [rnd(pp[c]) if pp else "" for c in COL_PERIODE]
            bs = ind["bootstrap_pic"] or {}
            r += [rnd(x) for x in (bs.get("p95e") or (None, None))] + [rnd(x) for x in (bs.get("p999") or (None, None))]
            w.writerow(r)
    with open(prefixe + "-heures.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["site", "acces", "cible", "heure_utc"] + COLONNES + ["wan_rx_mbps", "wan_tx_mbps"])
        for (site, acces, cible), ind in sorted(resultats.items()):
            ch = charge.get((site, acces), {})
            for h, hi in ind["heures"].items():
                c = ch.get(h)
                w.writerow([site, acces, cible, h] + [rnd(hi[k]) for k in COLONNES]
                           + ([rnd(c[0]), rnd(c[1])] if c else ["", ""]))
    with open(prefixe + "-soirees.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["site", "acces", "cible", "soiree"] + COL_PERIODE
                   + [f"echec_k{k}_t{T}s_pct" for k, T in grille])
        for (site, acces, cible), ind in sorted(resultats.items()):
            for dte, si in ind["soirees"].items():
                w.writerow([site, acces, cible, dte] + [rnd(si[c]) for c in COL_PERIODE]
                           + [rnd(taux(ind["timeouts_soirees"][(dte, k, T)]), 4) for k, T in grille])
    cols = ["site", "acces", "cible_x", "cible_y", "secondes_communes", "panne_x_s", "panne_y_s",
            "panne_simultanee_s", "p_y_sachant_x_pct", "panne_locale_s", "non_classables_s",
            "p_y_sachant_x_hors_locale_pct", "episodes_x_hors_locale", "p_y_sachant_x_episodes_pct", "statut"]
    with open(prefixe + "-correlation.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for c in correl:
            w.writerow([rnd(c[k]) for k in cols])
    cols = ["site", "acces", "cible_x", "cible_y", "heures", "x_meilleur_pct", "y_meilleur_pct", "ecart_median_ms",
            "soirees", "soirees_x_meilleur", "soirees_y_meilleur", "verdict"]
    with open(prefixe + "-appariement.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for c in appariement:
            w.writerow([rnd(c[k]) for k in cols])
    cols = ["site", "acces", "nom", "envoyes", "recus", "perte_pct", "p50", "p95", "max", "dense_p50", "surcout_p50_ms"]
    with open(prefixe + "-rare.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for c in rare_res:
            w.writerow([rnd(c[k]) for k in cols])


def avert(ind, cle):
    return "" if ind.get(cle + "_fiable", True) else " ⚠"


def fq(ind, cle, nd=1):
    """Centile formaté, avec ⚠ s'il laisse moins de 10 valeurs dans la queue."""
    return fmt(ind[cle], nd) + avert(ind, cle)


def ecrire_md(a, resultats, correl, appariement, rare_res, timeouts, essais, pic, creuses, evenements, ignores, charge):
    L = []
    L.append("# Mesures de latence WAKATNET — résultats")
    L.append("")
    L.append(f"Généré par `analyse.py` le {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}. "
             f"Heures en UTC (= heure du Burkina). Pic du soir : {pic[0]} h–{pic[1]} h ; "
             f"heures creuses : {creuses[0]} h–{creuses[1]} h. "
             f"Temps serveur ajouté dans l'émulation du timeout : {a.temps_serveur_ms:g} ms. "
             f"Hypothèse de volume : {a.auth_par_jour:g} authentifications par jour et par routeur. "
             f"Groupes Hetzner : {a.groupes_hetzner} (tout autre groupe est un témoin de panne locale).")
    L.append("")
    L.append("Conventions : RTT en ms. *Reçus* = centiles sur les seuls RTT reçus. *Effectif* (`e`) = centile du "
             "délai où une perte compte comme un délai infini (« perdu » = le centile tombe dans les pertes). "
             "⚠ = centile q calculé sur moins de 10/(1−q) valeurs (moins de 10 valeurs dans la queue : 1 000 pour "
             "le p99, 10 000 pour le p99.9). *HL* = hors panne locale. *Gigue* = moyenne de |ΔRTT| entre paquets "
             "reçus consécutifs (IPDV moyen), pas l'estimateur filtré de la RFC 3550.")
    L.append("")
    L.append("## 1. Tableau principal (accès × cible), toute la mesure")
    L.append("")
    L.append("*Rafale* = pertes consécutives : paquets / durée des pertes mesurées (paquets × intervalle) / "
             "silence complet (ajoute les silences de la sonde : trous entre tranches, attente d'ouverture). "
             "Les compteurs ≥ 1 s / ≥ 3 s / ≥ 10 s portent sur la durée des pertes mesurées.")
    L.append("")
    L.append("| site | accès | cible | durée h | couv. % | envoyés | perte % brut / HL | p50 | p95 | p99 | p99.9 "
             "| p95e / p99e / p99.9e HL | max | gigue | rafale max (paq. / pertes s / silence s) "
             "| rafales ≥1 s / ≥3 s / ≥10 s | indispo. ouverture (paq.) | panne locale |")
    L.append("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|")
    for (site, acces, cible), ind in sorted(resultats.items()):
        hl = ind["hl"] or ind
        L.append(
            f"| {site} | {acces} | {cible} | {fmt(ind['duree_h'], 2)} | {fmt(ind['couverture_pct'])} "
            f"| {ind['envoyes']} | {fmt(ind['perte_pct'], 2)} / {fmt(hl['perte_pct'], 2)} | {fq(ind, 'p50')} "
            f"| {fq(ind, 'p95')} | {fq(ind, 'p99')} | {fq(ind, 'p999')} "
            f"| {fq(hl, 'p95e')} / {fq(hl, 'p99e')} / {fq(hl, 'p999e')} | {fmt(ind['max'])} | {fmt(ind['gigue'])} "
            f"| {ind['rafale_max_paquets']} / {fmt(ind['rafale_max_s'], 2)} / {fmt(ind['rafale_max_silence_s'], 2)} "
            f"| {ind['rafales_1s']} / {ind['rafales_3s']} / {ind['rafales_10s']} | {ind['virtuels']} "
            f"| {ind['locale']} ; {ind['locale_s']} s |")
    L.append("")
    L.append("## 2. Timeout `/radius` émulé, au pic du soir, hors panne locale")
    L.append("")
    L.append("Chaque paquet de la sonde sert d'instant de départ d'une requête. Variante stricte : un essai échoue "
             "si son paquet est perdu ou si RTT + temps serveur > T ; la requête expire sur A (bascule vers B) si "
             "les K essais échouent. Variante tardive (dépend de LABO-16) : une réponse à l'essai j arrivée avant "
             "K·T est acceptée. Cellule : *% strict* / *% tardif* (*fausses bascules attendues par jour* = % strict "
             f"× {a.auth_par_jour:g}). Le nombre d'essais réel de RouterOS n'est **pas vérifié** (LABO). Le même "
             "calcul sur toute la mesure, brut et hors panne locale, est dans le CSV.")
    for k in essais:
        L.append("")
        L.append(f"### K = {k} essai(s)")
        L.append("")
        L.append("| site | accès | cible | instants | " + " | ".join(f"T = {T:g} s" for T in timeouts) + " |")
        L.append("|---|---|---|---:|" + "---:|" * len(timeouts))
        for (site, acces, cible), ind in sorted(resultats.items()):
            cells = []
            n_inst = ind["timeouts_pic"][(k, timeouts[0])][0]
            for T in timeouts:
                c = ind["timeouts_pic"][(k, T)]
                ps, pt = taux(c), taux(c, 2)
                bj = None if ps is None else ps / 100 * a.auth_par_jour
                cells.append(f"{fmt(ps, 3)} / {fmt(pt, 3)} ({fmt(bj, 2)}/j)")
            L.append(f"| {site} | {acces} | {cible} | {n_inst} | " + " | ".join(cells) + " |")
    L.append("")
    L.append("## 3. Heures creuses et pic du soir (hors panne locale)")
    L.append("")
    L.append("| site | accès | cible | période | envoyés | perte % | p50 | p95 | p99 | p99.9 | p95e | p99e | p99.9e "
             "| rafale max s |")
    L.append("|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for (site, acces, cible), ind in sorted(resultats.items()):
        for per in ("creuses", "pic"):
            pp = ind["periodes"][per]
            if not pp:
                L.append(f"| {site} | {acces} | {cible} | {per} | 0 |" + " — |" * 9)
                continue
            L.append(f"| {site} | {acces} | {cible} | {per} | {pp['envoyes']} | {fmt(pp['perte_pct'], 2)} "
                     f"| {fq(pp, 'p50')} | {fq(pp, 'p95')} | {fq(pp, 'p99')} | {fq(pp, 'p999')} "
                     f"| {fq(pp, 'p95e')} | {fq(pp, 'p99e')} | {fq(pp, 'p999e')} | {fmt(pp['rafale_max_s'], 2)} |")
    L.append("")
    L.append("## 3 bis. Pic du soir, soirée par soirée (hors panne locale)")
    L.append("")
    L.append("Q (p99.9 du RTT reçu, au pic) se prend comme le **maximum sur les soirées**. IC 90 % : bootstrap en "
             f"blocs d'une heure de pic ({a.bootstrap} tirages ; grossier avec moins d'une quinzaine de blocs).")
    L.append("")
    L.append("| site | accès | cible | soirées | p95e min / max | p99.9 min / max (Q = max) | IC 90 % p95e pic | IC 90 % p99.9 pic |")
    L.append("|---|---|---|---:|---:|---:|---:|---:|")
    for (site, acces, cible), ind in sorted(resultats.items()):
        so = ind["soirees"]
        if not so:
            L.append(f"| {site} | {acces} | {cible} | 0 | — | — | — | — |")
            continue
        p95s = [s["p95e"] for s in so.values() if s["p95e"] is not None]
        p999s = [s["p999"] for s in so.values() if s["p999"] is not None]
        fiable = all(s["p999_fiable"] for s in so.values())
        bs = ind["bootstrap_pic"] or {}
        ic = lambda v: f"{fmt(v[0])} – {fmt(v[1])}" if v else "—"
        L.append(f"| {site} | {acces} | {cible} | {len(so)} | {fmt(min(p95s) if p95s else None)} / "
                 f"{fmt(max(p95s) if p95s else None)} | {fmt(min(p999s) if p999s else None)} / "
                 f"{fmt(max(p999s) if p999s else None)}{'' if fiable else ' ⚠'} | {ic(bs.get('p95e'))} "
                 f"| {ic(bs.get('p999'))} |")
    L.append("")
    L.append("Détail par soirée : `-soirees.csv`.")
    L.append("")
    L.append("## 4. Corrélation des pannes (même source, même transport)")
    L.append("")
    L.append("Seconde *en panne* = au moins un paquet envoyé et aucun reçu. *Panne locale* = seconde où un témoin "
             "(cible hors Hetzner) a des paquets et où **toutes** les cibles qui en ont sont muettes ; sans témoin, "
             "elle est **indéterminée** et rien n'est conclu. *Non classables* = secondes de panne sans aucune "
             "donnée de témoin (exclues du calcul hors locale). P(Y|X) en épisodes : part des épisodes de panne de "
             f"X hors locale (≥ {a.episode_min_s} s consécutives) pendant lesquels Y est en panne au moins la moitié "
             f"du temps ; **indéterminé** sous {a.episodes_min} épisodes. C'est cette colonne qui sert aux règles 7.2 "
             "et 7.3 ; la valeur en secondes est donnée pour mémoire (un seul long épisode la domine).")
    L.append("")
    L.append("| site | accès | X | Y | s communes | panne X s | simultanées s | P(Y\\|X) % brut | panne locale s "
             "| non classables s | P(Y\\|X) HL % (s) | épisodes X HL | P(Y\\|X) HL % (épisodes) | statut |")
    L.append("|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|")
    for c in correl:
        L.append(f"| {c['site']} | {c['acces']} | {c['cible_x']} | {c['cible_y']} | {c['secondes_communes']} "
                 f"| {c['panne_x_s']} | {c['panne_simultanee_s']} | {fmt(c['p_y_sachant_x_pct'])} "
                 f"| {fmt(c['panne_locale_s'], 0) if c['panne_locale_s'] is not None else 'indét.'} "
                 f"| {c['non_classables_s']} | {fmt(c['p_y_sachant_x_hors_locale_pct'])} "
                 f"| {c['episodes_x_hors_locale'] if c['episodes_x_hors_locale'] is not None else '—'} "
                 f"| {fmt(c['p_y_sachant_x_episodes_pct'])} | {c['statut']} |")
    L.append("")
    L.append("## 4 bis. Comparaison appariée, heure par heure du pic (hors panne locale)")
    L.append("")
    L.append("Pour chaque heure de pic où les deux cibles ont au moins 200 paquets, on compare leur p95 effectif "
             "(mesures simultanées depuis la même sonde). Verdict « X meilleur » si X est meilleur sur au moins "
             "80 % des heures **et** sur chaque soirée (écart médian de la soirée) ; sinon « indistinct ».")
    L.append("")
    L.append("| site | accès | X | Y | heures | X meilleur % | Y meilleur % | écart médian X−Y ms | soirées X / Y meilleur | verdict |")
    L.append("|---|---|---|---|---:|---:|---:|---:|---:|---|")
    for c in appariement:
        L.append(f"| {c['site']} | {c['acces']} | {c['cible_x']} | {c['cible_y']} | {c['heures']} "
                 f"| {fmt(c['x_meilleur_pct'])} | {fmt(c['y_meilleur_pct'])} | {fmt(c['ecart_median_ms'])} "
                 f"| {c['soirees_x_meilleur']} / {c['soirees_y_meilleur']} sur {c['soirees']} | {c['verdict']} |")
    L.append("")
    L.append("## 5. Profil équivalent à rejouer en labo (LABO-16)")
    L.append("")
    L.append("Modèle de Gilbert simple ajusté hors panne locale et **hors rafales de plus de 10 s** (p : reçu → "
             "perdu ; r : perdu → reçu). Les coupures longues sont données à part : elles se rejouent comme des "
             "coupures, pas comme des pertes en rafale. Commande `tc netem` indicative, aller seulement.")
    L.append("")
    L.append("| site | accès | cible | p % | r % | rafale moy. (paquets) | netem indicatif | coupures > 10 s (début UTC, durée s) |")
    L.append("|---|---|---|---:|---:|---:|---|---|")
    for (site, acces, cible), ind in sorted(resultats.items()):
        hl = ind["hl"] or ind
        p, r = hl["ge_p_pct"], hl["ge_r_pct"]
        moy = 100.0 / r if r else None
        j = max(0.0, ((hl["p95"] or 0) - (hl["p50"] or 0)) / 1.645)
        netem = (f"`delay {fmt(hl['p50'], 0)}ms {fmt(j, 0)}ms distribution normal loss gemodel "
                 f"{fmt(p, 3)}% {fmt(r, 2)}% 100% 0%`") if p is not None and r is not None else "—"
        coup = ", ".join(f"{datetime.fromtimestamp(t / NS, tz=timezone.utc).strftime('%m-%d %H:%M:%S')} ({d:.1f})"
                         for t, d in hl["coupures_longues"][:10]) or "—"
        if len(hl["coupures_longues"]) > 10:
            coup += f" … ({len(hl['coupures_longues'])} au total)"
        L.append(f"| {site} | {acces} | {cible} | {fmt(p, 3)} | {fmt(r, 2)} | {fmt(moy, 1)} | {netem} | {coup} |")
    L.append("")
    L.append("## 6. Qualité de la capture")
    L.append("")
    L.append("*Fins anticipées* : irtt arrêté avant la durée demandée, par SIGTERM (journal `interrompue=oui`), sur "
             "erreur d'envoi (`send_err` d'irtt : interface tombée, réseau injoignable) ou sans cause connue. Seules "
             "les pertes de queue de la dernière fenêtre min(2 s ; 2 × p99) sont retirées (paquets « en vol »). "
             "*Sauts d'horloge* : tranches où l'horloge murale s'est écartée de plus de 1 s de l'horloge monotone "
             "d'irtt (pas de NTP en cours de tranche ; l'analyse suit l'horloge monotone).")
    L.append("")
    L.append("| site | accès | cible | début | fin | fichiers | intervalle ms | fins de tranche perdues ≥ 30 s "
             "| fins anticipées SIGTERM / erreur d'envoi / inexpliquées (paquets en vol retirés) | sauts d'horloge "
             "| perte montante / descendante | paquets retirés hors locale |")
    L.append("|---|---|---|---|---|---:|---:|---:|---:|---:|---|---:|")
    for (site, acces, cible), ind in sorted(resultats.items()):
        L.append(f"| {site} | {acces} | {cible} | {ind['debut']} | {ind['fin']} | {ind['fichiers']} "
                 f"| {fmt(ind['intervalle_ms'], 0)} | {ind['fins_de_tranche_perdues']} "
                 f"| {ind['fin_sigterm']} / {ind['fin_erreur_envoi']} / {ind['fin_inexpliquee']} ({ind['en_vol_retires']}) "
                 f"| {ind['sauts_horloge']} | {ind['perte_montante']} / {ind['perte_descendante']} | {ind['hl_retires']} |")
    if evenements:
        L.append("")
        L.append("Événements des journaux (sonde et routeur) : " + "; ".join(
            f"{s}-{ac} : " + ", ".join(f"{k} = {v}" for k, v in sorted(ev.items()))
            for (s, ac), ev in sorted(evenements.items())))
    if a.exclure:
        L.append("")
        L.append("Fenêtres exclues (`--exclure`) : " + ", ".join(f"`{e}`" for e in a.exclure) + " ; paquets retirés : "
                 + ", ".join(f"{'-'.join(k)} = {ind['exclus']}" for k, ind in sorted(resultats.items())))
    if ignores:
        L.append("")
        L.append("Fichiers ignorés : " + ", ".join(ignores))
    if not a.sans_heures:
        L.append("")
        L.append("## 7. Heure par heure (UTC, hors panne locale ; débit WAN moyen relevé par le routeur)")
        for (site, acces, cible), ind in sorted(resultats.items()):
            ch = charge.get((site, acces), {})
            L.append("")
            L.append(f"### {site} · {acces} · {cible}")
            L.append("")
            L.append("| heure | envoyés | perte % | p50 | p95 | p99 | p95e | rafale max s | WAN ↓ / ↑ Mbit/s |")
            L.append("|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
            for h, hi in ind["heures"].items():
                c = ch.get(h)
                L.append(f"| {h:02d} | {hi['envoyes']} | {fmt(hi['perte_pct'], 2)} | {fq(hi, 'p50')} "
                         f"| {fq(hi, 'p95')} | {fq(hi, 'p99')} | {fq(hi, 'p95e')} | {fmt(hi['rafale_max_s'], 2)} "
                         f"| {fmt(c[0], 2) + ' / ' + fmt(c[1], 2) if c else '—'} |")
    if rare_res:
        L.append("")
        L.append("## 8. Flux clairsemé (`rare.sh` : un ping toutes les 20 à 60 s, liaison au repos)")
        L.append("")
        L.append("Surcoût = p50 clairsemé − p50 du flux dense de la même cible (si `NOM` = `<cible>-rare`). Un surcoût "
                 "net sur 4G signale le délai de réveil radio ; une perte nette dans le sens VM → routeur signale une "
                 "traduction NAT expirée (chemin du CoA).")
        L.append("")
        L.append("| site | accès | nom | envoyés | perte % | p50 | p95 | max | p50 dense | surcoût p50 ms |")
        L.append("|---|---|---|---:|---:|---:|---:|---:|---:|---:|")
        for c in rare_res:
            L.append(f"| {c['site']} | {c['acces']} | {c['nom']} | {c['envoyes']} | {fmt(c['perte_pct'], 1)} "
                     f"| {fmt(c['p50'])} | {fmt(c['p95'])}{'' if c['recus'] >= n_min(0.95) else ' ⚠'} | {fmt(c['max'])} "
                     f"| {fmt(c['dense_p50'])} | {fmt(c['surcout_p50_ms'])} |")
    L.append("")
    with open(a.sortie + ".md", "w", encoding="utf-8") as f:
        f.write("\n".join(L))


if __name__ == "__main__":
    sys.exit(main())
