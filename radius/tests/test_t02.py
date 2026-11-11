"""T2 (partie authentification) — un ticket neuf est accepté avec le bon Session-Timeout.

Ticket : .scratch/phase-1-coeur-radius/issues/02-t2-bout-en-bout.md
Toute réponse reçue par conftest.demander porte un Message-Authenticator (vérifié là).
"""
import os
import subprocess
import tempfile
import time

import pytest

import radlib
from conftest import ROUTEURS, SERVEUR, admin, demander, nouveau_ticket, secret

ATTRS_ACCEPT = ("Session-Timeout", "Mikrotik-Rate-Limit", "Port-Limit", "Acct-Interim-Interval")


@pytest.mark.parametrize("methode", ["chap", "pap"])
def test_t2_ticket_neuf_accepte_avec_attributs_de_la_copie_figee(methode):
    code = nouveau_ticket()
    r = demander("r1", code=code, methode=methode)
    assert r is not None, "aucune réponse"
    assert r.nom == "Access-Accept", r.attributs
    assert r.un("Session-Timeout") == 3600
    assert r.un("Mikrotik-Rate-Limit") == "512k/2M"
    assert r.un("Port-Limit") == 1
    assert r.un("Acct-Interim-Interval") == 120


def test_attributs_tires_de_la_copie_figee_et_non_du_forfait_courant():
    code = nouveau_ticket(plan_id=1)
    with admin() as c:
        c.execute("UPDATE app.plan SET uptime_limit_s = 60, rate_limit = '9M/9M', devices = 5 WHERE id = 1")
    try:
        r = demander("r1", code=code)
        assert r.nom == "Access-Accept"
        assert (r.un("Session-Timeout"), r.un("Mikrotik-Rate-Limit"), r.un("Port-Limit")) == (3600, "512k/2M", 1)
    finally:
        with admin() as c:
            c.execute("UPDATE app.plan SET uptime_limit_s = 3600, rate_limit = '512k/2M', devices = 1 WHERE id = 1")


def test_forfait_sans_debit_n_envoie_pas_de_rate_limit_vide():
    code = nouveau_ticket(plan_id=2)
    r = demander("r1", code=code)
    assert r.nom == "Access-Accept"
    assert r.un("Mikrotik-Rate-Limit") is None
    assert r.un("Session-Timeout") == 3600


def test_ticket_expire_refuse_jamais_d_accept_sans_duree():
    with admin() as c:
        code = c.execute("SELECT app.voucher_creer(1, 1, now() - interval '1 minute')").fetchone()[0]
    r = demander("r1", code=code)
    assert r.nom == "Access-Reject"
    assert r.un("Reply-Message") == "expire"
    for attr in ATTRS_ACCEPT:
        assert r.un(attr) is None


def test_pap_insensible_a_la_casse():
    code = nouveau_ticket()
    r = demander("r1", code=code.lower(), methode="pap")
    assert r is not None and r.nom == "Access-Accept"


@pytest.mark.parametrize("methode", ["chap", "pap"])
def test_mauvais_mot_de_passe_donne_ticket_inconnu_sans_attribut_d_accept(methode):
    code = nouveau_ticket()
    r = demander("r1", code=code, mot_de_passe="ZZZZZZZZ", methode=methode)
    assert r is not None and r.nom == "Access-Reject"
    assert r.un("Reply-Message") == "ticket_inconnu"
    for attr in ATTRS_ACCEPT:
        assert r.un(attr) is None, f"{attr} ne doit pas figurer dans un Reject"


def test_code_inconnu_donne_ticket_inconnu():
    r = demander("r1", code="ZZZZZZZZ")
    assert r.nom == "Access-Reject" and r.un("Reply-Message") == "ticket_inconnu"


@pytest.mark.parametrize("valeur", ["AB'); SELECT pg_sleep(2);--", "AB\\'X", "A'B\"C\\D%{User-Name}"])
def test_valeurs_hostiles_echappees(valeur):
    """rlm_sql_map échappe les expansions dans la requête : aucune injection, aucune erreur SQL."""
    debut = time.monotonic()
    r = radlib.access_request(serveur=SERVEUR, secret=secret("r1"), source=ROUTEURS["r1"][0],
                              utilisateur=valeur, mot_de_passe="X", calling_station_id=valeur,
                              called_station_id=valeur, essais=1, delai=2.0)
    duree = time.monotonic() - debut
    assert r is not None, "silence : erreur SQL probable (do_not_respond)"
    assert r.nom == "Access-Reject" and r.un("Reply-Message") == "ticket_inconnu"
    assert duree < 1.0, f"réponse en {duree:.2f} s : pg_sleep exécuté ?"


def test_un_seul_appel_sql_par_access_request():
    """ADR 0006 §2 : une requête par Access-Request (pg_stat_user_functions, track_functions=all)."""
    def appels():
        with admin() as c:
            ligne = c.execute("""SELECT coalesce(sum(calls), 0) FROM pg_stat_user_functions
                                 WHERE schemaname = 'radius' AND funcname = 'authorize'""").fetchone()
            return int(ligne[0])

    def stable():
        # PostgreSQL 16 : une connexion INACTIVE (celles du pool de FreeRADIUS) ne publie
        # ses statistiques qu'après ~10 s d'inactivité. Sans cette attente, des appels
        # des tests précédents arrivent pendant la mesure (12 au lieu de 5, 11/11/2026).
        time.sleep(12)
        precedent = appels()
        time.sleep(12)
        courant = appels()
        assert courant == precedent, "statistiques encore en mouvement"
        return courant

    codes = [nouveau_ticket() for _ in range(5)]
    avant = stable()
    for code in codes:
        assert demander("r1", code=code, essais=1).nom == "Access-Accept"
    apres = stable()
    assert apres - avant == 5, f"{apres - avant} appels de radius.authorize pour 5 Access-Request"


def test_reject_sans_delai_artificiel():
    """reject_delay = 0 (ADR 0006 §4) : un Reject doit arriver bien avant le timeout RouterOS (1100 ms).
    Médiane de 5 essais, pour ne pas dépendre d'un pic de charge."""
    durees = []
    for _ in range(5):
        debut = time.monotonic()
        r = demander("r1", code="ZZZZZZZZ", essais=1, delai=1.0)
        durees.append(time.monotonic() - debut)
        assert r is not None and r.nom == "Access-Reject"
    durees.sort()
    assert durees[2] < 0.5, f"médiane {durees[2]:.3f} s"


def test_contre_verification_par_radclient():
    """Même résultat avec radclient 3.2.10 (outil de référence). Source : IP principale du
    conteneur de test, 10.213.1.10 (= r1, dont le secret est utilisé)."""
    code = nouveau_ticket()
    with tempfile.NamedTemporaryFile("wb", delete=True) as f:
        os.chmod(f.name, 0o600)
        f.write(secret("r1"))
        f.flush()
        requete = f'User-Name = "{code}"\nUser-Password = "{code}"\n'
        sortie = subprocess.run(["radclient", "-x", "-r", "3", "-t", "2", "-S", f.name, f"{SERVEUR}:1812", "auth"],
                                input=requete, capture_output=True, text=True, timeout=20)
    assert "Received Access-Accept" in sortie.stdout, "radclient : pas d'Access-Accept"
    assert "Session-Timeout = 3600" in sortie.stdout
    assert "Message-Authenticator" in sortie.stdout
