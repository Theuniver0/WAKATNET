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

from hypothesis import given, settings
from hypothesis import strategies as st

import radlib
from conftest import (IP_INCONNUE, PG_HOTE, ROUTEURS, SERVEUR, admin, demander, en_tant_que_radius,
                      nouveau_ticket, silences)

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
    aussitôt, sans attendre retry_delay (5 s). Que ce soit la même connexion n'est pas vérifié."""
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
    assert time.monotonic() - debut < 0.3, "après un 57014, aucun retry_delay ne doit s'appliquer"


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


def test_fumee_detecte_connect_retire():
    """La fumée passe par SET LOCAL ROLE, qui ne vérifie pas la connexion. Un droit CONNECT
    retiré rend pourtant le nœud muet (FreeRADIUS ne peut plus ouvrir de connexion)."""
    try:
        with admin() as c:
            c.execute("REVOKE CONNECT ON DATABASE wakatnet FROM PUBLIC")
        r = _fumee()
        assert r.returncode != 0, "la fumée doit refuser un CONNECT retiré"
        assert "CONNECT" in r.stderr and "ÉCHEC du test de fumée" in r.stderr, r.stderr
        # migrer.sh échoue avec elle (le déploiement ne peut pas se croire réussi).
        env = dict(os.environ, PGHOST=PG_HOTE, PGUSER="wakatnet_admin", PGDATABASE="wakatnet",
                   PGPASSWORD=os.environ["POSTGRES_PASSWORD"])
        m = subprocess.run(["bash", "/depot/infra/sql/migrer.sh"], capture_output=True, text=True, env=env,
                           timeout=120)
        assert m.returncode != 0 and "ÉCHEC du test de fumée" in m.stderr, m.stdout + m.stderr
    finally:
        with admin() as c:
            c.execute("GRANT CONNECT ON DATABASE wakatnet TO PUBLIC")
    assert _fumee().returncode == 0


def test_fumee_detecte_un_authorize_sans_ligne():
    """Contrat (ADR 0006 §1) : authorize rend UNE ligne. Sans ligne, map_auth rend « noop » :
    pas de silence, mais un Reject ticket_inconnu pour TOUT le parc. La fumée doit le voir."""
    code = nouveau_ticket()
    with admin() as c:
        oid = c.execute("SELECT %s::regprocedure::oid", (SIGNATURE,)).fetchone()[0]
        origine, arguments, resultat = c.execute(
            "SELECT pg_get_functiondef(%s), pg_get_function_arguments(%s), pg_get_function_result(%s)",
            (oid, oid, oid)).fetchone()
    try:
        with admin() as c:
            c.execute(f"CREATE OR REPLACE FUNCTION radius.authorize({arguments}) RETURNS {resultat} "
                      "LANGUAGE sql AS $f$ SELECT NULL::text, NULL::text, NULL::text, NULL::bigint, "
                      "NULL::text, NULL::integer, NULL::integer WHERE false $f$")
        r = demander("r1", code=code, essais=1, delai=1.5)
        assert r is not None and r.nom == "Access-Reject", "sans ligne : refus pour tous (et non silence)"
        r = _fumee()
        assert r.returncode != 0, "la fumée doit refuser un authorize sans ligne"
        assert "authorize" in r.stderr and "ÉCHEC du test de fumée" in r.stderr, r.stderr
    finally:
        with admin() as c:
            c.execute(origine)
    r = demander("r1", code=code)
    assert r is not None and r.nom == "Access-Accept"
    assert _fumee().returncode == 0


def test_fumee_suit_le_chemin_accept_sous_le_delai_du_role():
    """Seule la branche Accept de authorize lit radius.session (appareils, temps consommé).
    Table verrouillée : la fumée doit échouer par le statement_timeout du rôle (que SET ROLE
    n'applique pas d'office), et non attendre sans fin ni passer par la branche « routeur inconnu »."""
    verrou = psycopg.connect(host=PG_HOTE, dbname="wakatnet", user="wakatnet_admin",
                             password=os.environ["POSTGRES_PASSWORD"])
    try:
        verrou.execute("LOCK TABLE radius.session IN ACCESS EXCLUSIVE MODE")
        debut = time.monotonic()
        r = _fumee()
        duree = time.monotonic() - debut
    finally:
        verrou.rollback()
        verrou.close()
    assert r.returncode != 0, "la fumée doit exécuter la branche Accept (verrou non rencontré)"
    assert "statement timeout" in r.stderr and "ÉCHEC du test de fumée" in r.stderr, r.stderr
    assert duree < 10, f"{duree:.1f} s"
    assert _fumee().returncode == 0
    with admin() as c:   # rien ne reste du client de fumée (transaction annulée)
        assert c.execute("SELECT count(*) FROM app.tenant WHERE nom LIKE 'fumée%'").fetchone()[0] == 0


@pytest.mark.parametrize("parametre, retour", [("statement_timeout", "SET statement_timeout = '500ms'"),
                                               ("log_min_error_statement", "SET log_min_error_statement = 'panic'")])
def test_fumee_detecte_un_reglage_du_role_retire(parametre, retour):
    try:
        with admin() as c:
            c.execute(f"ALTER ROLE wk_radius RESET {parametre}")
        r = _fumee()
        assert r.returncode != 0 and parametre in r.stderr, r.stdout + r.stderr
    finally:
        with admin() as c:
            c.execute(f"ALTER ROLE wk_radius {retour}")
    assert _fumee().returncode == 0


def test_fumee_accepte_un_delai_ecrit_autrement():
    """0.5s vaut 500ms : pas d'échec à tort sur l'écriture de la valeur."""
    try:
        with admin() as c:
            c.execute("ALTER ROLE wk_radius SET statement_timeout = '0.5s'")
        r = _fumee()
        assert r.returncode == 0, r.stdout + r.stderr
    finally:
        with admin() as c:
            c.execute("ALTER ROLE wk_radius SET statement_timeout = '500ms'")


def test_utf8_invalide_dans_le_user_name_ne_rend_pas_le_noeud_muet():
    """Une donnée ne doit jamais faire échouer authorize (ADR 0009 §1) : des octets qui ne sont
    pas de l'UTF-8 valide donnent un refus, pas un silence compté."""
    ip = ROUTEURS["r1"][0]
    avant = _compte("auth", ip)
    for octets in (b"\xff\xfe\xfd\xfc", b"AB\xc3(CD", b"\xe2\x82"):
        r = demander("r1", code=octets, mot_de_passe="ZZZZZZZZ", essais=1, delai=1.5)
        assert r is not None and r.nom == "Access-Reject", f"{octets!r} : silence ou Accept"
    time.sleep(0.3)
    assert _compte("auth", ip) == avant


TEXTE = st.text(st.characters(blacklist_characters="\x00", blacklist_categories=("Cs",)), max_size=80)


@settings(max_examples=200, deadline=None, database=None)
@given(user=TEXTE, src=st.one_of(TEXTE, st.sampled_from([ROUTEURS["r1"][0], IP_INCONNUE, "", "999.1.1.1"])),
       calling=TEXTE, called=TEXTE)
def test_propriete_authorize_et_client_lookup_ne_levent_jamais(user, src, calling, called):
    """Justification de l'écart de l'ADR 0009 §1 : aucune entrée ne fait échouer ces fonctions.
    En tant que wk_radius, toute entrée donne UNE ligne d'authorize (Accept ou Reject) et au
    plus une ligne de client_lookup, sans exception."""
    with en_tant_que_radius() as c:
        lignes = c.execute("SELECT decision FROM radius.authorize(%s, %s, %s, %s)",
                           (user, src, calling, called)).fetchall()
        assert len(lignes) == 1 and lignes[0][0] in ("Accept", "Reject"), lignes
        assert len(c.execute("SELECT * FROM radius.client_lookup(%s)", (src,)).fetchall()) <= 1
