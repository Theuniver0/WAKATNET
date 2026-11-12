"""Promotion manuelle de B, puis retour de A en réplique (phase 5, ticket 03 ; ADR 0015 §3).

Ticket : .scratch/phase-5-haute-disponibilite/issues/03-promotion.md ; procédure : docs/RUNBOOK.md.
Étapes orchestrées par run.sh, après T13 (A primaire, B réplique en flux) :

  p1  A et B en marche : un ticket vendu sur A arrive sur B ; le client du routeur est créé sur A.
      (run.sh vérifie que promouvoir-b.sh REFUSE tant que A répond, puis arrête A.)
  p1b A arrêté : un accounting reçu par A attend dans le spool de A (client encore en cache).
      (run.sh promeut B.)
  p2  B promu : il accepte les écritures ; un accounting reçu par B s'écrit DANS B (son spool se vide
      localement, target_session_attrs). (run.sh fait revenir A en réplique de B par pg_rewind.)
  p3  A est une réplique de B, en flux sur le slot noeud_a ; le spool de A s'est vidé DANS B ; A voit
      les écritures faites sur B pendant son absence.
"""
import glob
import json
import os
import pathlib
import time
import uuid

import psycopg
import pytest

import radlib
from conftest import PG_HOTE, ROUTEURS, admin, creneau_nouveau_client, nouveau_ticket, secret

ETAT = pathlib.Path("/tmp/wakatnet-promotion.json")
PG_B = "172.29.215.6"
SERVEUR_A, SERVEUR_B = "10.213.0.1", "10.213.0.2"
SPOOL_A, SPOOL_B = "/radacct/wakatnet", "/radacct_b/wakatnet"
ROUTEUR = "r2"
MAC = "02-13-13-13-13-02"


def _etape(nom):
    return pytest.mark.skipif(os.environ.get("WAKATNET_ETAPE") != nom, reason="étape orchestrée par run.sh")


def _lire():
    return json.loads(ETAT.read_text())


def _ecrire(etat):
    ETAT.write_text(json.dumps(etat))


def _pg(hote: str) -> psycopg.Connection:
    return psycopg.connect(host=hote, dbname="wakatnet", user="wakatnet_admin",
                           password=os.environ["POSTGRES_PASSWORD"], autocommit=True, connect_timeout=5)


def _vide(spool: str) -> bool:
    return not (glob.glob(os.path.join(spool, "detail-*")) or glob.glob(os.path.join(spool, "detail.work")))


def _start(serveur: str, code: str) -> str:
    sid = uuid.uuid4().hex[:16]
    r = radlib.accounting_request(serveur=serveur, secret=secret(ROUTEUR), source=ROUTEURS[ROUTEUR][0],
                                  calling_station_id=MAC, statut="Start", session_id=sid, utilisateur=code,
                                  essais=1, delai=1.0)
    assert r is not None and r.nom == "Accounting-Response", f"pas d'Accounting-Response de {serveur}"
    return sid


def _session(hote: str, code: str):
    with _pg(hote) as c:
        return c.execute("""SELECT s.acct_session_id FROM radius.session s JOIN app.voucher v ON v.id = s.voucher_id
                             WHERE v.code = %s""", (code,)).fetchall()


def _attendre(condition, delai: float, message: str):
    fin = time.monotonic() + delai
    while time.monotonic() < fin:
        try:
            if condition():
                return
        except psycopg.OperationalError:
            pass
        time.sleep(0.5)
    raise AssertionError(message)


@_etape("p1")
def test_p1_un_ticket_vendu_sur_a_arrive_sur_b():
    tickets = [nouveau_ticket(), nouveau_ticket()]
    with admin() as c:
        lsn = c.execute("SELECT pg_current_wal_lsn()::text").fetchone()[0]

    def a_jour():
        with _pg(PG_B) as c:
            return c.execute("SELECT pg_is_in_recovery() AND pg_last_wal_replay_lsn() >= %s::pg_lsn", (lsn,)).fetchone()[0]
    _attendre(a_jour, 30, "B ne suit pas A")
    # Client dynamique du routeur créé sur A maintenant (base en marche) : en cache pendant p1b.
    creneau_nouveau_client()
    r = radlib.access_request(serveur=SERVEUR_A, secret=secret(ROUTEUR), source=ROUTEURS[ROUTEUR][0],
                              utilisateur="ZZZZZZZZ", mot_de_passe="ZZZZZZZZ", calling_station_id=MAC, essais=1)
    assert r is not None, "A doit répondre (client créé)"
    _ecrire({"tickets": tickets})


@_etape("p1b")
def test_p1b_a_arrete_son_accounting_attend_dans_son_spool():
    etat = _lire()
    etat["sid_a"] = _start(SERVEUR_A, etat["tickets"][1])
    time.sleep(2)
    assert not _vide(SPOOL_A), "A arrêté : l'événement attend dans le spool de A"
    _ecrire(etat)


@_etape("p2")
def test_p2_b_promu_accepte_les_ecritures_et_le_spool_de_a_attend():
    etat = _lire()
    with _pg(PG_B) as c:
        assert c.execute("SELECT pg_is_in_recovery()").fetchone()[0] is False, "B doit être primaire"
        c.execute("CREATE TEMP TABLE essai_ecriture (x int)")        # écriture possible
    with pytest.raises(psycopg.OperationalError):
        _pg(PG_HOTE).close()                                         # A est arrêté
    # Ticket 0 : accounting reçu par B, écrit dans B (son spool se vide localement).
    sid_b = _start(SERVEUR_B, etat["tickets"][0])
    _attendre(lambda: _vide(SPOOL_B) and _session(PG_B, etat["tickets"][0]) == [(sid_b,)], 60,
              "le spool de B ne s'est pas vidé dans B promu")
    assert not _vide(SPOOL_A), "le spool de A attend toujours (A arrêté)"
    etat["sid_b"] = sid_b
    _ecrire(etat)


@_etape("p3")
def test_p3_a_revenu_en_replique_de_b_et_son_spool_vide_dans_b():
    etat = _lire()

    def a_replique():
        with _pg(PG_HOTE) as c:
            return c.execute("SELECT pg_is_in_recovery()").fetchone()[0]
    _attendre(a_replique, 60, "A n'est pas revenu en réplique")
    with _pg(PG_B) as c:
        flux = c.execute("""SELECT r.state, s.slot_name FROM pg_stat_replication r
                              JOIN pg_replication_slots s ON s.active_pid = r.pid""").fetchall()
    assert ("streaming", "noeud_a") in flux, f"A doit répliquer B sur le slot noeud_a : {flux}"
    # Le spool de A se vide DANS B (A est en lecture seule, target_session_attrs=read-write).
    _attendre(lambda: _vide(SPOOL_A) and _session(PG_B, etat["tickets"][1]) == [(etat["sid_a"],)], 90,
              "le spool de A ne s'est pas vidé dans B")
    # A voit tout ce que B a écrit, y compris pendant son absence.
    _attendre(lambda: _session(PG_HOTE, etat["tickets"][0]) == [(etat["sid_b"],)]
              and _session(PG_HOTE, etat["tickets"][1]) == [(etat["sid_a"],)], 30,
              "A ne rejoue pas les écritures de B")
