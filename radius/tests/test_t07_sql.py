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


def test_purge_conservation_durees_du_13_11_2026():
    """Migration 0040 (docs/CONFORMITE.md §7 bis) : sessions fermées anonymisées à 12 mois (compteurs gardés, sessions
    vivantes jamais touchées), quarantaine et anomalies d'accounting supprimées à 12 mois, corps des webhooks vidés à
    6 mois, journal d'audit supprimé à 5 ans. Ce qui est plus jeune reste intact."""
    code = nouveau_ticket()
    marque = uuid.uuid4().hex
    with admin() as c:
        voucher, tenant = c.execute("SELECT id, tenant_id FROM app.voucher WHERE code = %s", (code,)).fetchone()
        routeur = c.execute("SELECT id FROM app.router ORDER BY id LIMIT 1").fetchone()[0]

        def session(age_jours, ferme):
            debut = c.execute("SELECT now() - make_interval(days => %s)", (age_jours,)).fetchone()[0]
            return c.execute("""INSERT INTO radius.session (started_at, router_id, router_epoch, acct_session_id, tenant_id,
                                  voucher_id, calling_station, framed_ip, duree_s, interim_s, dernier_evenement_le, arrete_le)
                                VALUES (%s, %s, 1, %s, %s, %s, '02-AA-BB-CC-DD-EE', '10.5.50.9', 1234, 60, %s,
                                        CASE WHEN %s THEN %s ELSE NULL END) RETURNING id""",
                             (debut, routeur, uuid.uuid4().hex, tenant, voucher, debut, ferme, debut)).fetchone()[0]
        s_vieille, s_ouverte, s_jeune = session(400, True), session(400, False), session(300, True)
        for jours in (400, 300):
            c.execute("""INSERT INTO radius.acct_quarantaine (recu_le, fonction, motif, donnees)
                         VALUES (now() - make_interval(days => %s), 'essai', %s, '{"mac": "02-AA"}')""", (jours, marque))
            c.execute("""INSERT INTO radius.acct_anomalie (recu_le, motif, session_id, session_started_at, donnees)
                         VALUES (now() - make_interval(days => %s), %s, 0, now(), '{}')""", (jours, marque))
        for jours, ident in ((200, marque + "-vieux"), (150, marque + "-jeune")):
            c.execute("""INSERT INTO app.payment_event (fournisseur, id_evenement, tenant_id, recu_le, corps)
                         VALUES ('mock', %s, %s, now() - make_interval(days => %s), '\\x7b226e756d65726f223a2237307d'::bytea)""",
                      (ident, tenant, jours))
        for ans, objet in ((6, marque + "-vieux"), (4, marque + "-jeune")):
            c.execute("""INSERT INTO app.audit_log (le, acteur, action, objet)
                         VALUES (now() - make_interval(years => %s), 'essai', 'essai_conservation', %s)""", (ans, objet))

    with en_tant_que_maint() as c:
        assert c.execute("SELECT radius.purge_conservation()").fetchone()[0] >= 5   # session, quarantaine, anomalie, corps, audit
        assert c.execute("SELECT radius.purge_conservation()").fetchone()[0] == 0, "idempotente"

    with admin() as c:
        etat = {i: (anonyme, duree) for i, anonyme, duree in c.execute(
            """SELECT id, calling_station IS NULL AND framed_ip IS NULL, duree_s FROM radius.session WHERE id = ANY(%s)""",
            ([s_vieille, s_ouverte, s_jeune],)).fetchall()}
        assert etat[s_vieille] == (True, 1234), "fermée depuis 12 mois : anonymisée, compteur gardé"
        assert etat[s_ouverte] == (False, 1234), "session vivante : jamais touchée"
        assert etat[s_jeune] == (False, 1234), "moins de 12 mois : intacte"
        assert c.execute("SELECT count(*) FROM radius.acct_quarantaine WHERE motif = %s", (marque,)).fetchone()[0] == 1
        assert c.execute("SELECT count(*) FROM radius.acct_anomalie WHERE motif = %s", (marque,)).fetchone()[0] == 1
        corps = dict(c.execute("SELECT id_evenement, length(corps) FROM app.payment_event WHERE id_evenement LIKE %s",
                               (marque + "%",)).fetchall())
        assert corps == {marque + "-vieux": 0, marque + "-jeune": 14}, corps
        assert [r[0] for r in c.execute("SELECT objet FROM app.audit_log WHERE action = 'essai_conservation' AND objet LIKE %s",
                                         (marque + "%",)).fetchall()] == [marque + "-jeune"]
        journal = c.execute("""SELECT acteur, details FROM app.audit_log WHERE action = 'purge_conservation'
                                ORDER BY id DESC LIMIT 1""").fetchone()
    assert journal[0] == "wk_maint" and journal[1]["sessions_anonymisees"] >= 1 and journal[1]["corps_webhook_vides"] >= 1


# --- Scan de sécurité du 13/11/2026, F3 (migration 0044) ----------------------

def _ticket_importe(code):
    """Ticket de la plateforme passé en ticket importé (forme Mikhmon, 0017) sous le code donné."""
    t = nouveau_ticket()
    with admin() as c:
        c.execute("UPDATE app.voucher SET code = %s, origine = 'import' WHERE tenant_id = 1 AND code = %s", (code, t))
    return code


def test_f3_routeur_sous_attaque_codes_faibles_refuses_quelle_que_soit_la_mac():
    """La MAC est choisie par le client : changer de MAC contournait le blocage. Pendant une attaque (alerte
    « echecs_routeur » des 5 dernières minutes), les codes de forme faible (hors forme de la plateforme, ou tout en
    chiffres : tickets Mikhmon importés) sont refusés pour TOUTE MAC ; les codes de la plateforme restent servis.
    Chaîne réelle : 100 échecs de 100 MAC différentes, comptés par post_auth, posent l'alerte."""
    long_ = nouveau_ticket()
    court = _ticket_importe("K" + uuid.uuid4().hex[:5].upper())                 # 6 caractères
    chiffres = _ticket_importe("".join("23456789"[b % 8] for b in uuid.uuid4().bytes[:8]))  # forme de la plateforme
    r1 = "(SELECT id FROM app.router WHERE shortname = 'r1')"
    with admin() as c:
        c.execute(f"DELETE FROM radius.alerte WHERE type = 'echecs_routeur' AND router_id = {r1}")
    try:
        assert decider(court, _mac()) == ("Accept", None), "sans attaque : le ticket importé est servi"
        assert decider(chiffres, _mac()) == ("Accept", None)
        with en_tant_que_radius() as c:                      # une MAC neuve par essai : jamais bloqué par MAC
            for _ in range(100):
                c.execute("SELECT radius.post_auth('ZZZZZZZZ', %s, %s, 'Reject', 'ticket_inconnu')",
                          (R1, "0F" + uuid.uuid4().hex[:10].upper()))
        for _ in range(3):                                   # trois MAC neuves : aucune n'y échappe
            assert decider(court, _mac()) == ("Reject", "trop_de_tentatives")
            assert decider(chiffres, _mac()) == ("Reject", "trop_de_tentatives"), "8 chiffres : forme faible"
        assert decider(long_, _mac()) == ("Accept", None), "code de la plateforme : toujours servi"
        assert decider("ZZZZZZZQ", _mac()) == ("Reject", "ticket_inconnu"), "code inconnu de forme forte : cause inchangée"
        prefixe = _ticket_importe("WAK" + "".join("23456789ABCDEFGHJKMNPQRSTUVWXYZ"[b % 31] for b in uuid.uuid4().bytes[:5]))
        assert decider(prefixe, _mac()) == ("Reject", "ticket_inconnu"), "importé de forme forte (0046) : comme inconnu"
        assert decider(court, _mac(), src=R2) == ("Accept", None), "un autre routeur n'est pas touché"
        with admin() as c:
            c.execute(f"UPDATE radius.alerte SET at = now() - interval '301 seconds' WHERE type = 'echecs_routeur' AND router_id = {r1}")
        assert decider(court, _mac()) == ("Accept", None), "attaque finie depuis plus de 5 min : levé"
    finally:
        with admin() as c:
            c.execute(f"DELETE FROM radius.alerte WHERE type = 'echecs_routeur' AND router_id = {r1}")
            c.execute(f"DELETE FROM radius.auth_log WHERE router_id = {r1} AND mac LIKE '0F%%'")


def test_f3_budget_horaire_d_echecs_faibles_attaque_lente():
    """Décision du 13/11/2026 : sous le seuil d'alerte (100/min), un attaquant lent qui change de MAC devinait les
    tickets importés courts. 30 échecs de FORME FAIBLE en une heure sur un routeur le restreignent : codes faibles
    refusés (trop_de_tentatives), ticket importé de forme forte (préfixe Mikhmon) traité comme inconnu, codes de la
    plateforme servis. Les échecs de forme forte ne comptent pas dans ce budget."""
    r2 = "(SELECT id FROM app.router WHERE shortname = 'r2')"
    long_ = nouveau_ticket()
    court = _ticket_importe("Q" + uuid.uuid4().hex[:5].upper())
    prefixe = _ticket_importe("WAK" + "".join("23456789ABCDEFGHJKMNPQRSTUVWXYZ"[b % 31] for b in uuid.uuid4().bytes[:5]))
    def echecs(code, n):                                     # une MAC neuve à chaque fois, une minute sur deux
        with en_tant_que_radius() as c:
            for _ in range(n):
                c.execute("SELECT radius.post_auth(%s, %s, %s, 'Reject', 'ticket_inconnu')",
                          (code, R2, "0E" + uuid.uuid4().hex[:10].upper()))
    with admin() as c:
        c.execute(f"DELETE FROM radius.alerte WHERE type IN ('echecs_routeur', 'budget_routeur') AND router_id = {r2}")
    try:
        echecs("ZZZZZZZZ", 40)                               # forme forte : hors budget
        assert decider(court, _mac(), src=R2) == ("Accept", None), "échecs de forme forte : pas de restriction"
        echecs("1234", 29)
        with admin() as c:                                   # étalés sur l'heure : jamais d'alerte par minute
            c.execute(f"UPDATE radius.auth_log SET at = now() - interval '50 minutes' WHERE router_id = {r2} AND mac LIKE '0E%%'")
        assert decider(court, _mac(), src=R2) == ("Accept", None), "29 échecs faibles : sous le budget"
        echecs("5678", 1)                                    # le 30e
        assert decider(court, _mac(), src=R2) == ("Reject", "trop_de_tentatives"), "budget épuisé : code faible refusé"
        assert decider(prefixe, _mac(), src=R2) == ("Reject", "ticket_inconnu"), "importé de forme forte : comme inconnu"
        assert decider(long_, _mac(), src=R2) == ("Accept", None), "code de la plateforme : toujours servi"
        assert decider(court, _mac()) == ("Accept", None), "un autre routeur n'est pas touché"
        echecs("9012", 5)                                    # budget dépassé : toujours UNE alerte budget_routeur
        with admin() as c:
            assert c.execute(f"SELECT count(*) FROM radius.alerte WHERE type = 'echecs_routeur' AND router_id = {r2}").fetchone()[0] == 0
            assert c.execute(f"SELECT count(*) FROM radius.alerte WHERE type = 'budget_routeur' AND router_id = {r2}").fetchone()[0] == 1
            c.execute(f"UPDATE radius.auth_log SET at = now() - interval '61 minutes' WHERE router_id = {r2} AND mac LIKE '0E%%'")
        assert decider(court, _mac(), src=R2) == ("Accept", None), "plus d'une heure : levé"
        assert decider(prefixe, _mac(), src=R2) == ("Accept", None)
    finally:
        with admin() as c:
            c.execute(f"DELETE FROM radius.auth_log WHERE router_id = {r2} AND mac LIKE '0E%%'")
            c.execute(f"DELETE FROM radius.alerte WHERE type = 'budget_routeur' AND router_id = {r2}")


def test_f3_budget_par_proprietaire_echecs_repartis_sur_ses_routeurs():
    """Troisième relecture (migration 0048) : le budget par routeur laissait 30 essais par heure et PAR ROUTEUR. 60 échecs
    de forme faible répartis sur les routeurs d'un propriétaire, sans qu'aucun n'atteigne son propre budget, restreignent
    TOUS ses routeurs, et eux seuls ; une alerte budget_proprietaire est posée, une seule fois par fenêtre."""
    court = _ticket_importe("P" + uuid.uuid4().hex[:5].upper())
    long_ = nouveau_ticket()
    court_b = "B" + uuid.uuid4().hex[:5].upper()             # ticket importé d'un AUTRE propriétaire (2, routeur r7)
    with admin() as c:
        t = nouveau_ticket(plan_id=3, tenant_id=2)
        c.execute("UPDATE app.voucher SET code = %s, origine = 'import' WHERE tenant_id = 2 AND code = %s", (court_b, t))
    def echecs(src, n):
        with en_tant_que_radius() as c:
            for _ in range(n):
                c.execute("SELECT radius.post_auth('4321', %s, %s, 'Reject', 'ticket_inconnu')",
                          (src, "0D" + uuid.uuid4().hex[:10].upper()))
    with admin() as c:
        valeurs = dict(c.execute("""SELECT cle, valeur FROM radius.parametre
                                     WHERE cle IN ('devinette_faibles_par_proprietaire', 'devinette_faibles_par_heure')""").fetchall())
    try:
        with admin() as c:
            c.execute("DELETE FROM radius.alerte WHERE type IN ('budget_routeur', 'budget_proprietaire', 'echecs_routeur') AND tenant_id IN (1, 2)")
            # Échecs faibles laissés dans l'heure par d'autres tests du même propriétaire : le budget est décalé d'autant.
            deja = c.execute("""SELECT count(*) FROM radius.auth_log WHERE tenant_id = 1 AND forme_faible AND resultat = 'Reject'
                                  AND cause = 'ticket_inconnu' AND at > now() - interval '1 hour'""").fetchone()[0]
            c.execute("UPDATE radius.parametre SET valeur = %s WHERE cle = 'devinette_faibles_par_proprietaire'", (str(60 + deja),))
            # Seul le budget du propriétaire est éprouvé ici : celui des routeurs est mis hors de portée le temps du test.
            c.execute("UPDATE radius.parametre SET valeur = '100000' WHERE cle = 'devinette_faibles_par_heure'")
        echecs(R1, 29)
        echecs(R2, 29)
        assert decider(court, _mac()) == ("Accept", None), "58 échecs répartis : sous le budget du propriétaire"
        echecs(ROUTEURS["r6"][0], 2)                         # le 60e, sur un troisième routeur
        echecs(R2, 10)                                       # au-delà du seuil : toujours UNE alerte
        for src in (R1, R2, ROUTEURS["r6"][0]):
            assert decider(court, _mac(), src=src) == ("Reject", "trop_de_tentatives"), f"propriétaire restreint ({src})"
        assert decider(long_, _mac()) == ("Accept", None), "code de la plateforme : toujours servi"
        assert decider(court_b, _mac(), src=ROUTEURS["r7"][0]) == ("Accept", None), "un autre propriétaire n'est pas touché"
        with admin() as c:
            assert c.execute("SELECT count(*) FROM radius.alerte WHERE type = 'budget_proprietaire' AND tenant_id = 1").fetchone()[0] == 1
            assert c.execute("SELECT count(*) FROM radius.alerte WHERE type = 'budget_proprietaire' AND tenant_id = 2").fetchone()[0] == 0
            c.execute("UPDATE radius.auth_log SET at = now() - interval '61 minutes' WHERE tenant_id = 1 AND mac LIKE '0D%%'")
        assert decider(court, _mac()) == ("Accept", None), "plus d'une heure : levé"
    finally:
        with admin() as c:
            c.execute("DELETE FROM radius.auth_log WHERE tenant_id = 1 AND mac LIKE '0D%%'")
            c.execute("DELETE FROM radius.alerte WHERE type = 'budget_proprietaire' AND tenant_id = 1")
            for cle, valeur in valeurs.items():
                c.execute("UPDATE radius.parametre SET valeur = %s WHERE cle = %s", (valeur, cle))
