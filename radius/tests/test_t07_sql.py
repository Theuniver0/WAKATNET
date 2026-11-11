"""Anti-devinette, alerte par routeur et purge de auth_log, en SQL — ticket 07.

Ticket : .scratch/phase-1-coeur-radius/issues/07-anti-devinette.md ; ADR 0006 §11 ; ADR 0005 (90 jours).
Forme (d) de l'ADR 0007 : lignes de auth_log datées dans le passé par le superutilisateur.
"""
import os
import subprocess
import uuid

from conftest import ROUTEURS, admin, en_tant_que_maint, en_tant_que_radius, nouveau_ticket

R1, R2 = ROUTEURS["r1"][0], ROUTEURS["r2"][0]


def _mac():
    return "02" + uuid.uuid4().hex[:10].upper()


def echecs(mac, ages, routeur="r1", cause="ticket_inconnu"):
    """Inscrit des Reject datés de maintenant − âge (secondes)."""
    with admin() as c:
        for age in ages:
            c.execute("""INSERT INTO radius.auth_log (at, router_id, tenant_id, mac, resultat, cause)
                         SELECT now() - %s * interval '1 second', r.id, r.tenant_id, %s, 'Reject', %s
                           FROM app.router r WHERE r.shortname = %s""", (age, mac, cause, routeur))


def decider(code, mac, src=R1):
    with en_tant_que_radius() as c:
        return c.execute("SELECT decision, reply_message FROM radius.authorize(%s, %s, %s, '')",
                         (code, src, mac)).fetchone()


# --- Blocage par MAC ---------------------------------------------------------

def test_dix_echecs_en_60_s_bloquent():
    code, mac = nouveau_ticket(), _mac()
    echecs(mac, [50 - 5 * i for i in range(10)])           # 10 échecs entre −50 s et −5 s
    assert decider(code, mac) == ("Reject", "trop_de_tentatives")


def test_neuf_echecs_ne_bloquent_pas():
    code, mac = nouveau_ticket(), _mac()
    echecs(mac, [50 - 5 * i for i in range(9)])
    assert decider(code, mac) == ("Accept", None)


def test_dix_echecs_etales_sur_plus_de_60_s_ne_bloquent_pas():
    code, mac = nouveau_ticket(), _mac()
    echecs(mac, [10 + 13 * i for i in range(10)])          # 10 échecs sur 117 s : jamais 10 en 60 s
    assert decider(code, mac) == ("Accept", None)


def test_blocage_dure_5_min_apres_la_rafale():
    code, mac, mac2 = nouveau_ticket(), _mac(), _mac()
    echecs(mac, [290 + i for i in range(10)])              # rafale finie il y a 290 s : bloqué
    assert decider(code, mac) == ("Reject", "trop_de_tentatives")
    echecs(mac2, [302 + i for i in range(10)])             # finie il y a 302 s : libéré
    assert decider(code, mac2) == ("Accept", None)


def test_seuls_les_echecs_ticket_inconnu_comptent():
    code, mac = nouveau_ticket(), _mac()
    echecs(mac, [10] * 10, cause="expire")
    echecs(mac, [10] * 10, cause="trop_de_tentatives")
    assert decider(code, mac) == ("Accept", None)


def test_blocage_par_routeur_la_meme_mac_ailleurs_passe():
    code, mac = nouveau_ticket(), _mac()
    echecs(mac, [10] * 10, routeur="r2")
    assert decider(code, mac, src=R2) == ("Reject", "trop_de_tentatives")
    assert decider(code, mac, src=R1) == ("Accept", None)


def test_mac_illisible_jamais_bloquee():
    code = nouveau_ticket()
    echecs("", [10] * 12)
    assert decider(code, "pas-une-mac") == ("Accept", None)


def test_ordre_trop_de_tentatives_avant_ticket_inconnu():
    mac = _mac()
    echecs(mac, [10] * 10)
    assert decider("ZZZZZZZZ", mac) == ("Reject", "trop_de_tentatives")


def test_seuils_reglables():
    code, mac = nouveau_ticket(), _mac()
    echecs(mac, [10] * 5)
    with admin() as c:
        c.execute("UPDATE radius.parametre SET valeur = '5' WHERE cle = 'devinette_echecs_par_mac'")
    try:
        assert decider(code, mac) == ("Reject", "trop_de_tentatives")
    finally:
        with admin() as c:
            c.execute("UPDATE radius.parametre SET valeur = '10' WHERE cle = 'devinette_echecs_par_mac'")
    assert decider(code, mac) == ("Accept", None)


# --- Alertes inscrites par post_auth ------------------------------------------

def _alertes(type_, routeur):
    with admin() as c:
        return c.execute("""SELECT count(*) FROM radius.alerte a JOIN app.router r ON r.id = a.router_id
                             WHERE a.type = %s AND r.shortname = %s AND a.at > now() - interval '1 minute'""",
                         (type_, routeur)).fetchone()[0]


def test_cent_echecs_par_routeur_en_60_s_alerte_unique_sans_blocage():
    code = nouveau_ticket()
    with admin() as c:
        c.execute("""DELETE FROM radius.alerte WHERE type = 'echecs_routeur'
                       AND router_id = (SELECT id FROM app.router WHERE shortname = 'r5')""")
    def echecs_r5(debut, fin):
        with en_tant_que_radius() as c:
            for i in range(debut, fin):
                c.execute("SELECT radius.post_auth('ZZZZZZZZ', %s, %s, 'Reject', 'ticket_inconnu')",
                          (ROUTEURS["r5"][0], f"02-00-00-00-{i // 256:02X}-{i % 256:02X}"))
    echecs_r5(0, 99)
    assert _alertes("echecs_routeur", "r5") == 0           # 99 échecs : sous le seuil
    echecs_r5(99, 100)
    assert _alertes("echecs_routeur", "r5") == 1           # le 100e déclenche
    echecs_r5(100, 120)
    assert _alertes("echecs_routeur", "r5") == 1           # une seule, malgré 20 échecs de plus
    # Aucun blocage : un appareil neuf du même routeur, avec un code valide, est accepté.
    assert decider(code, _mac(), src=ROUTEURS["r5"][0]) == ("Accept", None)


# --- Purge de auth_log à 90 jours (ADR 0005) ----------------------------------

def test_purge_90_jours_idempotente_et_journalisee():
    mac_vieux, mac_jeune = _mac(), _mac()
    echecs(mac_vieux, [91 * 86400])
    echecs(mac_jeune, [89 * 86400])
    with en_tant_que_maint() as c:
        supprimees = c.execute("SELECT radius.purge_auth_log()").fetchone()[0]
        assert supprimees >= 1
        assert c.execute("SELECT radius.purge_auth_log()").fetchone()[0] == 0
    with admin() as c:
        assert c.execute("SELECT count(*) FROM radius.auth_log WHERE mac = %s", (mac_vieux,)).fetchone()[0] == 0
        assert c.execute("SELECT count(*) FROM radius.auth_log WHERE mac = %s", (mac_jeune,)).fetchone()[0] == 1
        journal = c.execute("""SELECT acteur, details FROM app.audit_log WHERE action = 'purge_auth_log'
                                ORDER BY id DESC LIMIT 2""").fetchall()
    assert [j[0] for j in journal] == ["wk_maint", "wk_maint"]
    assert journal[0][1]["supprimees"] == 0 and journal[1][1]["supprimees"] == supprimees


def test_purge_par_lots_rattrape_un_retard():
    mac = _mac()
    echecs(mac, [95 * 86400] * 7)
    with en_tant_que_maint() as c:
        assert c.execute("SELECT radius.purge_auth_log(3)").fetchone()[0] == 3
        assert c.execute("SELECT radius.purge_auth_log(3)").fetchone()[0] == 3
        assert c.execute("SELECT radius.purge_auth_log(3)").fetchone()[0] >= 1
    with admin() as c:
        assert c.execute("SELECT count(*) FROM radius.auth_log WHERE mac = %s", (mac,)).fetchone()[0] == 0


def test_script_et_unites_de_purge():
    env = {**os.environ, "WAKATNET_PG_HOST": "172.29.215.5"}
    r = subprocess.run(["sh", "/depot/infra/maintenance/wakatnet-purge.sh"], capture_output=True, text=True,
                       env=env, timeout=60)
    assert r.returncode == 0 and "ligne(s) supprimée(s) en" in r.stdout, r
    assert os.environ["WAKATNET_PG_MAINT_PASSWORD"] not in r.stdout + r.stderr
    v = subprocess.run(["systemd-analyze", "verify", "--man=no", "/depot/infra/systemd/wakatnet-purge.service",
                        "/depot/infra/systemd/wakatnet-purge.timer"], capture_output=True, text=True, timeout=60)
    erreurs = [l for l in (v.stdout + v.stderr).splitlines() if l.strip() and "/usr/local/sbin/wakatnet-purge" not in l]
    assert erreurs == [], erreurs
