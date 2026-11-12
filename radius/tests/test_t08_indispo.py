"""Base arrêtée, radiusd démarré sans base, base figée — ticket 08 (ADR 0009).

Ticket : .scratch/phase-1-coeur-radius/issues/08-base-indisponible.md
Comme test_t04_indispo.py, ces étapes ne s'exécutent QUE sous l'orchestration de run.sh,
qui arrête, relance et fige les conteneurs entre deux appels de pytest :

  f  base en marche     : tickets ; client r10 créé (Accept)
     -> run.sh : docker compose stop postgres
  g  base ARRÊTÉE       : r10 sans réponse d'authentification, compté (silence-auth) ;
                          Accounting-Response immédiate ; r12 (nouveau client) compté (silence-client)
     -> run.sh : redémarre freeradius, base toujours arrêtée (L6d)
  h  radiusd SANS base  : le serveur tourne et compte (silence-client) ; limite : client hors cache
     -> run.sh : relance la base 3 s après le début de l'étape i
  i  retour de la base  : authentification correcte moins de retry_delay + 1 s après que la base
                          est prête, alors que le routeur insistait pendant la panne
  j  base en marche     : client r11 créé (Accept)
     -> run.sh : docker compose pause postgres
  k  base FIGÉE         : 50 Access-Request en attente ; Accounting-Response < 100 ms pendant
                          toute l'attente (jusqu'au dernier silence) ; les 50 sont comptés ;
                          pire cas mesuré et borné (< 6 s)
  l  reprise            : run.sh reprend la base 3 s après le début de l'étape ; même critère que i

Sans WAKATNET_ETAPE, tous ces tests sont ignorés. L'état passe d'une étape à l'autre par un
fichier du conteneur de test, hors dépôt.
"""
import concurrent.futures
import json
import os
import pathlib
import threading
import time
import uuid

import psycopg
import pytest

from conftest import PG_HOTE, ROUTEURS, comptabiliser, creneau_nouveau_client, demander, nouveau_ticket, silences

ETAT = pathlib.Path("/tmp/wakatnet-t08-indispo.json")
RETRY_DELAY_S = 5          # pool { retry_delay } de sql_clients et sql_auth (mods-enabled/sql_wakatnet)
MAC = "02-08-08-08-08-08"  # même appareil d'une étape à l'autre (compte d'appareils, ticket 06)
EN_ATTENTE = 50


def _etape(nom):
    return pytest.mark.skipif(os.environ.get("WAKATNET_ETAPE") != nom, reason="étape orchestrée par run.sh")


def _lire():
    return json.loads(ETAT.read_text())


def _ecrire(etat):
    ETAT.write_text(json.dumps(etat))


def _compte(nature: str, nom: str) -> int:
    ip = ROUTEURS[nom][0]
    return sum(1 for l in silences(nature) if l.endswith(" " + ip))


def _attendre_compte(nature: str, nom: str, cible: int, delai: float = 10.0) -> None:
    fin = time.monotonic() + delai
    while time.monotonic() < fin:
        if _compte(nature, nom) >= cible:
            return
        time.sleep(0.02)
    raise AssertionError(f"silence-{nature} {nom} : {_compte(nature, nom)} lignes, {cible} attendues après {delai} s")


def _accept(nom: str, code: str):
    r = demander(nom, code=code, calling_station_id=MAC)
    assert r is not None and r.nom == "Access-Accept", r and r.un("Reply-Message")


def _accounting_immediat(nom: str, limite: float) -> float:
    debut = time.monotonic()
    r = comptabiliser(nom, statut="Start", session_id=uuid.uuid4().hex[:16], utilisateur="ZZZZZZZZ",
                      calling_station_id=MAC, essais=1, delai=1.0)
    duree = time.monotonic() - debut
    assert r is not None and r.nom == "Accounting-Response", f"{nom} : pas d'Accounting-Response"
    assert duree < limite, f"{nom} : Accounting-Response en {duree * 1000:.0f} ms (limite {limite * 1000:.0f} ms)"
    return duree


def _base_prete() -> bool:
    try:
        with psycopg.connect(host=PG_HOTE, dbname="wakatnet", user="wakatnet_admin",
                             password=os.environ["POSTGRES_PASSWORD"], connect_timeout=1) as c:
            c.execute("SELECT 1")
        return True
    except psycopg.OperationalError:
        return False


def _retour_de_la_base(nom: str, code: str) -> None:
    """run.sh rend la base 3 s après le début de l'étape. Le routeur insiste pendant toute la
    panne (un Access-Request toutes les 250 ms) : le dernier échec du pool est donc récent, et
    retry_delay s'applique pleinement. Critère : Accept < retry_delay + 1 s après « base prête »."""
    pret = {}

    def guetter():
        fin = time.monotonic() + 90
        while time.monotonic() < fin and not _base_prete():
            time.sleep(0.1)
        pret["t"] = time.monotonic()

    guet = threading.Thread(target=guetter)
    guet.start()
    fin = time.monotonic() + 90
    accepte = None
    echecs_avant = 0
    while time.monotonic() < fin:
        r = demander(nom, code=code, calling_station_id=MAC, essais=1, delai=0.25)
        if r is not None:
            assert r.nom == "Access-Accept", r.un("Reply-Message")
            accepte = time.monotonic()
            break
        if "t" not in pret:
            echecs_avant += 1
    guet.join()
    assert accepte is not None, "aucun Accept 90 s après le retour de la base"
    assert echecs_avant >= 4, "la base devait être indisponible au début de l'étape"
    ecart = accepte - pret["t"]
    print(f"{nom} : Accept {ecart * 1000:.0f} ms après « base prête » ({echecs_avant} essais sans réponse avant)")
    assert ecart < RETRY_DELAY_S + 1, f"retour de la base : {ecart:.2f} s (limite {RETRY_DELAY_S + 1} s)"


@_etape("f")
def test_f_preparer():
    etat = {"r10": nouveau_ticket(), "r11": nouveau_ticket()}
    creneau_nouveau_client()
    _accept("r10", etat["r10"])
    _ecrire(etat)


@_etape("g")
def test_g_base_arretee_silence_compte_et_accounting_repond():
    etat = _lire()
    avant = _compte("auth", "r10")
    debut = time.monotonic()
    assert demander("r10", code=etat["r10"], calling_station_id=MAC, essais=1, delai=3.0) is None, \
        "base arrêtée : le nœud doit se taire (ADR 0009)"
    _attendre_compte("auth", "r10", avant + 1)
    print(f"base arrêtée : silence compté après {(time.monotonic() - debut) * 1000:.0f} ms")
    _accounting_immediat("r10", 0.1)

    # Nouveau routeur : sa création de client échoue, compté à part.
    creneau_nouveau_client()
    avant = _compte("client", "r12")
    assert demander("r12", code="ZZZZZZZZ", essais=1, delai=2.0) is None
    _attendre_compte("client", "r12", avant + 1)


@_etape("h")
def test_h_radiusd_demarre_sans_base():
    """radiusd vient de démarrer, base arrêtée (pool { start = 0 }, L6d) : il traite les paquets.
    LIMITE (ADR 0006, amendement du ticket 04 ; ADR 0009 §5) : son cache de clients est vide,
    donc r10 n'obtient plus aucune réponse, accounting compris ; seul le compteur le montre."""
    creneau_nouveau_client()
    avant = _compte("client", "r10")
    assert demander("r10", code="ZZZZZZZZ", essais=1, delai=2.0) is None
    _attendre_compte("client", "r10", avant + 1)
    r = comptabiliser("r10", statut="Start", session_id=uuid.uuid4().hex[:16], utilisateur="ZZZZZZZZ",
                      essais=1, delai=1.0)
    assert r is None, "limite connue : client hors cache, base arrêtée -> aucune réponse"


@_etape("i")
def test_i_retour_de_la_base_apres_redemarrage():
    _retour_de_la_base("r10", _lire()["r10"])


@_etape("j")
def test_j_preparer_base_figee():
    creneau_nouveau_client()
    _accept("r11", _lire()["r11"])


@_etape("k")
def test_k_base_figee_cinquante_en_attente_accounting_immediat():
    etat = _lire()
    avant = _compte("auth", "r11")
    envoi = time.monotonic()
    # delai=7 s (pire cas borné à 6 s) : l'étape reste courte, pour que le client r11 (lifetime de
    # 20 s en test) ne risque pas d'expirer avant le retour mesuré à l'étape l.
    with concurrent.futures.ThreadPoolExecutor(max_workers=EN_ATTENTE) as pool:
        futurs = [pool.submit(demander, "r11", code=etat["r11"], calling_station_id=MAC, essais=1, delai=7.0)
                  for _ in range(EN_ATTENTE)]
        time.sleep(0.1)
        # Accounting pendant TOUTE l'attente, jusqu'au comptage du dernier silence : aucun
        # épuisement (fils, pool) ne doit le retarder. Une mesure toutes les 250 ms environ.
        durees = []
        fin = time.monotonic() + 15.0
        while _compte("auth", "r11") < avant + EN_ATTENTE and time.monotonic() < fin:
            durees.append(_accounting_immediat("r11", 0.1))
            time.sleep(0.25)
        # Pire cas : délai entre l'envoi et le comptage du DERNIER silence.
        _attendre_compte("auth", "r11", avant + EN_ATTENTE, delai=1.0)
        pire = time.monotonic() - envoi
        reponses = [f.result() for f in futurs]
    assert all(r is None for r in reponses), "base figée : aucune réponse d'authentification"
    print(f"base figée : {EN_ATTENTE} silences comptés en {pire * 1000:.0f} ms ; "
          f"Accounting-Response max {max(durees) * 1000:.1f} ms sur {len(durees)} mesures")
    # La mesure couvre l'attente : au moins une mesure par 250 ms de pire cas, moins la dernière.
    assert len(durees) >= int(pire / 0.35), f"{len(durees)} mesures pour {pire:.1f} s d'attente"
    # Majorant du pire cas : mesuré 4,0 s (ADR 0009 §2). Une régression (délai du pilote
    # perdu, reconnexions multipliées) le dépasserait.
    assert pire < 6.0, f"pire cas {pire:.1f} s"
    etat["pire_fige_ms"] = round(pire * 1000)
    _ecrire(etat)


@_etape("l")
def test_l_retour_apres_reprise():
    _retour_de_la_base("r11", _lire()["r11"])
