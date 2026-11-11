"""Consommation et épuisement en SQL, à instant fixé (ADR 0007, forme a) — ticket 05.

Ticket : .scratch/phase-1-coeur-radius/issues/05-compteurs.md
Les sessions sont écrites directement (superutilisateur), pour couvrir beaucoup de cas ;
les tests de bout en bout (test_t05.py) passent, eux, par l'accounting réel.
"""
from __future__ import annotations

import uuid

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from conftest import ROUTEURS_SQL, admin, en_tant_que_acct
from test_t03_sql import INSTANT, ST_MAX, US, _invariants, decider, oracle, suspendre_c, ticket_c


def sessions_ecrites(code: str, liste) -> None:
    """liste : (durée s, octets montants, octets descendants, arrêtée ?)."""
    with admin() as c:
        vid, tenant = c.execute("SELECT id, tenant_id FROM app.voucher WHERE tenant_id = 3 AND code = %s",
                                (code,)).fetchone()
        for duree, montants, descendants, arretee in liste:
            c.execute("""INSERT INTO radius.session (started_at, router_id, router_epoch, acct_session_id, tenant_id,
                                                     voucher_id, interim_s, dernier_evenement_le, duree_s,
                                                     octets_montants, octets_descendants, arrete_le)
                         SELECT %s, r.id, r.epoch, %s, %s, %s, 120, %s, %s, %s, %s, CASE WHEN %s THEN %s END
                           FROM app.router r WHERE r.shortname = 'c4'""",
                      (INSTANT, uuid.uuid4().hex[:16], tenant, vid, INSTANT, duree, montants, descendants,
                       arretee, INSTANT))


def volume(code: str, octets: int | None) -> None:
    with admin() as c:
        c.execute("UPDATE app.voucher SET f_data_limit_bytes = %s WHERE tenant_id = 3 AND code = %s", (octets, code))


# --- Cas dirigés -------------------------------------------------------------

def test_reste_de_temps_somme_des_sessions_ouvertes_et_arretees():
    code = ticket_c(uptime=3600)
    sessions_ecrites(code, [(1000, 0, 0, True), (500, 0, 0, False)])
    d = decider(code)
    assert (d["decision"], d["session_timeout"]) == ("Accept", 2100)


def test_temps_exactement_atteint_donne_epuise():
    code = ticket_c(uptime=3600)
    sessions_ecrites(code, [(3600, 0, 0, True)])
    assert (decider(code)["decision"], decider(code)["reply_message"]) == ("Reject", "epuise")


def test_une_seconde_restante_accepte():
    code = ticket_c(uptime=3600)
    sessions_ecrites(code, [(3599, 0, 0, True)])
    assert decider(code)["session_timeout"] == 1


def test_volume_somme_des_deux_sens_et_des_sessions():
    code = ticket_c(uptime=3600)
    volume(code, 1000)
    sessions_ecrites(code, [(10, 300, 200, True), (10, 250, 249, False)])
    assert decider(code)["decision"] == "Accept"              # 999 < 1000
    sessions_ecrites(code, [(0, 1, 0, False)])
    assert decider(code)["reply_message"] == "epuise"         # 1000 >= 1000


def test_expire_passe_avant_epuise():
    code = ticket_c(uptime=3600, expire=-1)
    sessions_ecrites(code, [(3600, 0, 0, True)])
    assert decider(code)["reply_message"] == "expire"


def test_sessions_d_un_autre_ticket_ne_comptent_pas():
    a, b = ticket_c(uptime=3600), ticket_c(uptime=3600)
    sessions_ecrites(a, [(3600, 0, 0, True)])
    assert decider(b)["session_timeout"] == 3600


# --- Inscription « à couper » par l'accounting -------------------------------

def _acct(fonction, code, sid, *, duree=0, montants=0, recu=1_900_000_000):
    with en_tant_que_acct() as c:
        return c.execute(f"SELECT radius.{fonction}(%s, %s, %s, '', '', %s, '', '0', '', %s, '', %s)",
                         (ROUTEURS_SQL["c4"][0], sid, code, str(montants), str(duree), str(recu))).fetchone()[0]


def _coupure(code):
    with admin() as c:
        return c.execute("""SELECT s.acct_session_id, s.motif_coupure, s.a_couper_le IS NOT NULL
                              FROM radius.session s JOIN app.voucher v ON v.id = s.voucher_id
                             WHERE v.tenant_id = 3 AND v.code = %s ORDER BY s.id""", (code,)).fetchall()


def test_volume_atteint_par_deux_sessions_ouvertes_les_inscrit_toutes_deux():
    code = ticket_c(uptime=3600)
    volume(code, 1000)
    a, b, c_ = uuid.uuid4().hex[:12], uuid.uuid4().hex[:12], uuid.uuid4().hex[:12]
    assert _acct("acct_stop", code, c_, montants=100) == "ok"          # arrêtée : jamais à couper
    assert _acct("acct_interim", code, a, montants=500) == "ok"
    assert [x[2] for x in _coupure(code)] == [False, False]
    assert _acct("acct_interim", code, b, montants=400) == "ok"        # 100 + 500 + 400 = 1000
    assert _coupure(code) == [(c_, None, False), (a, "volume_epuise", True), (b, "volume_epuise", True)]
    # Idempotent : un Interim de plus ne change ni l'instant ni le motif.
    with admin() as c:
        avant = c.execute("SELECT max(a_couper_le) FROM radius.session s JOIN app.voucher v ON v.id = s.voucher_id "
                          "WHERE v.code = %s", (code,)).fetchone()
    _acct("acct_interim", code, a, montants=600, recu=1_900_000_100)
    with admin() as c:
        assert c.execute("SELECT max(a_couper_le) FROM radius.session s JOIN app.voucher v ON v.id = s.voucher_id "
                         "WHERE v.code = %s", (code,)).fetchone() == avant


def test_temps_atteint_inscrit_temps_epuise():
    code = ticket_c(uptime=100)
    sid = uuid.uuid4().hex[:12]
    _acct("acct_interim", code, sid, duree=99)
    assert _coupure(code) == [(sid, None, False)]
    _acct("acct_interim", code, sid, duree=100)
    assert _coupure(code) == [(sid, "temps_epuise", True)]


# --- Propriété : décision conforme à l'oracle (ADR 0006 §4, §5 ; ticket 05) ---

SESSION = st.tuples(st.integers(0, 5000), st.integers(0, 2 * 10 ** 6), st.integers(0, 2 * 10 ** 6), st.booleans())


@settings(max_examples=200, deadline=None, database=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(
    uptime=st.one_of(st.none(), st.integers(1, 5000)),
    validite=st.one_of(st.none(), st.integers(1, 10 ** 6)),
    active=st.one_of(st.none(), st.integers(-10 ** 12, 0)),
    expire=st.one_of(st.none(), st.integers(-3 * US, 10 ** 12)),
    donnees=st.one_of(st.none(), st.integers(1, 4 * 10 ** 6)),
    liste=st.lists(SESSION, max_size=3),
)
def test_propriete_consommation_conforme_a_l_oracle(uptime, validite, active, expire, donnees, liste):
    if uptime is None and validite is None:
        uptime = 3600
    suspendre_c(False)
    code = ticket_c(uptime=uptime, validite=validite, active=active, expire=expire)
    volume(code, donnees)
    sessions_ecrites(code, liste)
    d = decider(code)
    _invariants(d, code)

    temps = sum(x[0] for x in liste)
    octets = sum(x[1] + x[2] for x in liste)
    attendu = oracle(suspendu=False, scope="tenant", site=None, routeur="c4",
                     uptime=None if uptime is None else uptime - temps,
                     validite=validite, active=active, expire=expire)
    # oracle (ticket 03) : un temps restant <= 0 donne déjà « epuise » APRÈS « expire ».
    if attendu[0] == "Accept" and donnees is not None and octets >= donnees:
        attendu = ("Reject", "epuise", None)
    assert (d["decision"], d["reply_message"], d["session_timeout"]) == attendu
    if d["decision"] == "Accept" and uptime is not None:
        assert d["session_timeout"] <= uptime - temps        # jamais plus que le temps restant
    assert d["session_timeout"] is None or d["session_timeout"] <= ST_MAX
