"""T10 — une Access-Request sans Message-Authenticator est ignorée (BlastRADIUS, E-FR-2).

Y compris le TOUT PREMIER paquet d'une IP pas encore en cache (le client dynamique
est créé, puis le paquet est rejeté sans réponse). Contrôle positif dans le même passage.
La ligne « Packet does not contain required Message-Authenticator » est exigée dans le
journal du serveur par run.sh (le conteneur de test n'a pas accès aux journaux).
"""
import time

from conftest import demander, nouveau_ticket


def test_t10_premier_paquet_sans_message_authenticator_ignore_puis_controle_positif():
    code = nouveau_ticket()
    # rate_limit = yes : un seul nouveau client par seconde pour tout l'overlay. Sans
    # cette pause, le paquet pourrait être ignoré pour cause de débit et non de
    # Message-Authenticator (faux positif observé le 11/11/2026).
    time.sleep(1.5)
    # r4 n'a encore jamais émis : ce paquet est le premier de cette IP.
    sans = demander("r4", code=code, message_authenticator=False, essais=1, delai=2.0)
    assert sans is None, f"réponse inattendue : {sans and sans.nom}"
    avec = demander("r4", code=code, message_authenticator=True)
    assert avec is not None and avec.nom == "Access-Accept"


def test_t10_client_en_cache_sans_message_authenticator_ignore():
    code = nouveau_ticket()
    assert demander("r1", code=code).nom == "Access-Accept"  # r1 est en cache
    assert demander("r1", code=code, message_authenticator=False, essais=1, delai=2.0) is None
