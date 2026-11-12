"""Durées des instructions de FreeRADIUS dans le journal de PostgreSQL (ticket 10).

Lit les lignes « duration: X ms  statement: … » (log_min_duration_statement = 0 pour wk_radius)
et rend, pour authorize et post_auth, le nombre de mesures et les quantiles en ms. Le texte des
instructions (qui porte des codes jetables de la base de mesure) n'est jamais recopié.
  python3 durees.py journal.txt
"""
import json
import re
import sys

MOTIF = re.compile(r"duration: ([0-9.]+) ms\s+statement: (.*)")
durees = {"authorize": [], "post_auth": [], "client_lookup": []}
for ligne in open(sys.argv[1], encoding="utf-8", errors="replace"):
    m = MOTIF.search(ligne)
    if not m:
        continue
    for nom in durees:
        if f"radius.{nom}(" in m.group(2):
            durees[nom].append(float(m.group(1)))


def q(v, p):
    return round(sorted(v)[min(len(v) - 1, int(p * len(v)))], 3) if v else None


print(json.dumps({nom: {"mesures": len(v), "p50": q(v, .5), "p95": q(v, .95), "p99": q(v, .99), "max": q(v, 1)}
                  for nom, v in durees.items()}))
