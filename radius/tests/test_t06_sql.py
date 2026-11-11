"""Sessions fantômes (T8), acct_on_off, fenêtre des Accept et retard du lecteur — ticket 06, en SQL.

Ticket : .scratch/phase-1-coeur-radius/issues/06-sessions.md
Forme (d) de l'ADR 0007 : instants datés dans le passé par le superutilisateur ; fonctions
appelées par leurs rôles de production (wk_maint, wk_acct, wk_radius).
"""
import os
import subprocess
import tempfile
import uuid

from conftest import ROUTEURS, admin, en_tant_que_acct, en_tant_que_maint, en_tant_que_radius, nouveau_ticket

R1, R2 = ROUTEURS["r1"][0], ROUTEURS["r2"][0]
SCRIPT = "/depot/infra/maintenance/wakatnet-fantomes.sh"


def _sid():
    return uuid.uuid4().hex[:16]


def acct(fonction, sid, code, *, src=R1, duree=0, recu=None, calling="AA-BB-CC-00-06-09"):
    with admin() as c:
        recu = recu or int(c.execute("SELECT extract(epoch FROM now())").fetchone()[0])
    with en_tant_que_acct() as c:
        return c.execute(f"SELECT radius.{fonction}(%s, %s, %s, %s, '', '', '', '', '', %s, '', %s)",
                         (src, sid, code, calling, str(duree), str(recu))).fetchone()[0]


def on_off(src, recu):
    with en_tant_que_acct() as c:
        return c.execute("SELECT radius.acct_on_off(%s, %s)", (src, str(recu))).fetchone()[0]


def session(sid):
    with admin() as c:
        cur = c.execute("SELECT * FROM radius.session WHERE acct_session_id = %s ORDER BY id", (sid,))
        return [dict(zip([d.name for d in cur.description], l)) for l in cur.fetchall()]


def vieillir(sid, secondes):
    with admin() as c:
        c.execute("""UPDATE radius.session SET dernier_evenement_le = dernier_evenement_le - %s * interval '1 second'
                      WHERE acct_session_id = %s""", (secondes, sid))


def fantomes() -> int:
    with en_tant_que_maint() as c:
        return c.execute("SELECT radius.close_ghost_sessions()").fetchone()[0]


def autoriser(code, calling, src=R1):
    with en_tant_que_radius() as c:
        return c.execute("SELECT decision, reply_message FROM radius.authorize(%s, %s, %s, '')",
                         (code, src, calling)).fetchone()


# --- T8 : sessions fantômes --------------------------------------------------

def test_t8_session_sans_interim_depuis_trois_intervalles_fermee_temps_conserve():
    code, frais, vieux = nouveau_ticket(), _sid(), _sid()
    assert acct("acct_interim", vieux, code, duree=600) == "ok"
    assert acct("acct_interim", frais, code, duree=60) == "ok"
    vieillir(vieux, 3 * 120 + 1)
    vieillir(frais, 3 * 120 - 5)
    assert fantomes() >= 1
    v, f = session(vieux)[0], session(frais)[0]
    assert v["arrete_le"] == v["dernier_evenement_le"] and v["cause_fin"] == "Fantome" and v["duree_s"] == 600
    assert f["arrete_le"] is None
    # Idempotent ; puis un Interim tardif met à jour les compteurs sans rouvrir.
    assert fantomes() == 0 or session(vieux)[0]["arrete_le"] == v["arrete_le"]
    assert acct("acct_interim", vieux, code, duree=700) == "ok"
    v2 = session(vieux)[0]
    assert (v2["duree_s"], v2["arrete_le"]) == (700, v["arrete_le"])


def test_t8_reconnexion_acceptee_apres_fermeture_d_office():
    code, sid = nouveau_ticket(), _sid()
    acct("acct_interim", sid, code, duree=100, calling="AA-BB-CC-00-08-01")
    assert autoriser(code, "AA-BB-CC-00-08-02") == ("Reject", "trop_d_appareils")
    vieillir(sid, 3 * 120 + 1)
    fantomes()
    assert autoriser(code, "AA-BB-CC-00-08-02") == ("Accept", None)


def test_intervalle_memorise_sur_la_session_fait_foi():
    code, sid = nouveau_ticket(), _sid()
    acct("acct_interim", sid, code)
    with admin() as c:
        c.execute("UPDATE radius.session SET interim_s = 600 WHERE acct_session_id = %s", (sid,))
    vieillir(sid, 3 * 120 + 1)                      # dépasse 3 × 120, pas 3 × 600
    fantomes()
    assert session(sid)[0]["arrete_le"] is None


# --- Script planifié : aucune fermeture tant que le detail n'est pas vidé ------

def _script(spool):
    env = {**os.environ, "WAKATNET_SPOOL": spool, "WAKATNET_PG_HOST": "172.29.215.5"}
    return subprocess.run(["sh", SCRIPT], capture_output=True, text=True, env=env, timeout=30)


def test_script_ne_ferme_rien_pendant_un_rejeu_puis_ferme_spool_vide():
    code, sid = nouveau_ticket(), _sid()
    acct("acct_interim", sid, code, duree=10)
    vieillir(sid, 3 * 120 + 1)
    with tempfile.TemporaryDirectory() as spool:
        for attente in ("detail-20261111:10", "detail.work"):
            chemin = os.path.join(spool, attente)
            open(chemin, "w").close()
            r = _script(spool)
            assert r.returncode == 0 and "rejeu en cours" in r.stdout, r
            assert session(sid)[0]["arrete_le"] is None
            os.remove(chemin)
        r = _script(spool)
    assert r.returncode == 0, r.stderr
    assert session(sid)[0]["arrete_le"] is not None
    assert os.environ["WAKATNET_PG_MAINT_PASSWORD"] not in r.stdout + r.stderr


def test_unites_systemd_valides():
    r = subprocess.run(["systemd-analyze", "verify", "--man=no",
                        "/depot/infra/systemd/wakatnet-fantomes.service", "/depot/infra/systemd/wakatnet-fantomes.timer"],
                       capture_output=True, text=True, timeout=60)
    # Seule absence tolérée : l'exécutable, installé sur le nœud et non dans le conteneur de test.
    erreurs = [l for l in (r.stdout + r.stderr).splitlines()
               if l.strip() and "/usr/local/sbin/wakatnet-fantomes" not in l]
    assert erreurs == [], erreurs


# --- acct_on_off ---------------------------------------------------------------

def test_acct_on_off_idempotent_et_nouvelles_sessions_preservees():
    code, avant, apres = nouveau_ticket(plan_id=8), _sid(), _sid()
    with admin() as c:
        t = int(c.execute("SELECT extract(epoch FROM now())").fetchone()[0])
        epoque = c.execute("SELECT epoch FROM app.router WHERE shortname = 'r2'").fetchone()[0]
    acct("acct_start", avant, code, src=R2, recu=t)
    assert on_off(R2, t + 1) == "ok"
    acct("acct_start", apres, code, src=R2, recu=t + 2)
    assert on_off(R2, t + 1) == "ok"                 # le même On, rejoué
    assert session(avant)[0]["arrete_le"] is not None
    assert session(apres)[0]["arrete_le"] is None    # démarrée après le On : reste ouverte
    with admin() as c:
        assert c.execute("SELECT epoch FROM app.router WHERE shortname = 'r2'").fetchone()[0] == epoque + 1


def test_acct_on_off_donnee_invalide_en_quarantaine():
    assert on_off("pas-une-ip", 1_900_000_000) == "quarantaine"
    assert on_off(R2, "") == "quarantaine"


# --- Fenêtre des Accept et retard du lecteur (ADR 0006 §9) ---------------------

def _accept_ancien(code, mac, secondes):
    with en_tant_que_radius() as c:
        c.execute("SELECT radius.post_auth(%s, %s, %s, 'Accept', '')", (code, R1, mac))
    with admin() as c:
        c.execute("""UPDATE radius.auth_log SET at = now() - %s * interval '1 second'
                      WHERE id = (SELECT max(id) FROM radius.auth_log)""", (secondes,))


def test_accept_sans_start_compte_60_s_prolonges_du_retard_du_lecteur():
    code = nouveau_ticket()
    _accept_ancien(code, "AA-BB-CC-00-09-01", 90)
    assert autoriser(code, "AA-BB-CC-00-09-02") == ("Accept", None)       # 90 s > 60 s, lecteur à jour
    with admin() as c:
        c.execute("UPDATE radius.lecteur_battement SET dernier_recu = now() - interval '100 seconds', traite_le = now()")
    try:
        assert autoriser(code, "AA-BB-CC-00-09-02") == ("Reject", "trop_d_appareils")   # 90 s < 60 + 100
    finally:
        with admin() as c:
            c.execute("UPDATE radius.lecteur_battement SET dernier_recu = now(), traite_le = now()")


def test_battement_mis_a_jour_par_le_lecteur():
    code = nouveau_ticket()
    with admin() as c:
        t = int(c.execute("SELECT extract(epoch FROM now())").fetchone()[0]) - 30
    try:
        acct("acct_interim", _sid(), code, recu=t)
        with admin() as c:
            retard = c.execute("SELECT extract(epoch FROM traite_le - dernier_recu) FROM radius.lecteur_battement").fetchone()[0]
        assert 29 <= retard <= 40
    finally:   # ne pas laisser un retard qui élargirait la fenêtre des autres tests
        with admin() as c:
            c.execute("UPDATE radius.lecteur_battement SET dernier_recu = now(), traite_le = now()")
