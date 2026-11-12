"""Prépare le générateur (ticket 10) : IP des routeurs de mesure sur le testeur, puis création
de leur client dynamique, un par seconde (rate_limit = yes, ADR 0006 §16). Mesure la durée de
cette création, qui est aussi la durée de reprise d'un nœud redémarré. TEST SEULEMENT.

  python3 preparer.py --routeurs N
"""
import argparse
import json
import os
import subprocess
import time

import psycopg

import radlib

a = argparse.ArgumentParser()
a.add_argument("--routeurs", type=int, required=True)
args = a.parse_args()
with psycopg.connect(host="172.29.215.5", dbname="wakatnet", user="wakatnet_admin",
                     password=os.environ["POSTGRES_PASSWORD"]) as c:
    ips = [r[0] for r in c.execute("""SELECT host(r.overlay_ip) FROM app.router r JOIN app.tenant t ON t.id = r.tenant_id
                                      WHERE t.nom = 'Propriétaire de mesure' ORDER BY r.id LIMIT %s""",
                                   (args.routeurs,)).fetchall()]
sortie = subprocess.run(["ip", "-o", "-4", "addr"], capture_output=True, text=True, check=True).stdout
iface = next(l.split()[1] for l in sortie.splitlines() if "10.213.1.10/" in l)
for ip in ips:
    if f" {ip}/" not in sortie:
        subprocess.run(["ip", "addr", "add", f"{ip}/16", "dev", iface], check=True)
secret = os.environ["WAKATNET_SECRET_R1"].encode()
debut = time.monotonic()
repondus = 0
for ip in ips:
    time.sleep(1.05)   # un nouveau client par seconde au plus (rate_limit)
    r = radlib.access_request(serveur=os.environ.get("WAKATNET_PERF_SERVEUR", "10.213.0.1"), secret=secret, source=ip, utilisateur="ZZZZZZZZ",
                              mot_de_passe="ZZZZZZZZ", calling_station_id="02-EF-00-00-00-01", delai=2.0, essais=2)
    repondus += r is not None
print(json.dumps({"routeurs": len(ips), "clients_crees": repondus,
                  "duree_creation_s": round(time.monotonic() - debut, 1)}))
