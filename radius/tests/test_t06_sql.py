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
    # Idempotent : un second passage ne touche pas une session déjà fermée.
    fantomes()
    assert (session(vieux)[0]["arrete_le"], session(vieux)[0]["cause_fin"]) == (v["arrete_le"], "Fantome")
    # Un Interim tardif met à jour les compteurs sans rouvrir.
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


# --- Avancement du lecteur et script planifié (revue du ticket 06) ---------------

def _battement(age_recu: int, age_vide: int) -> None:
    with admin() as c:
        c.execute("""UPDATE radius.lecteur_battement SET dernier_recu = now() - %s * interval '1 second',
                            spool_vide_le = now() - %s * interval '1 second', traite_le = now()""", (age_recu, age_vide))


def _script(spool):
    env = {**os.environ, "WAKATNET_SPOOL": spool, "WAKATNET_PG_HOST": "172.29.215.5"}
    return subprocess.run(["sh", SCRIPT], capture_output=True, text=True, env=env, timeout=30)


def test_fermeture_mesuree_sur_l_avancement_du_lecteur_et_non_sur_l_heure():
    """Lecteur en retard de 1000 s : une session silencieuse depuis 361 s peut avoir des Interim
    encore dans le spool ; elle n'est pas fermée tant que le lecteur n'a pas avancé."""
    code, sid = nouveau_ticket(), _sid()
    acct("acct_interim", sid, code, duree=10)
    vieillir(sid, 3 * 120 + 1)
    try:
        _battement(1000, 1000)
        fantomes()
        assert session(sid)[0]["arrete_le"] is None
        _battement(0, 1000)          # le lecteur a rejoué jusqu'à maintenant
        fantomes()
        assert session(sid)[0]["cause_fin"] == "Fantome"
    finally:
        _battement(0, 0)


def test_script_marque_le_spool_vide_seulement_s_il_l_est():
    code, sid = nouveau_ticket(), _sid()
    acct("acct_interim", sid, code, duree=10)
    vieillir(sid, 3 * 120 + 1)
    try:
        _battement(1000, 1000)       # seul le constat « spool vide » peut faire avancer le repère
        with tempfile.TemporaryDirectory() as racine:
            spool = os.path.join(racine, "wakatnet")
            os.mkdir(spool)
            for attente in ("detail-20261111:10", "detail.work"):
                chemin = os.path.join(spool, attente)
                open(chemin, "w").close()
                r = _script(spool)
                assert r.returncode == 0 and "spool vide=non" in r.stdout, r
                assert session(sid)[0]["arrete_le"] is None
                os.remove(chemin)
            r = _script(spool)
            assert r.returncode == 0 and "spool vide=oui" in r.stdout, r
            assert session(sid)[0]["cause_fin"] == "Fantome"
            # Répertoire du spool pas encore créé (aucun accounting) : vide, normal.
            os.rmdir(spool)
            assert _script(spool).returncode == 0
        assert os.environ["WAKATNET_PG_MAINT_PASSWORD"] not in r.stdout + r.stderr
    finally:
        _battement(0, 0)


def test_script_spool_introuvable_ne_fait_rien():
    code, sid = nouveau_ticket(), _sid()
    acct("acct_interim", sid, code, duree=10)
    vieillir(sid, 3 * 120 + 1)
    try:
        _battement(1000, 1000)
        r = _script("/chemin/inexistant/wakatnet")
        assert r.returncode != 0 and "introuvable" in r.stderr
        with admin() as c:
            assert c.execute("SELECT now() - spool_vide_le > interval '900 seconds' FROM radius.lecteur_battement").fetchone()[0]
        assert session(sid)[0]["arrete_le"] is None
    finally:
        _battement(0, 0)


def test_fantome_qui_reparle_compte_comme_appareil_et_peut_etre_coupe():
    """Revue du ticket 06 : une session fermée d'office mais vivante (Interim tardifs) compte encore
    comme appareil et peut être inscrite « à couper » ; un vrai Stop corrige ensuite l'arrêt."""
    code, sid = nouveau_ticket(plan_id=1), _sid()
    acct("acct_interim", sid, code, duree=100, calling="AA-BB-CC-00-07-01")
    vieillir(sid, 3 * 120 + 1)
    fantomes()
    assert session(sid)[0]["cause_fin"] == "Fantome"
    arret_d_office = session(sid)[0]["arrete_le"]
    assert autoriser(code, "AA-BB-CC-00-07-02") == ("Accept", None)
    acct("acct_interim", sid, code, duree=200, calling="AA-BB-CC-00-07-01")       # elle reparle
    assert autoriser(code, "AA-BB-CC-00-07-02") == ("Reject", "trop_d_appareils")
    acct("acct_interim", sid, code, duree=3600, calling="AA-BB-CC-00-07-01")      # temps épuisé
    assert session(sid)[0]["motif_coupure"] == "temps_epuise"
    acct("acct_stop", sid, code, duree=3601, calling="AA-BB-CC-00-07-01")
    s = session(sid)[0]
    assert s["cause_fin"] is None and s["arrete_le"] > arret_d_office          # arrêt corrigé par le Stop


def test_accept_suivi_d_un_start_puis_d_un_stop_libere_la_place():
    """Clause « Accept sans Start » : l'Accept d'un appareil dont la session a démarré puis s'est
    arrêtée ne compte plus, même dans la fenêtre."""
    code, sid = nouveau_ticket(plan_id=1), _sid()
    _accept_ancien(code, "AA-BB-CC-00-0A-01", 0)
    acct("acct_start", sid, code, calling="AA-BB-CC-00-0A-01")
    acct("acct_stop", sid, code, calling="AA-BB-CC-00-0A-01", duree=5)
    assert autoriser(code, "AA-BB-CC-00-0A-02") == ("Accept", None)


def test_bind_mac_posee_par_l_accounting_si_post_auth_n_a_pas_ecrit():
    code = nouveau_ticket(plan_id=9)
    acct("acct_start", _sid(), code, calling="aa:bb:cc:00:0b:01")
    with admin() as c:
        assert c.execute("SELECT mac_liee FROM app.voucher WHERE tenant_id = 1 AND code = %s",
                         (code,)).fetchone() == ("AABBCC000B01",)


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
    try:
        _battement(100, 100)          # lecteur en retard (ou bloqué) depuis 100 s
        assert autoriser(code, "AA-BB-CC-00-09-02") == ("Reject", "trop_d_appareils")   # 90 s < 60 + 100
    finally:
        _battement(0, 0)


def test_battement_mis_a_jour_par_le_lecteur():
    code = nouveau_ticket()
    with admin() as c:
        t = int(c.execute("SELECT extract(epoch FROM now())").fetchone()[0]) - 30
    try:
        _battement(1000, 1000)   # le battement ne recule jamais : partir d'un repère plus ancien
        acct("acct_interim", _sid(), code, recu=t)
        with admin() as c:
            retard = c.execute("SELECT extract(epoch FROM traite_le - dernier_recu) FROM radius.lecteur_battement").fetchone()[0]
        assert 29 <= retard <= 40
    finally:   # ne pas laisser un retard qui élargirait la fenêtre des autres tests
        _battement(0, 0)
