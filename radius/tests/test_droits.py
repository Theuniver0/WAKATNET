"""Droits PostgreSQL (C7, ADR 0006 §1, ADR 0007, ADR 0008 §3 bis) — rejeu de L2.

wk_radius n'exécute que ses fonctions ; il ne lit aucune table ; EXECUTE n'est
jamais accordé à PUBLIC ; il ne peut pas déplacer l'horloge ; authorize tourne
dans une transaction en lecture seule (préparation de T13, nœud B sur réplique).
"""
import os
import pathlib
import re

import psycopg
import pytest

from conftest import admin, en_tant_que_radius, nouveau_ticket

DEPOT = pathlib.Path("/depot")

# Droits attendus EXACTEMENT, par fonction (ADR 0006 §1). Complété ticket après ticket.
ATTENDU = {
    "radius.client_lookup(p_src text)": {"wk_radius"},
    "radius.authorize(p_user text, p_src text, p_calling text, p_called text)": {"wk_radius"},
}


@pytest.mark.parametrize("table", ["app.voucher", "app.router", "app.tenant", "radius.router_secret", "radius.parametre"])
def test_wk_radius_ne_lit_aucune_table(table):
    with en_tant_que_radius() as c:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute(f"SELECT * FROM {table} LIMIT 1")


def test_execute_jamais_accorde_a_public_et_droits_exacts():
    with admin() as c:
        lignes = c.execute("""
            SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
                   p.proacl::text
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname IN ('app', 'radius')
        """).fetchall()
    for nom, acl in lignes:
        assert acl is not None, f"{nom} : ACL par défaut (EXECUTE à PUBLIC)"
        assert not re.search(r"(^|[{,])=X", acl), f"{nom} : EXECUTE accordé à PUBLIC ({acl})"
        roles = {e.split("=")[0] for e in acl.strip("{}").split(",")} - {"wakatnet_owner", "wk_test"}
        attendu = ATTENDU.get(nom, set())
        assert roles == attendu, f"{nom} : rôles {roles}, attendu {attendu}"


def test_wk_radius_ne_peut_pas_deplacer_l_horloge():
    with en_tant_que_radius() as c:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("SELECT * FROM radius._authorize_at('X', '10.213.1.10', '', '', now() - interval '1 day')")
    code = nouveau_ticket()
    with en_tant_que_radius() as c:
        normal = c.execute("SELECT session_timeout FROM radius.authorize(%s, '10.213.1.10', '', '')", (code,)).fetchone()
        c.execute("SET wakatnet.now = '2000-01-01 00:00:00+00'")
        apres = c.execute("SELECT session_timeout FROM radius.authorize(%s, '10.213.1.10', '', '')", (code,)).fetchone()
    assert normal == apres == (3600,)


def test_authorize_en_lecture_seule():
    code = nouveau_ticket()
    with en_tant_que_radius() as c:
        c.autocommit = False
        c.execute("SET TRANSACTION READ ONLY")
        ligne = c.execute("SELECT decision, session_timeout FROM radius.authorize(%s, '10.213.1.10', '', '')", (code,)).fetchone()
        c.rollback()
    assert ligne == ('Accept', 3600)


def test_fonction_interne_accessible_au_seul_role_de_test():
    """La forme (a) de l'ADR 0007 fonctionne pour les tests SQL."""
    code = nouveau_ticket()
    with psycopg.connect(host="172.29.215.5", dbname="wakatnet", user="wk_test",
                         password=os.environ["WAKATNET_PG_TEST_PASSWORD"]) as c:
        st = c.execute("SELECT session_timeout FROM radius._authorize_at(%s, '10.213.1.10', '', '', now())", (code,)).fetchone()
    assert st == (3600,)


def test_migrations_de_production_sans_objet_de_test():
    for f in sorted((DEPOT / "infra/sql").rglob("*.sql")):
        texte = f.read_text(encoding="utf-8").lower()
        assert "wk_test" not in texte, f"{f} mentionne le rôle de test"
        assert "wakatnet.now" not in texte, f"{f} lit un réglage d'horloge"
