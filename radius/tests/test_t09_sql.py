"""Sessions à couper, cible d'un Disconnect, suivi des envois — ticket 09, en SQL (ADR 0010).

Ticket : .scratch/phase-1-coeur-radius/issues/09-coa-disconnect.md
Fonctions appelées par leur rôle de production, wk_coa. Sessions créées par acct_start (wk_acct)
sur les routeurs « SQL » du propriétaire C (c4, c5), que ces tests suspendent et rétablissent.
"""
import os
import uuid

import psycopg
import pytest

from conftest import ROUTEURS_SQL, admin, en_tant_que_acct, en_tant_que_coa, en_tant_que_radius, nouveau_ticket

C4 = ROUTEURS_SQL["c4"][0]


def _session(src=C4) -> tuple[int, str, str]:
    """Session ouverte sur `src` (propriétaire C) ; rend (id, acct_session_id, code)."""
    code, sid = nouveau_ticket(plan_id=6, tenant_id=3), uuid.uuid4().hex[:16]
    with admin() as c:
        recu = int(c.execute("SELECT extract(epoch FROM now())").fetchone()[0])
        # Les routeurs « SQL » n'ont pas de secret dans les données de test : un, jetable.
        c.execute("""INSERT INTO radius.router_secret (router_id, secret)
                     SELECT id, %s FROM app.router WHERE overlay_ip = %s ON CONFLICT DO NOTHING""",
                  (os.urandom(16).hex(), src))
    with en_tant_que_acct() as c:
        assert c.execute("SELECT radius.acct_start(%s, %s, %s, '02-00-00-00-09-01', '', '', '', '', '', '0', '', %s)",
                         (src, sid, code, str(recu))).fetchone()[0] == "ok"
    with admin() as c:
        i = c.execute("SELECT id FROM radius.session WHERE acct_session_id = %s", (sid,)).fetchone()[0]
    return i, sid, code


def _a_couper(i: int) -> None:
    with admin() as c:
        c.execute("UPDATE radius.session SET a_couper_le = now(), motif_coupure = 'volume_epuise' WHERE id = %s", (i,))


def _candidats() -> dict[int, str]:
    with en_tant_que_coa() as c:
        return dict(c.execute("SELECT session_id, motif FROM radius.sessions_to_cut(1000)").fetchall())


def _marquer(i: int, resultat: str) -> str:
    with en_tant_que_coa() as c:
        return c.execute("SELECT radius.mark_cut(%s, %s)", (i, resultat)).fetchone()[0]


def test_session_inscrite_a_couper_rendue_avec_son_motif_puis_retiree_apres_ack():
    i, _, _ = _session()
    assert i not in _candidats()
    _a_couper(i)
    assert _candidats()[i] == "volume_epuise"
    assert _marquer(i, "ack") == "ack"
    assert i not in _candidats()


def test_nak_retire_la_session_le_silence_la_garde():
    i, _, _ = _session()
    _a_couper(i)
    assert _marquer(i, "sans_reponse") == "sans_reponse"
    assert i in _candidats()
    assert _marquer(i, "nak") == "nak"   # le routeur ne connaît pas (plus) la session
    assert i not in _candidats()


def test_abandon_apres_le_nombre_maximal_de_tours_et_une_seule_alerte():
    i, _, _ = _session()
    _a_couper(i)
    with admin() as c:
        avant = c.execute("SELECT count(*) FROM radius.alerte WHERE type = 'coupure_abandonnee'").fetchone()[0]
        maximum = int(c.execute("SELECT valeur FROM radius.parametre WHERE cle = 'coupure_tentatives_max'").fetchone()[0])
    resultats = [_marquer(i, "sans_reponse") for _ in range(maximum)]
    assert resultats == ["sans_reponse"] * (maximum - 1) + ["abandon"]
    assert i not in _candidats()
    with admin() as c:
        assert c.execute("SELECT count(*) FROM radius.alerte WHERE type = 'coupure_abandonnee'").fetchone()[0] == avant + 1
        assert c.execute("SELECT coupure_tentatives FROM radius.session WHERE id = %s", (i,)).fetchone()[0] == maximum


def test_proprietaire_suspendu_ses_sessions_vivantes_sont_a_couper():
    i, _, _ = _session()
    assert i not in _candidats()
    try:
        with admin() as c:
            c.execute("UPDATE app.tenant SET suspendu = true WHERE id = 3")
        assert _candidats()[i] == "proprietaire_suspendu"
    finally:
        with admin() as c:
            c.execute("UPDATE app.tenant SET suspendu = false WHERE id = 3")
    assert i not in _candidats()


def test_session_arretee_jamais_rendue():
    i, _, _ = _session()
    _a_couper(i)
    with admin() as c:
        c.execute("UPDATE radius.session SET arrete_le = now(), cause_fin = 'User-Request' WHERE id = %s", (i,))
    assert i not in _candidats()


def test_coa_target_rend_ip_port_secret_session_et_code():
    i, sid, code = _session()
    with en_tant_que_coa() as c:
        (ip, port, secret, acct_sid, user), = c.execute("SELECT * FROM radius.coa_target(%s)", (i,)).fetchall()
        assert c.execute("SELECT * FROM radius.coa_target(-1)").fetchall() == []
    with admin() as c:
        attendu = c.execute("""SELECT host(r.overlay_ip), r.coa_port, rs.secret FROM app.router r
                                 JOIN radius.router_secret rs ON rs.router_id = r.id WHERE r.overlay_ip = %s""",
                            (C4,)).fetchone()
    assert (ip, port, secret) == attendu and port == 1700
    assert (acct_sid, user) == (sid, code)


def test_seul_wk_coa_lit_le_secret_par_session():
    i, _, _ = _session()
    with en_tant_que_radius() as c:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("SELECT * FROM radius.coa_target(%s)", (i,))
    with en_tant_que_acct() as c:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("SELECT * FROM radius.coa_target(%s)", (i,))


@pytest.mark.parametrize("resultat", ["", "ACK", "abandon", "ok"])
def test_mark_cut_refuse_un_resultat_inconnu(resultat):
    i, _, _ = _session()
    with en_tant_que_coa() as c:
        with pytest.raises(psycopg.errors.RaiseException):
            c.execute("SELECT radius.mark_cut(%s, %s)", (i, resultat))


def test_mark_cut_refuse_une_session_inconnue():
    with en_tant_que_coa() as c:
        with pytest.raises(psycopg.errors.RaiseException):
            c.execute("SELECT radius.mark_cut(-1, 'ack')")


def test_wk_coa_journal_sans_instruction_et_delai():
    with admin() as c:
        conf = c.execute("SELECT rolconfig FROM pg_roles WHERE rolname = 'wk_coa'").fetchone()[0]
    assert {"statement_timeout=5s", "log_min_error_statement=panic", "log_min_duration_statement=-1",
            "log_statement=none"} <= set(conf)


def test_mark_cut_sans_effet_sur_un_etat_final():
    i, _, _ = _session()
    _a_couper(i)
    assert _marquer(i, "ack") == "ack"
    assert _marquer(i, "sans_reponse") == "ack"      # un tour tardif n'écrase pas l'acquittement
    with admin() as c:
        assert c.execute("SELECT coupure_resultat, coupure_tentatives FROM radius.session WHERE id = %s",
                         (i,)).fetchone() == ("ack", 1)


def test_jamais_tentee_passe_devant_une_session_deja_tentee():
    deja, _, _ = _session()
    _a_couper(deja)
    _marquer(deja, "sans_reponse")
    nouvelle, _, _ = _session()
    _a_couper(nouvelle)
    with en_tant_que_coa() as c:
        ordre = [r[0] for r in c.execute("SELECT session_id FROM radius.sessions_to_cut(1000)").fetchall()]
    assert ordre.index(nouvelle) < ordre.index(deja)
