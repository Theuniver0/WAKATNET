#!/usr/bin/env python3
"""WAKATNET — banc CHR : plateforme minimale en HTTPS, jouée par l'hôte (le CHR la joint en 10.0.2.2).

Elle sert ce que l'API servirait, avec les scripts du VRAI générateur (generer.ts), sans base ni tunnel réel :
  POST /enroll/<jeton>      corps = inventaire JSON de l'étape 1 ; réponse = étape 2 (une fois par jeton, comme l'API)
  GET  /entretien/<jeton>   réponse = entretien (étape 3), regénéré à chaque appel depuis parametres.json
Tout ce que le routeur envoie est gardé dans <dossier>/recu-* pour les contrôles du banc.

    plateforme.py <dossier> <port> <cert.pem> <cle.pem>
"""
import json
import os
import ssl
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DOSSIER, PORT, CERT, CLE = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
ICI = os.path.dirname(os.path.abspath(__file__))
JETONS_CONSOMMES = set()


def generer(quoi, inventaire=None):
    args = ["node", "--experimental-strip-types", "--no-warnings", os.path.join(ICI, "generer.ts"), quoi,
            os.path.join(DOSSIER, "parametres.json")]
    if inventaire is not None:
        args.append(inventaire)
    return subprocess.run(args, check=True, capture_output=True).stdout


class Plateforme(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        with open(os.path.join(DOSSIER, "plateforme.log"), "a") as j:
            j.write("%s %s\n" % (self.command, self.path))

    def repondre(self, code, corps=b"", type_="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", type_)
        self.send_header("Content-Length", str(len(corps)))
        self.end_headers()
        self.wfile.write(corps)

    def do_POST(self):
        if not self.path.startswith("/enroll/"):
            return self.repondre(404)
        jeton = self.path.split("/")[2]
        corps = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        with open(os.path.join(DOSSIER, "recu-etape1.json"), "wb") as f:
            f.write(corps)
        try:
            json.loads(corps)
        except ValueError:
            return self.repondre(422, b"inventaire illisible")
        if jeton in JETONS_CONSOMMES:
            return self.repondre(410, b"commande deja utilisee")
        JETONS_CONSOMMES.add(jeton)
        # Ce que fait wg-agent en production : le nœud A accepte la clé du routeur, pour son adresse overlay seulement.
        parametres = json.load(open(os.path.join(DOSSIER, "parametres.json")))
        subprocess.run(["wg", "set", os.environ.get("WAKATNET_BANC_WG", "wg-noeud-a"), "peer", json.loads(corps)["cle"],
                        "allowed-ips", parametres["overlayIp"] + "/32"], check=True, timeout=10)
        return self.repondre(200, generer("etape2", os.path.join(DOSSIER, "recu-etape1.json")))

    def do_GET(self):
        if self.path.startswith("/entretien/"):
            with open(os.path.join(DOSSIER, "recu-entretien"), "a") as f:
                f.write(self.path + "\n")
            return self.repondre(200, generer("entretien"))
        return self.repondre(404)


contexte = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
contexte.load_cert_chain(CERT, CLE)
serveur = ThreadingHTTPServer(("127.0.0.1", PORT), Plateforme)
serveur.socket = contexte.wrap_socket(serveur.socket, server_side=True)
serveur.serve_forever()
