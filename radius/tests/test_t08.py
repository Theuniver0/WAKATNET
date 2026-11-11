"""Base en marche mais chemin critique en échec — ticket 08 (ADR 0009).

Ticket : .scratch/phase-1-coeur-radius/issues/08-base-indisponible.md

rlm_sql_map rend « fail » pour TOUTE erreur SQL (rlm_sql_map.c, mod_map ; ADR 0009 §1) :
droit retiré, exception ou délai dépassé donnent donc le même silence qu'une base arrêtée.
Ce fichier prouve, base en marche :
  - le comportement de l'ADR pour un droit retiré et pour une fonction qui lève une exception :
    silence, compté, et DÉTECTÉ par le test de fumée de migrer.sh (fumee.sh) ;
  - la borne principale du délai : statement_timeout de wk_radius (500 ms), sans reconnexion ;
  - le compteur des silences : une ligne par paquet, sans le code ; rien pour un routeur inconnu.
Les cas « base arrêtée » et « base figée » sont dans test_t08_indispo.py (orchestrés par run.sh).
"""
import os
import re
import subprocess
import threading
import time

import psycopg
import pytest

import radlib
from conftest import IP_INCONNUE, PG_HOTE, ROUTEURS, SERVEUR, admin, demander, nouveau_ticket, silences

SIGNATURE = "radius.authorize(text, text, text, text)"
LIGNE = re.compile(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d 10\.213\.\d{1,3}\.\d{1,3}$")


def _fumee() -> subprocess.CompletedProcess:
    """Le script de production, lancé comme migrer.sh le lance (superutilisateur, variables libpq)."""
    env = dict(os.environ, PGHOST=PG_HOTE, PGUSER="wakatnet_admin", PGDATABASE="wakatnet",
               PGPASSWORD=os.environ["POSTGRES_PASSWORD"])
    return subprocess.run(["bash", "/depot/infra/sql/fumee.sh"], capture_output=True, text=True, env=env,
                          timeout=60)


def _attendre_silence(nature: str, ip: str, avant: int, delai: float = 10.0) -> float:
    """Attend une NOUVELLE ligne du compteur pour `ip` ; renvoie l'instant (monotone) où elle paraît."""
    fin = time.monotonic() + delai
    while time.monotonic() < fin:
        lignes = [l for l in silences(nature) if l.endswith(" " + ip)]
        if len(lignes) > avant:
            return time.monotonic()
        time.sleep(0.02)
    raise AssertionError(f"aucune ligne silence-{nature} pour {ip} après {delai} s")


def _compte(nature: str, ip: str) -> int:
    return sum(1 for l in silences(nature) if l.endswith(" " + ip))


def _silence_puis_reprise(code: str):
    """Le paquet reste sans réponse ; le silence est compté, sans le code."""
    ip = ROUTEURS["r1"][0]
    avant = _compte("auth", ip)
    assert demander("r1", code=code, essais=1, delai=2.0) is None, "réponse malgré le défaut : le nœud doit se taire"
    _attendre_silence("auth", ip, avant)
    toutes = silences("auth")
    assert all(LIGNE.match(l) for l in toutes), toutes[-3:]
    assert not any(code in l for l in toutes), "le code du ticket ne doit jamais être écrit"


def test_fumee_passe_sur_base_saine():
    r = _fumee()
    assert r.returncode == 0, r.stdout + r.stderr
    assert "fumée : client_lookup et authorize" in r.stdout


def test_droit_retire_silence_compte_et_detecte_par_la_fumee():
    code = nouveau_ticket()
    try:
        with admin() as c:
            c.execute(f"REVOKE EXECUTE ON FUNCTION {SIGNATURE} FROM wk_radius")
        _silence_puis_reprise(code)
        r = _fumee()
        assert r.returncode != 0, "la fumée doit refuser un droit retiré"
        assert "permission denied" in r.stderr and "authorize" in r.stderr, r.stderr
        assert "ÉCHEC du test de fumée" in r.stderr
    finally:
        with admin() as c:
            c.execute(f"GRANT EXECUTE ON FUNCTION {SIGNATURE} TO wk_radius")
    r = demander("r1", code=code)
    assert r is not None and r.nom == "Access-Accept"


def test_fonction_qui_leve_une_exception_silence_compte_et_detecte_par_la_fumee():
    code = nouveau_ticket()
    with admin() as c:
        oid = c.execute("SELECT %s::regprocedure::oid", (SIGNATURE,)).fetchone()[0]
        origine, arguments, resultat = c.execute(
            "SELECT pg_get_functiondef(%s), pg_get_function_arguments(%s), pg_get_function_result(%s)",
            (oid, oid, oid)).fetchone()
    try:
        with admin() as c:
            # Défaut de déploiement simulé : même signature, même type de retour, corps qui lève.
            c.execute(f"CREATE OR REPLACE FUNCTION radius.authorize({arguments}) RETURNS {resultat} "
                      "LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'défaut simulé (ticket 08)'; END $f$")
        _silence_puis_reprise(code)
        r = _fumee()
        assert r.returncode != 0, "la fumée doit refuser une fonction qui lève"
        assert "défaut simulé (ticket 08)" in r.stderr, r.stderr
    finally:
        with admin() as c:
            c.execute(origine)
    with admin() as c:   # restauration exacte (SECURITY DEFINER, search_path, droits)
        assert c.execute("SELECT pg_get_functiondef(%s::regprocedure)", (SIGNATURE,)).fetchone()[0] == origine
    r = demander("r1", code=code)
    assert r is not None and r.nom == "Access-Accept"
    assert _fumee().returncode == 0


def test_delai_borne_par_statement_timeout_sans_reconnexion():
    """Table verrouillée : authorize attend, statement_timeout (500 ms) coupe (57014, classé SANS
    reconnexion par le pilote) : silence en moins d'une seconde, et la requête suivante répond
    aussitôt, sur la même connexion (aucun retry_delay)."""
    code = nouveau_ticket()
    ip = ROUTEURS["r1"][0]
    assert demander("r1", code=code).nom == "Access-Accept"   # connexion du pool ouverte, client en cache
    verrou = psycopg.connect(host=PG_HOTE, dbname="wakatnet", user="wakatnet_admin",
                             password=os.environ["POSTGRES_PASSWORD"])
    try:
        verrou.execute("LOCK TABLE app.voucher IN ACCESS EXCLUSIVE MODE")
        avant = _compte("auth", ip)
        envoi = time.monotonic()
        resultat = {}
        t = threading.Thread(target=lambda: resultat.update(r=demander("r1", code=code, essais=1, delai=3.0)))
        t.start()
        vu = _attendre_silence("auth", ip, avant, delai=5.0)
        t.join()
        assert resultat["r"] is None
        duree = vu - envoi
        print(f"silence après {duree * 1000:.0f} ms (table verrouillée)")
        assert 0.45 <= duree < 1.0, f"{duree:.3f} s : la borne doit être le statement_timeout de 500 ms"
    finally:
        verrou.rollback()
        verrou.close()
    debut = time.monotonic()
    r = demander("r1", code=code, essais=1, delai=1.0)
    assert r is not None and r.nom == "Access-Accept"
    assert time.monotonic() - debut < 0.3, "après un 57014, la connexion doit rester utilisable"


def test_client_lookup_en_delai_est_compte_mais_pas_un_routeur_inconnu():
    """Un routeur inconnu n'est pas un silence de la base : aucune ligne. Un client_lookup coupé
    par le délai l'est (silence-client)."""
    def envoyer():
        return radlib.access_request(serveur=SERVEUR, secret=b"secret-quelconque", source=IP_INCONNUE,
                                     utilisateur="ZZZZZZZZ", mot_de_passe="ZZZZZZZZ", essais=1, delai=1.5)
    time.sleep(1.5)   # rate_limit : un nouveau client par seconde (voir creneau_nouveau_client)
    avant = _compte("client", IP_INCONNUE)
    assert envoyer() is None
    time.sleep(0.5)
    assert _compte("client", IP_INCONNUE) == avant, "routeur inconnu compté à tort comme silence de la base"

    verrou = psycopg.connect(host=PG_HOTE, dbname="wakatnet", user="wakatnet_admin",
                             password=os.environ["POSTGRES_PASSWORD"])
    try:
        verrou.execute("LOCK TABLE app.router IN ACCESS EXCLUSIVE MODE")
        time.sleep(1.5)
        assert envoyer() is None
        _attendre_silence("client", IP_INCONNUE, avant, delai=5.0)
    finally:
        verrou.rollback()
        verrou.close()
    assert all(LIGNE.match(l) for l in silences("client"))
