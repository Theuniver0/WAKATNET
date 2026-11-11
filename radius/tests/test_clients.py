"""Clients dynamiques (rejeu de L1 et L4 sur la configuration de production).

IP inconnue, routeur inactif, IP hors overlay, mauvais secret : ignorés.
Désactivation en base : effective après le lifetime du cache (20 s en test).
"""
import time

import radlib
from conftest import (IP_HORS, IP_INCONNUE, ROUTEURS, SERVEUR, SERVEUR_HORS, admin,
                      demander, nouveau_ticket, secret)


def _requete(source, serveur=SERVEUR, cle=b"nimporte", code="ABCDEFGH"):
    return radlib.access_request(serveur=serveur, secret=cle, source=source,
                                 utilisateur=code, mot_de_passe=code, essais=2, delai=1.5)


def test_ip_inconnue_dans_l_overlay_ignoree():
    assert _requete(IP_INCONNUE, cle=secret("r1")) is None


def test_routeur_inactif_ignore():
    assert _requete(ROUTEURS["r3"][0], cle=secret("r3")) is None


def test_ip_hors_overlay_ignoree():
    assert _requete(IP_HORS, serveur=SERVEUR_HORS, cle=secret("r1")) is None


def test_mauvais_secret_ignore():
    code = nouveau_ticket()
    assert demander("r2", code=code).nom == "Access-Accept"
    r = radlib.access_request(serveur=SERVEUR, secret=b"mauvais-secret", source=ROUTEURS["r2"][0],
                              utilisateur=code, mot_de_passe=code, essais=2, delai=1.5)
    assert r is None


def test_desactivation_en_base_effective_apres_lifetime():
    code = nouveau_ticket()
    assert demander("r5", code=code).nom == "Access-Accept"
    with admin() as c:
        c.execute("UPDATE app.router SET actif = false WHERE shortname = 'r5'")
    try:
        # Client encore en cache : il répond, mais authorize refuse déjà les tickets
        # d'un routeur désactivé (effet immédiat sur l'autorisation).
        r = demander("r5", code=code)
        assert r is not None and r.nom == "Access-Reject"
        time.sleep(23)  # lifetime de test = 20 s (surcharges/LISTE.md)
        # Cache expiré : le routeur n'est plus un client, plus aucune réponse (SPEC §5.1).
        assert demander("r5", code=code, essais=2, delai=1.5) is None
    finally:
        with admin() as c:
            c.execute("UPDATE app.router SET actif = true WHERE shortname = 'r5'")
