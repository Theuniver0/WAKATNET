"""Anti-devinette (T11), base en lecture seule, aucun code en clair — ticket 07, de bout en bout.

Ticket : .scratch/phase-1-coeur-radius/issues/07-anti-devinette.md ; ADR 0006 §10, §11.
"""
import pathlib

from conftest import admin, demander, nouveau_ticket

MAC_ATTAQUANT = "02-BA-D0-00-07-01"


def _refus(r, cause):
    assert r is not None and r.nom == "Access-Reject", r and r.attributs
    assert r.un("Reply-Message") == cause


def alertes(type_: str, depuis: int) -> list[tuple]:
    with admin() as c:
        return c.execute("""SELECT a.type, r.shortname, a.mac FROM radius.alerte a LEFT JOIN app.router r ON r.id = a.router_id
                             WHERE a.id > %s AND a.type = %s ORDER BY a.id""", (depuis, type_)).fetchall()


def dernier_id(table: str) -> int:
    with admin() as c:
        return c.execute(f"SELECT coalesce(max(id), 0) FROM radius.{table}").fetchone()[0]


def test_t11_dix_echecs_en_une_minute_bloquent_la_mac_puis_liberation():
    code = nouveau_ticket()
    a0 = dernier_id("alerte")
    for _ in range(10):
        _refus(demander("r1", code="ZZZZZZZZ", calling_station_id=MAC_ATTAQUANT), "ticket_inconnu")
    # Le onzième essai, même avec un code VALIDE, est refusé : le contrôle passe avant la recherche du ticket.
    _refus(demander("r1", code=code, calling_station_id=MAC_ATTAQUANT), "trop_de_tentatives")
    assert alertes("blocage_mac", a0) == [("blocage_mac", "r1", "02BAD0000701")]
    # Les refus trop_de_tentatives ne comptent pas comme échecs, et ne relancent pas l'alerte.
    for _ in range(3):
        _refus(demander("r1", code="ZZZZZZZZ", calling_station_id=MAC_ATTAQUANT), "trop_de_tentatives")
    assert len(alertes("blocage_mac", a0)) == 1
    # Un autre appareil du même routeur n'est pas touché (blocage par MAC). Ticket à lui : le ticket
    # `code` n'a qu'un appareil (ticket 06), sa place doit rester libre pour la suite.
    assert demander("r1", code=nouveau_ticket()).nom == "Access-Accept"
    # Après la fenêtre de blocage (5 min, données vieillies : forme d de l'ADR 0007), le code valide passe.
    with admin() as c:
        c.execute("UPDATE radius.auth_log SET at = at - interval '400 seconds' WHERE mac = '02BAD0000701'")
    assert demander("r1", code=code, calling_station_id=MAC_ATTAQUANT).nom == "Access-Accept"


def test_refus_d_un_vrai_ticket_ne_compte_pas_comme_tentative_de_devinette():
    """Seuls les échecs `ticket_inconnu` (code ou mot de passe faux) comptent : un client qui insiste
    avec un ticket expiré n'est pas bloqué."""
    with admin() as c:
        code = c.execute("SELECT app.voucher_creer(1, 1, now() - interval '1 minute')").fetchone()[0]
    for _ in range(12):
        _refus(demander("r1", code=code), "expire")


def test_base_en_lecture_seule_l_authentification_fonctionne():
    """Préparation de T13 (nœud B sur une réplique) : authorize ne fait que lire ; post_auth échoue
    sans changer la réponse. La lecture seule est imposée au rôle wk_radius, connexions renouvelées."""
    code = nouveau_ticket()
    j0 = dernier_id("auth_log")

    def basculer(lecture_seule: bool):
        with admin() as c:
            c.execute(f"ALTER ROLE wk_radius SET default_transaction_read_only = {'on' if lecture_seule else 'off'}")
            c.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'wk_radius'")

    basculer(True)
    try:
        r = demander("r1", code=code)
        assert r is not None and r.nom == "Access-Accept" and r.un("Session-Timeout") == 3600
        _refus(demander("r1", code="ZZZZZZZZ"), "ticket_inconnu")
        with admin() as c:
            assert c.execute("SELECT count(*) FROM radius.auth_log WHERE id > %s", (j0,)).fetchone()[0] == 0
    finally:
        basculer(False)
    assert demander("r1", code=code).nom == "Access-Accept"


def test_aucun_code_en_clair_dans_auth_log_ni_les_alertes():
    """Recherche automatique : aucun code de ticket existant n'apparaît dans auth_log ni radius.alerte."""
    with admin() as c:
        trouves = c.execute("""SELECT count(*) FROM app.voucher v
                                WHERE EXISTS (SELECT 1 FROM radius.auth_log a WHERE a::text LIKE '%' || v.code || '%')
                                   OR EXISTS (SELECT 1 FROM radius.alerte a WHERE a::text LIKE '%' || v.code || '%')""").fetchone()[0]
    assert trouves == 0


def test_journalisation_de_freeradius_sans_mot_de_passe_ni_code():
    """Production : radiusd.conf ne journalise ni les authentifications ni les mots de passe
    (ADR 0006 §10). Le debug -x, qui affiche le User-Name, est réservé au test (ADR 0008)."""
    conf = pathlib.Path("/depot/infra/freeradius/radiusd.conf").read_text()
    for reglage in ("auth = no", "auth_badpass = no", "auth_goodpass = no"):
        assert any(l.strip() == reglage for l in conf.splitlines()), reglage
