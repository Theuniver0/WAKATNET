#!/usr/bin/env python3
"""recepteur-syslog.py — reçoit le journal du routeur MikroTik sur la sonde Linux.

Pourquoi : écrire le journal de mesure dans la flash d'un petit routeur (hAP lite,
16 Mo) est risqué, et l'horloge du routeur est fausse après une coupure de
courant tant que NTP n'a pas resynchronisé. Le routeur envoie donc ses lignes
« wakatnet-labo … » en syslog UDP (action remote de routeros-sonde.rsc) vers la
sonde, qui les horodate avec SA propre horloge (UTC, NTP).

Écrit DOSSIER/AAAA-MM-JJ-<site>-<acces>.routeros.log, une ligne par message :
    <ISO UTC> epoch=<s> src=<ip> <message syslog brut, en une ligne>
Seules les lignes contenant « wakatnet-labo » sont gardées (le sujet « script »
de RouterOS capte aussi les autres scripts du routeur). Aucune donnée secrète.

Usage : recepteur-syslog.py -s SITE -a ACCES -o DOSSIER [--ecoute 0.0.0.0:5514]
        [--source IP_LAN_DU_ROUTEUR] [--duree SECONDES]
Bibliothèque standard seulement. Port 5514 par défaut : pas besoin d'être root.
"""

import argparse
import os
import re
import signal
import socket
import sys
import time
from datetime import datetime, timezone


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("-s", "--site", required=True)
    ap.add_argument("-a", "--acces", required=True)
    ap.add_argument("-o", "--dossier", required=True)
    ap.add_argument("--ecoute", default="0.0.0.0:5514")
    ap.add_argument("--source", default="", help="n'accepter que cette adresse source (IP LAN du routeur)")
    ap.add_argument("--duree", type=float, default=0, help="arrêt après N secondes (essais)")
    a = ap.parse_args()
    if not re.fullmatch(r"[a-z0-9]+", a.site) or not re.fullmatch(r"[a-z0-9]+", a.acces):
        print("site et accès : [a-z0-9] seulement", file=sys.stderr)
        return 2
    os.makedirs(a.dossier, exist_ok=True)
    hote, _, port = a.ecoute.rpartition(":")
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind((hote, int(port)))
    s.settimeout(1.0)
    fin = time.time() + a.duree if a.duree else None
    arret = []
    signal.signal(signal.SIGTERM, lambda *_: arret.append(1))
    recus = gardes = 0
    while not arret and (fin is None or time.time() < fin):
        try:
            data, (ip, _) = s.recvfrom(4096)
        except socket.timeout:
            continue
        except InterruptedError:
            continue
        recus += 1
        if a.source and ip != a.source:
            continue
        texte = data.decode("utf-8", errors="replace").replace("\n", " ").replace("\r", " ").strip()
        if "wakatnet-labo" not in texte:
            continue
        maintenant = time.time()
        d = datetime.fromtimestamp(maintenant, tz=timezone.utc)
        chemin = os.path.join(a.dossier, f"{d:%Y-%m-%d}-{a.site}-{a.acces}.routeros.log")
        with open(chemin, "a", encoding="utf-8") as f:
            f.write(f"{d:%Y-%m-%dT%H:%M:%SZ} epoch={int(maintenant)} src={ip} {texte}\n")
        gardes += 1
    print(f"recepteur-syslog fin : {recus} reçus, {gardes} gardés", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
