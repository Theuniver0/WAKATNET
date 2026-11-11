"""Refus codés en SQL, à instant fixé (ADR 0007, forme a) — ticket 03.

Ticket : .scratch/phase-1-coeur-radius/issues/03-refus-codes.md
Appels à radius._authorize_at par le rôle de test wk_test, à un instant INSTANT
fixe : les bornes se testent à la microseconde, sans tolérance.

Propriétaire C (conftest.ROUTEURS_SQL) : routeur c4 sur le site C1, c5 sur le site C2,
forfait 6. Ces routeurs n'émettent aucun paquet ; ils ne servent qu'à la résolution
propriétaire / site de l'IP source.
"""
from __future__ import annotations

import contextlib
from datetime import datetime, timedelta, timezone

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from conftest import ROUTEURS_SQL, admin, en_tant_que_test

INSTANT = datetime(2030, 1, 1, tzinfo=timezone.utc)
US = 1_000_000
ST_MAX = 2_147_483_647
COLONNES = ("cleartext_password", "decision", "reply_message", "session_timeout", "rate_limit", "port_limit", "interim")


def _ts(x):
    """Décalage en microseconds par rapport à INSTANT, ou ±infinity, ou None."""
    if x is None or isinstance(x, str):
        return x
    return (INSTANT + timedelta(microseconds=x)).isoformat()


def ticket_c(*, uptime=3600, validite=None, active=None, expire=None, scope="tenant", site=None) -> str:
    """Ticket du propriétaire C, colonnes figées posées directement (domaine valide des CHECK)."""
    with admin() as c:
        code = c.execute("SELECT app.voucher_creer(3, 6)").fetchone()[0]
        c.execute("""UPDATE app.voucher SET f_uptime_limit_s = %s, f_validity_s = %s,
                            activated_at = %s::timestamptz, expires_at = %s::timestamptz,
                            f_scope = %s, f_site_id = %s
                      WHERE tenant_id = 3 AND code = %s""",
                  (uptime, validite, _ts(active), _ts(expire), scope, site, code))
    return code


def decider(code: str, routeur: str = "c4", instant: datetime = INSTANT) -> dict:
    with en_tant_que_test() as c:
        lignes = c.execute("SELECT * FROM radius._authorize_at(%s, %s, '', '', %s)",
                           (code, ROUTEURS_SQL[routeur][0], instant)).fetchall()
    assert len(lignes) == 1, f"{len(lignes)} lignes : une seule attendue (ADR 0006 §2)"
    return dict(zip(COLONNES, lignes[0]))


def suspendre_c(valeur: bool) -> None:
    with admin() as c:
        c.execute("UPDATE app.tenant SET suspendu = %s WHERE id = 3", (valeur,))


@pytest.fixture(autouse=True)
def c_retabli():
    yield
    suspendre_c(False)


def _invariants(d: dict, code: str) -> None:
    assert d["decision"] in ("Accept", "Reject")
    if d["decision"] == "Reject":
        assert d["reply_message"] in ("ticket_inconnu", "expire", "epuise", "mauvais_site", "proprietaire_suspendu")
        assert all(d[k] is None for k in ("cleartext_password", "session_timeout", "rate_limit", "port_limit", "interim")), d
    else:
        assert d["reply_message"] is None
        assert d["cleartext_password"] == code
        assert 1 <= d["session_timeout"] <= ST_MAX
        assert (d["rate_limit"], d["port_limit"], d["interim"]) == ("2M/2M", 2, 120)


def _refus(d, cause):
    assert (d["decision"], d["reply_message"]) == ("Reject", cause), d


def _accept(d, st_attendu):
    assert (d["decision"], d["session_timeout"]) == ("Accept", st_attendu), d


# --- Ordre d'évaluation (ADR 0006 §4) ---------------------------------------

def test_ordre_ticket_inconnu_avant_suspension():
    suspendre_c(True)
    _refus(decider("ZZZZZZZZ"), "ticket_inconnu")


def test_ordre_suspension_puis_site_puis_expiration():
    code = ticket_c(scope="site", site=5, expire=-1)   # mauvais site sur c4 ET expiré
    suspendre_c(True)
    _refus(decider(code, "c4"), "proprietaire_suspendu")
    suspendre_c(False)
    _refus(decider(code, "c4"), "mauvais_site")
    _refus(decider(code, "c5"), "expire")


def test_routeur_inconnu_ou_ip_invalide():
    code = ticket_c()
    with en_tant_que_test() as c:
        for src in ("10.213.9.99", "pas-une-ip", "", None):
            ligne = c.execute("SELECT decision, reply_message FROM radius._authorize_at(%s, %s, '', '', %s)",
                              (code, src, INSTANT)).fetchall()
            assert ligne == [("Reject", "ticket_inconnu")], (src, ligne)


# --- Bornes, à la microseconde ----------------------------------------------

@pytest.mark.parametrize("reste_us, attendu", [
    (US + 1, 1), (US, 1), (US - 1, "expire"), (1, "expire"), (0, "expire"), (-1, "expire"),
])
def test_borne_validite(reste_us, attendu):
    """Fin de validité − maintenant < 1 s : expire (jamais d'Accept avec Session-Timeout < 1)."""
    code = ticket_c(uptime=None, validite=18000, active=reste_us - 18000 * US)
    d = decider(code)
    _refus(d, attendu) if attendu == "expire" else _accept(d, attendu)


@pytest.mark.parametrize("reste_us, attendu", [
    (2 * US - 1, 1), (US, 1), (US - 1, "expire"), (0, "expire"), (-US, "expire"),
])
def test_borne_expiration_absolue(reste_us, attendu):
    code = ticket_c(expire=reste_us)
    d = decider(code)
    _refus(d, attendu) if attendu == "expire" else _accept(d, attendu)


def test_session_timeout_est_le_minimum_des_restes():
    code = ticket_c(uptime=3600, validite=18000, active=-17000 * US)   # reste de validité : 1000 s
    _accept(decider(code), 1000)
    code = ticket_c(uptime=3600, validite=18000, active=-17000 * US, expire=500 * US)
    _accept(decider(code), 500)
    code = ticket_c(uptime=300, validite=18000, active=-17000 * US, expire=500 * US)
    _accept(decider(code), 300)


def test_validite_non_activee_compte_entiere():
    _accept(decider(ticket_c(uptime=None, validite=18000)), 18000)


@pytest.mark.parametrize("expire, attendu", [("infinity", 3600), ("-infinity", "expire")])
def test_expiration_infinie(expire, attendu):
    d = decider(ticket_c(expire=expire))
    _refus(d, attendu) if attendu == "expire" else _accept(d, attendu)


def test_session_timeout_plafonne_a_l_entier_32_bits_signe():
    """Session-Timeout est un entier RADIUS de 32 bits : au-delà, FreeRADIUS ne l'enverrait pas,
    et l'Accept partirait sans durée. Activation datée dans le futur (horloge fausse lors de l'import)."""
    code = ticket_c(uptime=None, validite=2_000_000_000, active=400_000_000 * US)
    _accept(decider(code), ST_MAX)


# --- Portée (scope) --------------------------------------------------------

def test_scope_site():
    code = ticket_c(scope="site", site=4)
    _accept(decider(code, "c4"), 3600)
    _refus(decider(code, "c5"), "mauvais_site")


def test_scope_proprietaire():
    code = ticket_c()
    _accept(decider(code, "c4"), 3600)
    _accept(decider(code, "c5"), 3600)


# --- Données incohérentes : refus codé, jamais d'exception ------------------

@contextlib.contextmanager
def voucher_sans_contraintes():
    """Transaction du superutilisateur, ANNULÉE à la fin : les CHECK de app.voucher sont
    retirées pour écrire des données que la production refuse. Le superutilisateur appelle
    _authorize_at dans la même transaction (il a tous les droits)."""
    with admin() as c:
        c.autocommit = False
        try:
            for (nom,) in c.execute("""SELECT conname FROM pg_constraint
                                        WHERE conrelid = 'app.voucher'::regclass AND contype = 'c'""").fetchall():
                c.execute(f'ALTER TABLE app.voucher DROP CONSTRAINT "{nom}"')
            yield c
        finally:
            c.rollback()


@pytest.mark.parametrize("colonnes, cause", [
    ({"f_uptime_limit_s": None, "f_validity_s": None}, "epuise"),
    ({"f_uptime_limit_s": None, "f_validity_s": None, "expires_at": "infinity"}, "epuise"),
    ({"f_uptime_limit_s": -5}, "epuise"),
    ({"f_uptime_limit_s": 0}, "epuise"),
    ({"f_uptime_limit_s": -5, "expires_at": "2000-01-01"}, "expire"),
    ({"f_uptime_limit_s": None, "f_validity_s": -10}, "epuise"),
    ({"f_uptime_limit_s": None, "f_validity_s": 0, "activated_at": "2029-12-31"}, "expire"),
    ({"f_scope": "inconnu"}, "mauvais_site"),
    ({"f_scope": "site", "f_site_id": None}, "mauvais_site"),
])
def test_donnee_incoherente_donne_un_refus_code(colonnes, cause):
    with voucher_sans_contraintes() as c:
        code = c.execute("SELECT app.voucher_creer(3, 6)").fetchone()[0]
        affectations = ", ".join(f"{k} = %s" for k in colonnes)
        c.execute(f"UPDATE app.voucher SET {affectations} WHERE tenant_id = 3 AND code = %s",
                  (*colonnes.values(), code))
        ligne = c.execute("SELECT * FROM radius._authorize_at(%s, %s, '', '', %s)",
                          (code, ROUTEURS_SQL["c4"][0], INSTANT)).fetchall()
    assert len(ligne) == 1
    d = dict(zip(COLONNES, ligne[0]))
    _refus(d, cause)
    assert all(d[k] is None for k in ("cleartext_password", "session_timeout", "rate_limit", "port_limit", "interim"))


# --- Propriété : la fonction suit l'oracle de l'ADR 0006 §4 et §5 ------------

def oracle(*, suspendu, scope, site, routeur, uptime, validite, active, expire):
    """Décision attendue, écrite d'après l'ADR 0006 (décalages en microsecondes, INSTANT = 0)."""
    if suspendu:
        return ("Reject", "proprietaire_suspendu", None)
    if not (scope == "tenant" or site == ROUTEURS_SQL[routeur][2]):
        return ("Reject", "mauvais_site", None)
    restes, expire_ = [], False
    if validite is not None:
        reste = validite * US if active is None else active + validite * US
        expire_ |= active is not None and reste // US < 1
        restes.append(reste)
    if expire == "-infinity":
        expire_ = True
    elif expire is not None and expire != "infinity":
        expire_ |= expire // US < 1
        restes.append(expire)
    if expire_:
        return ("Reject", "expire", None)
    if uptime is not None:
        restes.append(uptime * US)
    if not restes or min(restes) // US < 1:
        return ("Reject", "epuise", None)
    return ("Accept", None, min(min(restes) // US, ST_MAX))


DECALAGE = st.integers(-10**13, 10**13)


@settings(max_examples=300, deadline=None, database=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(
    suspendu=st.booleans(),
    portee=st.sampled_from([("tenant", None), ("site", 4), ("site", 5)]),
    routeur=st.sampled_from(["c4", "c5"]),
    uptime=st.one_of(st.none(), st.integers(1, 10**7)),
    validite=st.one_of(st.none(), st.integers(1, 10**7)),
    active=st.one_of(st.none(), DECALAGE, st.integers(-20 * US, 20 * US)),
    expire=st.one_of(st.none(), DECALAGE, st.integers(-3 * US, 3 * US), st.sampled_from(["infinity", "-infinity"])),
)
def test_propriete_decision_conforme_a_l_oracle(suspendu, portee, routeur, uptime, validite, active, expire):
    if uptime is None and validite is None:
        uptime = 3600   # CHECK de production : une durée est toujours bornée
    scope, site = portee
    code = ticket_c(uptime=uptime, validite=validite, active=active, expire=expire, scope=scope, site=site)
    suspendre_c(suspendu)
    d = decider(code, routeur)
    _invariants(d, code)
    attendu = oracle(suspendu=suspendu, scope=scope, site=site, routeur=routeur,
                     uptime=uptime, validite=validite, active=active, expire=expire)
    assert (d["decision"], d["reply_message"], d["session_timeout"]) == attendu
