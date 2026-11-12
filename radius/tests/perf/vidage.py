"""Attend que le spool d'accounting soit vide après le retour de la base (ticket 10) et rend la
durée du rattrapage, comptée depuis la relance de PostgreSQL (--debut, horloge commune).
  python3 vidage.py --debut <secondes depuis l'époque>
"""
import argparse
import glob
import json
import time

a = argparse.ArgumentParser()
a.add_argument("--debut", type=float, required=True)
a.add_argument("--delai", type=float, default=1800)
args = a.parse_args()


def en_attente() -> int:
    return len(glob.glob("/radacct/wakatnet/detail-*")) + len(glob.glob("/radacct/wakatnet/detail.work"))


fin = time.time() + args.delai
while en_attente() and time.time() < fin:
    time.sleep(0.5)
print(json.dumps({"vide": en_attente() == 0, "duree_rattrapage_s": round(time.time() - args.debut, 1)}))
