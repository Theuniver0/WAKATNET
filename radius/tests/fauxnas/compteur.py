"""Faux NAS COMPTEUR (test, ticket 09) : compte chaque paquet reçu, valide ou non.

FreeRADIUS traite les renvois d'une requête rejetée comme des doublons et ne les journalise
pas (constaté le 12/11/2026) : il ne peut pas compter exactement les envois. Ce compteur le
fait, sur l'IP d'un routeur, avec deux modes :
  muet  : vérifie l'authentificateur de requête avec SON secret, ne répond jamais ;
  faux  : répond un ACK dont l'authentificateur est faux.
Usage : python3 compteur.py MODE IP PORT DUREE_S  (le secret est lu dans COMPTEUR_SECRET).
Sortie (JSON, une ligne) : {"recus": n, "valides": n, "sources": [...]}.
"""
import hashlib
import json
import os
import socket
import struct
import sys
import time

mode, ip, port, duree = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4])
secret = os.environ["COMPTEUR_SECRET"].encode()
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind((ip, port))
print("pret", flush=True)
recus, valides, sources = 0, 0, []
fin = time.monotonic() + duree
while (reste := fin - time.monotonic()) > 0:
    s.settimeout(reste)
    try:
        data, src = s.recvfrom(4096)
    except socket.timeout:
        break
    recus += 1
    sources.append(src[0])
    # RFC 5176 §3 : authentificateur = MD5(code + id + longueur + 16 zéros + attributs + secret).
    if len(data) >= 20 and hashlib.md5(data[:4] + b"\x00" * 16 + data[20:] + secret).digest() == data[4:20]:
        valides += 1
    if mode == "faux":
        code = 41 if data[0] == 40 else 44   # Disconnect-ACK / CoA-ACK
        s.sendto(struct.pack("!BBH", code, data[1], 20) + os.urandom(16), src)
print(json.dumps({"recus": recus, "valides": valides, "sources": sources}), flush=True)
