"""Anti-devinette sous attaque — suite de la mesure du ticket 10 (RAPPORT.md §7, migration 0012).

Ticket : .scratch/phase-1-coeur-radius/issues/10-performance.md
Mesuré au ticket 10 : sous attaque (beaucoup d'échecs récents sur un routeur, MAC toutes
différentes) et avec des statistiques non rafraîchies, la recherche des échecs d'UNE MAC passait
par l'index PAR ROUTEUR et filtrait la MAC : 44 ms par authorize à 100 000 échecs récents.
Corrigé structurellement : l'index par routeur porte sur (router_id + 0), qu'une condition
« router_id = … » ne peut pas utiliser. Ces tests le prouvent par les compteurs d'index de
PostgreSQL, sans dépendre d'une durée.
"""
import os
import subprocess
import threading
import time
import uuid

import psycopg

from conftest import PG_HOTE, ROUTEURS, admin, en_tant_que_radius, en_tant_que_test, nouveau_ticket

R5 = ROUTEURS["r5"][0]   # routeur réservé aux essais en base (tickets 03 et 07)
INDEX_ROUTEUR = "auth_log_echecs_routeur_expr"
ANCIEN_INDEX = "auth_log_echecs_routeur"


def _parcours(c, index: str) -> int:
    c.execute("SELECT pg_stat_force_next_flush()")
    return c.execute("SELECT coalesce(sum(idx_scan), 0) FROM pg_stat_user_indexes WHERE indexrelname = %s",
                     (index,)).fetchone()[0]


def _attaque(n: int) -> None:
    """n échecs ticket_inconnu récents sur r5, chacun d'une MAC différente, SANS ANALYZE."""
    with admin() as c:
        c.execute("""INSERT INTO radius.auth_log (at, router_id, tenant_id, mac, resultat, cause)
                     SELECT now() - random() * interval '4 minutes', r.id, r.tenant_id,
                            '02FA' || lpad(to_hex(g), 8, '0'), 'Reject', 'ticket_inconnu'
                       FROM app.router r, generate_series(1, %s) g WHERE r.overlay_ip = %s""", (n, R5))


# MAC propres à ces tests : tout ce qu'ils écrivent sur r5 est retiré ensuite, pour ne pas fausser
# les seuils de l'anti-devinette des autres tests (le seuil de 100 échecs par routeur du ticket 07).
MAC_DES_TESTS = ("02FB00000001", "02ABCDEF1202")


def _nettoyer() -> None:
    with admin() as c:
        c.execute("DELETE FROM radius.auth_log WHERE mac LIKE '02FA%%' OR mac = ANY(%s)", (list(MAC_DES_TESTS),))
        c.execute("""DELETE FROM radius.alerte a USING app.router r
                      WHERE r.id = a.router_id AND r.overlay_ip = %s AND a.type = 'echecs_routeur'
                        AND a.at >= now() - interval '10 minutes'""", (R5,))


def test_authorize_d_un_vrai_client_n_utilise_jamais_l_index_par_routeur():
    _attaque(20000)
    try:
        code = nouveau_ticket()
        with admin() as c:
            avant = _parcours(c, INDEX_ROUTEUR)
        with en_tant_que_test() as c:
            for _ in range(5):
                d = c.execute("SELECT decision FROM radius._authorize_at(%s, %s, '02-AB-CD-EF-10-01', 'h', now())",
                              (code, R5)).fetchone()[0]
                assert d == "Accept"
        with admin() as c:
            apres = _parcours(c, INDEX_ROUTEUR)
        assert apres == avant, f"authorize a parcouru l'index par routeur ({apres - avant} fois) : coût linéaire sous attaque"
    finally:
        _nettoyer()


def test_post_auth_sous_attaque_compte_au_plus_jusqu_au_seuil_et_alerte_une_fois():
    """Les comptes d'alerte de post_auth s'arrêtent au seuil (LIMIT) ; l'alerte par routeur
    reste levée, une seule fois par fenêtre."""
    _attaque(5000)
    try:
        with admin() as c:
            avant = c.execute("""SELECT count(*) FROM radius.alerte a JOIN app.router r ON r.id = a.router_id
                                  WHERE a.type = 'echecs_routeur' AND r.overlay_ip = %s
                                    AND a.at >= now() - interval '60 seconds'""", (R5,)).fetchone()[0]
        with en_tant_que_radius() as c:
            for _ in range(3):
                assert c.execute("SELECT radius.post_auth(%s, %s, %s, 'Reject', 'ticket_inconnu')",
                                 ("ZZZZ" + uuid.uuid4().hex[:4].upper(), R5,
                                  "02-FB-00-00-00-01")).fetchone()[0] == "ok"
        with admin() as c:
            apres = c.execute("""SELECT count(*) FROM radius.alerte a JOIN app.router r ON r.id = a.router_id
                                  WHERE a.type = 'echecs_routeur' AND r.overlay_ip = %s
                                    AND a.at >= now() - interval '60 seconds'""", (R5,)).fetchone()[0]
        assert apres == max(avant, 1), (avant, apres)
    finally:
        _nettoyer()


def test_l_index_par_routeur_porte_sur_l_expression_et_l_ancien_a_disparu():
    with admin() as c:
        definition = c.execute("SELECT pg_get_indexdef(%s::regclass)", (f"radius.{INDEX_ROUTEUR}",)).fetchone()[0]
        ancien = c.execute("SELECT to_regclass(%s)", (f"radius.{ANCIEN_INDEX}",)).fetchone()[0]
        valide = c.execute("SELECT indisvalid FROM pg_index WHERE indexrelid = %s::regclass",
                           (f"radius.{INDEX_ROUTEUR}",)).fetchone()[0]
    assert "(router_id + 0)" in definition, definition
    assert ancien is None and valide


FICHIER_0012 = "0012_radius_devinette_sous_attaque.sans_transaction.sql"
# Migrations postérieures qui redéfinissent une fonction de 0012 : rejouer 0012 les écraserait ;
# elles sont donc rejouées avec elle, dans l'ordre de migrer.sh (phase 5 : garde de réplique, T13).
SUIVANTES_0012 = ("0027_radius_post_auth_replique.sql",)


def test_migration_0012_ne_bloque_ni_authorize_ni_post_auth_sur_une_table_vivante():
    """Revue du 12/11/2026 : une construction d'index en transaction bloquait les INSERT de
    post_auth ; un DROP INDEX en attente derrière un lecteur long faisait attendre tous les
    authorize. On rejoue la migration (état d'avant recréé) PENDANT qu'une transaction longue
    lit auth_log : authorize et post_auth doivent répondre vite tout au long, et la migration
    finit (lock_timeout, nouveaux essais) une fois le lecteur parti."""
    with admin() as c:   # état d'avant 0012 : ancien index, nouvel index absent, fichier non appliqué
        c.execute(f"DROP INDEX radius.{INDEX_ROUTEUR}")
        c.execute(f"""CREATE INDEX {ANCIEN_INDEX} ON radius.auth_log (router_id, at)
                      WHERE resultat = 'Reject' AND cause = 'ticket_inconnu'""")
        c.execute("DELETE FROM public.schema_migrations WHERE fichier = ANY(%s)", ([FICHIER_0012, *SUIVANTES_0012],))
    lecteur = psycopg.connect(host=PG_HOTE, dbname="wakatnet", user="wakatnet_admin",
                              password=os.environ["POSTGRES_PASSWORD"])
    lecteur.execute("SELECT count(*) FROM radius.auth_log")       # transaction ouverte, verrou tenu
    env = dict(os.environ, PGHOST=PG_HOTE, PGUSER="wakatnet_admin", PGDATABASE="wakatnet",
               PGPASSWORD=os.environ["POSTGRES_PASSWORD"])
    migration = subprocess.Popen(["bash", "/depot/infra/sql/migrer.sh"], env=env, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True)
    code = nouveau_ticket()
    pire = 0.0
    try:
        fin = time.monotonic() + 4          # le lecteur tient 4 s : la migration doit attendre
        while time.monotonic() < fin:
            debut = time.monotonic()
            with en_tant_que_test() as c:
                assert c.execute("SELECT decision FROM radius._authorize_at(%s, %s, '02-AB-CD-EF-12-01', 'h', now())",
                                 (code, R5)).fetchone()[0] == "Accept"
            with en_tant_que_radius() as c:
                assert c.execute("SELECT radius.post_auth(%s, %s, '02-AB-CD-EF-12-02', 'Reject', 'ticket_inconnu')",
                                 ("ZZZZ" + uuid.uuid4().hex[:4].upper(), R5)).fetchone()[0] == "ok"
            pire = max(pire, time.monotonic() - debut)
            time.sleep(0.1)
        assert migration.poll() is None, "la migration aurait dû attendre le lecteur : " + migration.stdout.read()
    finally:
        lecteur.rollback()
        lecteur.close()
    sortie, _ = migration.communicate(timeout=120)
    _nettoyer()
    print(f"migration sous lecteur long : pire authorize + post_auth {pire * 1000:.0f} ms")
    assert migration.returncode == 0, sortie
    assert "verrou indisponible pour " + FICHIER_0012 in sortie, sortie   # elle a bien attendu, sans bloquer
    assert pire < 0.4, f"authorize + post_auth ont attendu {pire:.2f} s pendant la migration"
    test_l_index_par_routeur_porte_sur_l_expression_et_l_ancien_a_disparu()
    with admin() as c:   # la version courante de post_auth est revenue, garde de réplique comprise
        definition = c.execute("SELECT pg_get_functiondef('radius.post_auth(text,text,text,text,text)'::regprocedure)").fetchone()[0]
    assert "pg_is_in_recovery()" in definition
