"""radius.acct_* appelées directement par wk_acct (rôle du lecteur detail) — ticket 04.

Ticket : .scratch/phase-1-coeur-radius/issues/04-accounting-decouple.md
Contrats : ADR 0006 §1 (paramètres en texte, 'ok' ou 'quarantaine'), §7, §8.
Les instants de réception sont passés en époque (secondes), comme %{integer:Packet-Original-Timestamp}.
"""
from __future__ import annotations

import random
import uuid
from datetime import datetime, timezone

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from conftest import ROUTEURS, admin, en_tant_que_acct, nouveau_ticket

R1 = ROUTEURS["r1"][0]
T0 = 1_900_000_000            # instant de réception de référence (2030)
GIO4 = 2 ** 32


def acct(fonction, *, src=R1, sid, user, calling="AA-BB-CC-00-00-01", framed="10.5.50.2",
         in_oct="", in_giga="", out_oct="", out_giga="", duree="", cause="", recu=T0) -> str:
    with en_tant_que_acct() as c:
        return c.execute(
            f"SELECT radius.{fonction}(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (src, sid, user, calling, framed, str(in_oct), str(in_giga), str(out_oct), str(out_giga),
             str(duree), cause, str(recu))).fetchone()[0]


def session(code: str, sid: str) -> dict | None:
    with admin() as c:
        cur = c.execute("""SELECT s.* FROM radius.session s JOIN app.voucher v ON v.id = s.voucher_id
                            WHERE v.tenant_id = 1 AND v.code = %s AND s.acct_session_id = %s""", (code, sid))
        lignes = cur.fetchall()
        assert len(lignes) <= 1
        return dict(zip([d.name for d in cur.description], lignes[0])) if lignes else None


def _sid() -> str:
    return uuid.uuid4().hex[:16]


def _decouper(total: int) -> tuple[str, str]:
    return str(total % GIO4), str(total // GIO4)


# --- Idempotence et règles de l'ADR 0006 §8 ---------------------------------

def test_start_rejoue_sans_effet_et_activation_a_la_reception():
    code, sid = nouveau_ticket(), _sid()
    assert acct("acct_start", sid=sid, user=code, recu=T0) == "ok"
    assert acct("acct_start", sid=sid, user=code, recu=T0 + 50) == "ok"
    s = session(code, sid)
    assert s["started_at"] == datetime.fromtimestamp(T0, timezone.utc)
    with admin() as c:
        assert c.execute("SELECT activated_at FROM app.voucher WHERE tenant_id = 1 AND code = %s",
                         (code,)).fetchone()[0] == datetime.fromtimestamp(T0, timezone.utc)
        assert c.execute("""SELECT count(*) FROM radius.activation a JOIN app.voucher v ON v.id = a.voucher_id
                             WHERE v.code = %s""", (code,)).fetchone()[0] == 1


def test_stop_deux_fois_et_interim_apres_stop():
    code, sid = nouveau_ticket(), _sid()
    acct("acct_start", sid=sid, user=code)
    assert acct("acct_stop", sid=sid, user=code, in_oct=500, out_oct=900, duree=30, cause="User-Request",
                recu=T0 + 30) == "ok"
    premier = session(code, sid)
    assert acct("acct_stop", sid=sid, user=code, in_oct=500, out_oct=900, duree=30, cause="Lost-Carrier",
                recu=T0 + 40) == "ok"
    assert acct("acct_interim", sid=sid, user=code, in_oct=100, out_oct=100, duree=10, recu=T0 + 50) == "ok"
    s = session(code, sid)
    for k in ("octets_montants", "octets_descendants", "duree_s", "arrete_le", "cause_fin"):
        assert s[k] == premier[k], k
    assert s["arrete_le"] == datetime.fromtimestamp(T0 + 30, timezone.utc)


def test_interim_apres_stop_avec_compteurs_plus_grands_met_a_jour_sans_rouvrir():
    """ADR 0006 §8 : Interim ou Stop après une fermeture → compteurs mis à jour, session non rouverte."""
    code, sid = nouveau_ticket(), _sid()
    acct("acct_start", sid=sid, user=code)
    acct("acct_stop", sid=sid, user=code, in_oct=500, out_oct=900, duree=30, recu=T0 + 30)
    acct("acct_interim", sid=sid, user=code, in_oct=800, out_oct=1200, duree=45, recu=T0 + 60)
    s = session(code, sid)
    assert (s["octets_montants"], s["octets_descendants"], s["duree_s"]) == (800, 1200, 45)
    assert s["arrete_le"] == datetime.fromtimestamp(T0 + 30, timezone.utc)


def test_intervalle_interim_memorise_sur_la_session():
    code, sid = nouveau_ticket(), _sid()
    acct("acct_start", sid=sid, user=code)
    assert session(code, sid)["interim_s"] == 120


def test_routeur_desactive_continue_de_comptabiliser():
    """Un routeur désactivé après l'ouverture d'une session : la consommation reste comptée."""
    code, sid = nouveau_ticket(), _sid()
    with admin() as c:
        c.execute("UPDATE app.router SET actif = false WHERE shortname = 'r2'")
    try:
        assert acct("acct_start", src=ROUTEURS["r2"][0], sid=sid, user=code) == "ok"
    finally:
        with admin() as c:
            c.execute("UPDATE app.router SET actif = true WHERE shortname = 'r2'")
    assert session(code, sid) is not None


# --- Jamais d'exception : quarantaine ---------------------------------------

@pytest.mark.parametrize("champs, motif", [
    ({"src": "pas-une-ip"}, "routeur_inconnu"),
    ({"src": "10.213.9.99"}, "routeur_inconnu"),
    ({"sid": ""}, "session_invalide"),
    ({"sid": "S" * 65}, "session_invalide"),
    ({"user": ""}, "utilisateur_invalide"),
    ({"user": "X" * 65}, "utilisateur_invalide"),
    ({"user": "ZZZZZZZZ"}, "ticket_inconnu"),
    ({"in_oct": "abc"}, "donnee_invalide"),
    ({"in_oct": "-1"}, "donnee_invalide"),
    ({"in_oct": str(GIO4)}, "donnee_invalide"),
    ({"out_giga": "1.5"}, "donnee_invalide"),
    ({"duree": "1e3"}, "donnee_invalide"),
    ({"recu": ""}, "donnee_invalide"),
    ({"recu": "demain"}, "donnee_invalide"),
    ({"recu": "99999999999999999999"}, "donnee_invalide"),
    ({"framed": "pas-une-ip"}, "donnee_invalide"),
])
@pytest.mark.parametrize("fonction", ["acct_start", "acct_interim", "acct_stop"])
def test_donnee_invalide_mise_en_quarantaine_jamais_d_exception(fonction, champs, motif):
    code = nouveau_ticket()
    params = {"sid": _sid(), "user": code, **champs}
    with admin() as c:
        avant = c.execute("SELECT coalesce(max(id), 0) FROM radius.acct_quarantaine").fetchone()[0]
    assert acct(fonction, **params) == "quarantaine"
    with admin() as c:
        lignes = c.execute("SELECT fonction, motif, donnees ? 'p_user' FROM radius.acct_quarantaine WHERE id > %s",
                           (avant,)).fetchall()
    assert lignes == [(fonction, motif, True)]


def test_champs_absents_valent_zero():
    """Un Start n'a pas de compteurs ; un routeur peut ne pas envoyer de gigawords."""
    code, sid = nouveau_ticket(), _sid()
    assert acct("acct_start", sid=sid, user=code, framed="") == "ok"
    s = session(code, sid)
    assert (s["octets_montants"], s["octets_descendants"], s["duree_s"], s["framed_ip"]) == (0, 0, 0, None)


def test_code_en_minuscules_rapproche_du_ticket():
    code, sid = nouveau_ticket(), _sid()
    assert acct("acct_start", sid=sid, user=code.lower()) == "ok"
    assert session(code, sid) is not None


# --- Sens des octets (C2 : réglage en SQL) -----------------------------------

def test_sens_des_octets_regle_par_parametre():
    code, sid = nouveau_ticket(), _sid()
    with admin() as c:
        assert c.execute("SELECT valeur FROM radius.parametre WHERE cle = 'acct_input_octets_sens'").fetchone() == ("montant",)
        c.execute("UPDATE radius.parametre SET valeur = 'descendant' WHERE cle = 'acct_input_octets_sens'")
    try:
        acct("acct_interim", sid=sid, user=code, in_oct=11, out_oct=22)
    finally:
        with admin() as c:
            c.execute("UPDATE radius.parametre SET valeur = 'montant' WHERE cle = 'acct_input_octets_sens'")
    s = session(code, sid)
    assert (s["octets_montants"], s["octets_descendants"]) == (22, 11)


# --- Propriété : Interim rejoués et dans le désordre ------------------------

@st.composite
def historique(draw):
    """Totaux cumulés vrais (croissants) d'une session, puis une livraison désordonnée et dupliquée.
    Avec gigawords : jusqu'à ~64 Gio. Sans gigawords : le routeur n'en envoie pas, totaux < 4 Gio."""
    avec_giga = draw(st.booleans())
    borne = 2 ** 36 if avec_giga else GIO4 - 1
    n = draw(st.integers(1, 12))
    montants = sorted(draw(st.lists(st.integers(0, borne), min_size=n, max_size=n)))
    descendants = sorted(draw(st.lists(st.integers(0, borne), min_size=n, max_size=n)))
    durees = sorted(draw(st.lists(st.integers(0, 10 ** 6), min_size=n, max_size=n)))
    evenements = list(zip(montants, descendants, durees))
    livraison = evenements + draw(st.lists(st.sampled_from(evenements), max_size=6))
    graine = draw(st.integers(0, 2 ** 32))
    random.Random(graine).shuffle(livraison)
    if avec_giga:   # au moins un cas franchit 4 Gio
        livraison.append((GIO4 + 1, GIO4 + 2, durees[-1]))
    return avec_giga, livraison


@settings(max_examples=60, deadline=None, database=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(h=historique())
def test_propriete_total_final_egale_le_plus_grand_cumul(h):
    avec_giga, livraison = h
    code, sid = nouveau_ticket(), _sid()
    for i, (m, d, t) in enumerate(livraison):
        mo, mg = _decouper(m)
        do, dg = _decouper(d)
        r = acct("acct_interim", sid=sid, user=code, in_oct=mo, in_giga=mg if avec_giga else "",
                 out_oct=do, out_giga=dg if avec_giga else "", duree=t, recu=T0 + i)
        assert r == "ok"
    s = session(code, sid)
    assert s["octets_montants"] == max(m for m, _, _ in livraison)
    assert s["octets_descendants"] == max(d for _, d, _ in livraison)
    assert s["duree_s"] == max(t for _, _, t in livraison)
    with admin() as c:
        assert c.execute("""SELECT count(*) FROM radius.acct_cle k JOIN app.voucher v ON upper(k.username) = v.code
                             WHERE v.tenant_id = 1 AND v.code = %s""", (code,)).fetchone()[0] == 1
