"""Clients dynamiques (rejeu de L1 et L4 sur la configuration de production).

IP inconnue, routeur inactif, IP hors overlay, secret d'un AUTRE routeur : ignorés.
Avant chaque premier paquet d'une IP, on libère le créneau de rate_limit, pour
qu'une absence de réponse ne puisse pas venir du débit.
"""
import time

import radlib
from conftest import (IP_HORS, IP_INCONNUE, ROUTEURS, SERVEUR, SERVEUR_HORS, admin,
                      creneau_nouveau_client, demander, nouveau_ticket, secret)


def _requete(source, serveur=SERVEUR, cle=b"nimporte", code="ABCDEFGH"):
    return radlib.access_request(serveur=serveur, secret=cle, source=source,
                                 utilisateur=code, mot_de_passe=code, essais=2, delai=1.5)


def test_ip_inconnue_dans_l_overlay_ignoree():
    creneau_nouveau_client()
    assert _requete(IP_INCONNUE, cle=secret("r1")) is None


def test_routeur_inactif_ignore():
    creneau_nouveau_client()
    assert _requete(ROUTEURS["r3"][0], cle=secret("r3")) is None


def test_ip_hors_overlay_ignoree():
    assert _requete(IP_HORS, serveur=SERVEUR_HORS, cle=secret("r1")) is None


def test_secret_d_un_autre_routeur_ignore():
    """Isolement des secrets (L1) : r2 qui présente le secret de r1 n'obtient rien."""
    code = nouveau_ticket()
    creneau_nouveau_client()
    assert demander("r2", code=code).nom == "Access-Accept"   # contrôle positif, secret de r2
    r = radlib.access_request(serveur=SERVEUR, secret=secret("r1"), source=ROUTEURS["r2"][0],
                              utilisateur=code, mot_de_passe=code, essais=2, delai=1.5)
    assert r is None


def test_desactivation_en_base_puis_reactivation():
    code = nouveau_ticket()
    creneau_nouveau_client()
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
    # Contrôle positif : réactivé, le routeur redevient un client (nouveau créneau).
    creneau_nouveau_client()
    r = demander("r5", code=code)
    assert r is not None and r.nom == "Access-Accept"


def _trois_en_meme_temps(noms):
    """Un Access-Request par routeur, envoyés ensemble (même seconde) ; rend {nom: répondu}."""
    import threading
    res = {}

    def envoi(nom):
        r = radlib.access_request(serveur=SERVEUR, secret=secret(nom), source=ROUTEURS[nom][0],
                                  utilisateur="ZZZZZZZZ", mot_de_passe="ZZZZZZZZ",
                                  calling_station_id=f"02-1B-00-00-00-{nom[1:]}", delai=1.5, essais=1)
        res[nom] = r is not None
    fils = [threading.Thread(target=envoi, args=(n,)) for n in noms]
    for f in fils:
        f.start()
    for f in fils:
        f.join()
    return res


def test_l8_rate_limit_a_la_creation_mais_pas_au_renouvellement():
    """L8 (docs/LABO.md), constaté sur 3.2.10 le 12/11/2026 : rate_limit = yes ne laisse passer qu'UN
    nouveau client par seconde, mais un client EXPIRÉ (lifetime) est recréé sans limite : il est
    recherché de nouveau en base, puisque r17, désactivé pendant l'attente, cesse de répondre.
    Conséquence (ADR 0006 §16) : seule la reprise à froid du nœud est lente, un client par seconde ;
    en régime établi, il n'y a pas de plafond du nombre de routeurs."""
    noms = ["r15", "r16", "r17"]
    time.sleep(1.5)
    premiers = _trois_en_meme_temps(noms)
    assert sum(premiers.values()) == 1, f"à la création, un seul nouveau client par seconde : {premiers}"
    for nom in noms:                       # les deux autres, un par seconde
        if not premiers[nom]:
            time.sleep(1.5)
            assert _trois_en_meme_temps([nom]) == {nom: True}
    assert _trois_en_meme_temps(noms) == {n: True for n in noms}      # tous en cache
    with admin() as c:
        c.execute("UPDATE app.router SET actif = false WHERE overlay_ip = %s", (ROUTEURS["r17"][0],))
    try:
        time.sleep(23)                     # lifetime de test : 20 s
        apres = _trois_en_meme_temps(noms)
    finally:
        with admin() as c:
            c.execute("UPDATE app.router SET actif = true WHERE overlay_ip = %s", (ROUTEURS["r17"][0],))
    assert apres == {"r15": True, "r16": True, "r17": False}, apres
