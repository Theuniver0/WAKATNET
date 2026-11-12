"""T13 — PostgreSQL du nœud A arrêté : le nœud B authentifie sur sa réplique (phase 5, ticket 02).

Ticket : .scratch/phase-5-haute-disponibilite/issues/02-t13-replique.md ; ADR 0015 §1, §2.
Étapes orchestrées par run.sh (le conteneur de test ne pilote pas Docker), comme test_t04_indispo.py :

  a  A primaire, B réplique : B est bien une réplique à jour ; post_auth y est muet ; coupure,
     fantômes et purge y sortent sans rien faire ; un ticket vendu est accepté par B.
  b  PostgreSQL de A ARRÊTÉ : un ticket vendu AVANT la panne obtient un Accept de B, avec le
     Session-Timeout exact ; l'accounting reçu par B répond tout de suite et attend dans SON spool.
     (run.sh attend ATTENTE_S secondes, puis relance PostgreSQL de A.)
  c  A relancé : le spool de B se vide DANS A (target_session_attrs=read-write) ; l'activation porte
     l'instant de RÉCEPTION par B, pas celui du rejeu ; une seule session, sans perte.

Sans WAKATNET_ETAPE, ces tests sont ignorés (passage principal).
"""
import glob
import json
import os
import pathlib
import subprocess
import time
import uuid

import psycopg
import pytest

import radlib
from conftest import ROUTEURS, admin, creneau_nouveau_client, nouveau_ticket, secret

ETAT = pathlib.Path("/tmp/wakatnet-t13.json")
ATTENTE_S = 10          # run.sh attend au moins ce délai entre l'envoi et la relance de A
SERVEUR_B = "10.213.0.2"
PG_B = "172.29.215.6"
SPOOL_B = "/radacct_b/wakatnet"
ROUTEUR = "r1"
MAC = "02-13-13-13-13-01"


def _etape(nom):
    return pytest.mark.skipif(os.environ.get("WAKATNET_ETAPE") != f"t13{nom}", reason="étape orchestrée par run.sh")


def _lire():
    return json.loads(ETAT.read_text())


def _ecrire(etat):
    ETAT.write_text(json.dumps(etat))


def _b(role: str = "wakatnet_admin", variable: str = "POSTGRES_PASSWORD") -> psycopg.Connection:
    return psycopg.connect(host=PG_B, dbname="wakatnet", user=role, password=os.environ[variable], autocommit=True,
                           connect_timeout=5)


def _demander_b(code: str):
    r = radlib.access_request(serveur=SERVEUR_B, secret=secret(ROUTEUR), source=ROUTEURS[ROUTEUR][0],
                              utilisateur=code, mot_de_passe=code, calling_station_id=MAC, essais=3)
    assert r is not None, "B ne répond pas"
    assert r.un("Message-Authenticator") is not None
    return r


def _comptabiliser_b(**kw):
    return radlib.accounting_request(serveur=SERVEUR_B, secret=secret(ROUTEUR), source=ROUTEURS[ROUTEUR][0],
                                     calling_station_id=MAC, **kw)


def _spool_b_vide() -> bool:
    return not (glob.glob(os.path.join(SPOOL_B, "detail-*")) or glob.glob(os.path.join(SPOOL_B, "detail.work")))


def _sur_b(commande: list[str], env: dict) -> subprocess.CompletedProcess:
    env = {"PATH": os.environ["PATH"], "WAKATNET_PG_HOST": PG_B, "NODE_NO_WARNINGS": "1", **env}
    return subprocess.run(commande, env=env, capture_output=True, text=True, timeout=60)


@_etape("a")
def test_t13a_b_est_une_replique_a_jour_et_muette():
    tickets = [nouveau_ticket(), nouveau_ticket()]
    with admin() as c:
        lsn = c.execute("SELECT pg_current_wal_lsn()::text").fetchone()[0]
        envoi = c.execute("SELECT state, sync_state FROM pg_stat_replication WHERE application_name = 'walreceiver'"
                          " OR client_addr = %s::inet", (PG_B,)).fetchall()
        slot = c.execute("SELECT active FROM pg_replication_slots WHERE slot_name = 'noeud_b'").fetchone()
    assert envoi and envoi[0] == ("streaming", "async"), f"réplication attendue en flux, asynchrone : {envoi}"
    assert slot == (True,), "slot noeud_b actif"
    fin = time.monotonic() + 30
    while True:
        with _b() as c:
            rejoue = c.execute("SELECT pg_is_in_recovery(), pg_last_wal_replay_lsn() >= %s::pg_lsn", (lsn,)).fetchone()
        if rejoue == (True, True):
            break
        assert time.monotonic() < fin, f"B en retard ou pas en réplique : {rejoue}"
        time.sleep(0.2)
    with _b() as c:
        assert c.execute("SELECT count(*) FROM app.voucher WHERE code = ANY(%s)", (tickets,)).fetchone()[0] == 2

    # post_auth sur la réplique : aucune écriture, aucune erreur (ADR 0015 §2).
    with _b("wk_radius", "WAKATNET_PG_RADIUS_PASSWORD") as c:
        assert c.execute("SELECT radius.post_auth(%s, %s, %s, 'Accept', '')",
                         (tickets[0], ROUTEURS[ROUTEUR][0], MAC)).fetchone()[0] == "replique"

    # Les tâches qui écrivent sortent sans rien faire sur la réplique (code 0, pas d'alerte).
    t = _sur_b(["node", "/depot/infra/coupure/coupure.ts"], {"WAKATNET_PG_COA_PASSWORD": os.environ["WAKATNET_PG_COA_PASSWORD"]})
    assert t.returncode == 0 and "réplique" in t.stdout, t.stdout + t.stderr
    maint = {"WAKATNET_PG_MAINT_PASSWORD": os.environ["WAKATNET_PG_MAINT_PASSWORD"], "WAKATNET_SPOOL": SPOOL_B}
    for script in ("wakatnet-fantomes.sh", "wakatnet-purge.sh"):
        t = _sur_b(["sh", f"/depot/infra/maintenance/{script}"], maint)
        assert t.returncode == 0 and "réplique" in t.stdout, f"{script} : {t.stdout}{t.stderr}"

    # A en marche : B sert déjà correctement depuis sa réplique (même décision que A).
    creneau_nouveau_client()
    r = _demander_b(tickets[0])
    assert r.nom == "Access-Accept", r.un("Reply-Message")
    assert r.un("Session-Timeout") == 3600
    _ecrire({"vendu": tickets[1]})


@_etape("b")
def test_t13b_a_arrete_b_accepte_un_ticket_deja_vendu():
    etat = _lire()
    with pytest.raises(psycopg.OperationalError):               # A est réellement arrêté (délai borné)
        psycopg.connect(host="172.29.215.5", dbname="wakatnet", user="wakatnet_admin",
                        password=os.environ["POSTGRES_PASSWORD"], connect_timeout=3).close()
    code = etat["vendu"]
    r = _demander_b(code)
    assert r.nom == "Access-Accept", r.un("Reply-Message")
    assert r.un("Session-Timeout") == 3600, "Session-Timeout exact : ticket neuf, forfait d'une heure"
    sid = uuid.uuid4().hex[:16]
    envoi = time.time()
    debut = time.monotonic()
    rep = _comptabiliser_b(statut="Start", session_id=sid, utilisateur=code, essais=1, delai=1.0)
    assert rep is not None and rep.nom == "Accounting-Response", "B doit répondre à l'accounting, A arrêté"
    assert time.monotonic() - debut < 0.5, "réponse immédiate (règle 2)"
    time.sleep(2)                                                # au moins un essai du lecteur
    assert not _spool_b_vide(), "aucun primaire joignable : l'événement attend dans le spool de B"
    etat.update(sid=sid, envoi=envoi)
    _ecrire(etat)


@_etape("c")
def test_t13c_le_spool_de_b_se_vide_dans_a_avec_l_instant_de_reception():
    etat = _lire()
    code = etat["vendu"]
    fin = time.monotonic() + 90
    sessions = []
    while time.monotonic() < fin:
        if _spool_b_vide():
            with admin() as c:
                sessions = c.execute("""SELECT s.acct_session_id, s.started_at FROM radius.session s
                                         JOIN app.voucher v ON v.id = s.voucher_id
                                        WHERE v.tenant_id = 1 AND v.code = %s""", (code,)).fetchall()
            if sessions:
                break
        time.sleep(0.5)
    assert sessions, "le spool de B ne s'est pas vidé dans A"
    assert len(sessions) == 1 and sessions[0][0] == etat["sid"], sessions
    with admin() as c:
        active = c.execute("SELECT activated_at FROM app.voucher WHERE tenant_id = 1 AND code = %s",
                           (code,)).fetchone()[0].timestamp()
        (active_le, rejoue_le), = c.execute("""SELECT a.active_le, a.inscrit_le FROM radius.activation a
                                                 JOIN app.voucher v ON v.id = a.voucher_id WHERE v.code = %s""",
                                              (code,)).fetchall()
    # Activation à l'instant de RÉCEPTION par B (règle 5), pas à celui du rejeu dans A.
    assert int(etat["envoi"]) <= active <= etat["envoi"] + 1.5, (etat["envoi"], active)
    assert active_le.timestamp() == active
    assert rejoue_le.timestamp() - active >= ATTENTE_S - 1, "A était bien arrêté pendant l'attente"
    # A a repris la main : B la suit de nouveau (l'activation est revenue par la réplication).
    fin = time.monotonic() + 30
    while True:
        with _b() as c:
            vu = c.execute("SELECT activated_at IS NOT NULL FROM app.voucher WHERE code = %s", (code,)).fetchone()
        if vu == (True,):
            break
        assert time.monotonic() < fin, "B ne suit plus A après son retour"
        time.sleep(0.5)
