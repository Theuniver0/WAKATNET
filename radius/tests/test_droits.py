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
    "radius.acct_start(p_src text, p_session_id text, p_user text, p_calling text, p_framed_ip text, p_in_oct text, p_in_giga text, p_out_oct text, p_out_giga text, p_session_time text, p_cause text, p_received_epoch text)": {"wk_acct"},
    "radius.acct_interim(p_src text, p_session_id text, p_user text, p_calling text, p_framed_ip text, p_in_oct text, p_in_giga text, p_out_oct text, p_out_giga text, p_session_time text, p_cause text, p_received_epoch text)": {"wk_acct"},
    "radius.acct_stop(p_src text, p_session_id text, p_user text, p_calling text, p_framed_ip text, p_in_oct text, p_in_giga text, p_out_oct text, p_out_giga text, p_session_time text, p_cause text, p_received_epoch text)": {"wk_acct"},
    # Ticket 06.
    "radius.post_auth(p_user text, p_src text, p_calling text, p_result text, p_cause text)": {"wk_radius"},
    "radius.acct_on_off(p_src text, p_received_epoch text)": {"wk_acct"},
    "radius.close_ghost_sessions()": {"wk_maint"},
    "radius.marquer_spool_vide(p_epoch text)": {"wk_maint"},
    "radius.purge_auth_log(p_lot integer)": {"wk_maint"},
    # Ticket 09 : seul wk_coa lit le secret d'un routeur à partir d'une session (coa_target).
    "radius.sessions_to_cut(p_limite integer)": {"wk_coa"},
    "radius.coa_target(p_session bigint)": {"wk_coa"},
    "radius.mark_cut(p_session bigint, p_result text)": {"wk_coa"},
    # Phase 2, ticket 02 : contexte de la RLS, lu par les politiques sous wk_api (ADR 0012 §6).
    "app.tenant_courant()": {"wk_api"},
    # Ticket 03 : enrôlement (jeton, adresse, secret) en une transaction ; l'allocation est interne.
    "app.enroll_token_valide(p_empreinte bytea)": {"wk_api"},
    "app.enroll_register(p_empreinte bytea, p_cle text, p_coa_port integer, p_inventaire jsonb)": {"wk_api"},
    # Ticket 05 : wg-agent ne lit que les pairs voulus.
    "app.wg_pairs()": {"wk_wg"},
    # Ticket 07 : import d'un lot de tickets Mikhmon pour le propriétaire du contexte RLS.
    "app.voucher_importer(p_plans bigint[], p_codes text[])": {"wk_api"},
    # Phase 3 (ADR 0013 §11) : tout ce qui touche à l'argent passe par ces fonctions ; rien sur ledger.
    "app.credits_solde(p_tenant bigint)": {"wk_api"},
    "app.compte_marchand_enregistrer(p_fournisseur text, p_cles bytea)": {"wk_api"},
    "app.compte_marchand_par_webhook(p_fournisseur text, p_webhook_id text)": {"wk_api"},
    "app.compte_marchand_du_proprietaire(p_tenant bigint)": {"wk_api"},
    "app.portail_site(p_public_id text)": {"wk_api"},
    "app.portail_forfaits(p_public_id text)": {"wk_api"},
    "app.paiement_creer(p_public_id text, p_plan bigint, p_operateur text, p_numero_clair text, p_numero_hmac bytea, p_numero_masque text, p_jeton bytea, p_soumission text, p_reference text)": {"wk_api"},
    "app.paiement_transition(p_reference text, p_vers text, p_reference_fournisseur text, p_montant bigint, p_devise text, p_origine text)": {"wk_api"},
    "app.paiement_evenement(p_fournisseur text, p_id_evenement text, p_tenant bigint, p_reference text, p_corps bytea)": {"wk_api"},
    "app.paiement_du_proprietaire(p_reference text, p_tenant bigint)": {"wk_api"},
    "app.paiement_etat(p_public_id text, p_reference text, p_jeton bytea)": {"wk_api"},
    "app.paiement_par_jeton(p_public_id text, p_jeton bytea)": {"wk_api"},
    "app.paiement_retrouver(p_public_id text, p_numero_hmac bytea, p_suffixe text, p_jeton bytea)": {"wk_api"},
    "app.paiements_a_verifier(p_limite integer)": {"wk_api"},
    "app.paiement_replanifier(p_reference text)": {"wk_api"},
    "app.paiements_expirer()": {"wk_api"},
    "app.frais_papier_prelever(p_limite integer)": {"wk_api"},
    "app.numeros_purger()": {"wk_api"},
    "app.site_hotes_depuis_inventaire(p_router bigint)": {"wk_api"},
}


def test_wk_radius_et_wk_acct_ne_touchent_aucune_table_ni_sequence():
    with admin() as c:
        lignes = c.execute("""
            SELECT r.rolname, n.nspname || '.' || cl.relname
              FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
              CROSS JOIN (VALUES ('wk_radius'), ('wk_acct'), ('wk_maint'), ('wk_coa')) r(rolname)
             WHERE cl.relkind IN ('r', 'p', 'v', 'm', 'S')
               AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
               AND (has_table_privilege(r.rolname, cl.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                    OR (cl.relkind = 'S' AND has_sequence_privilege(r.rolname, cl.oid, 'USAGE, SELECT, UPDATE')))
        """).fetchall()
        schemas = c.execute("""
            SELECT r, s FROM (VALUES ('wk_radius'), ('wk_acct'), ('wk_maint'), ('wk_coa')) a(r), (VALUES ('app'), ('radius'), ('public')) b(s)
             WHERE has_schema_privilege(r, s, 'CREATE')
        """).fetchall()
    assert lignes == [], f"droits inattendus : {lignes}"
    assert schemas == [], f"CREATE inattendu : {schemas}"


def test_lecture_directe_refusee_en_pratique():
    with en_tant_que_radius() as c:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("SELECT secret FROM radius.router_secret LIMIT 1")


def test_chaque_role_n_execute_que_ses_fonctions():
    """wk_radius : client_lookup et authorize ; wk_acct : acct_start, acct_interim, acct_stop (ticket 04)."""
    with admin() as c:
        lignes = c.execute("""SELECT r.rolname, ns.nspname || '.' || p.proname
                                FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                                CROSS JOIN (VALUES ('wk_radius'), ('wk_acct'), ('wk_maint'), ('wk_coa'), ('wk_api'), ('wk_wg')) r(rolname)
                               WHERE ns.nspname IN ('app', 'radius', 'ledger') AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')
                               ORDER BY 1, 2""").fetchall()
    assert lignes == [("wk_acct", "radius.acct_interim"), ("wk_acct", "radius.acct_on_off"), ("wk_acct", "radius.acct_start"),
                      ("wk_acct", "radius.acct_stop"), ("wk_api", "app.compte_marchand_du_proprietaire"),
                      ("wk_api", "app.compte_marchand_enregistrer"), ("wk_api", "app.compte_marchand_par_webhook"),
                      ("wk_api", "app.credits_solde"), ("wk_api", "app.enroll_register"),
                      ("wk_api", "app.enroll_token_valide"), ("wk_api", "app.frais_papier_prelever"), ("wk_api", "app.numeros_purger"),
                      ("wk_api", "app.paiement_creer"), ("wk_api", "app.paiement_du_proprietaire"),
                      ("wk_api", "app.paiement_etat"), ("wk_api", "app.paiement_evenement"), ("wk_api", "app.paiement_par_jeton"),
                      ("wk_api", "app.paiement_replanifier"), ("wk_api", "app.paiement_retrouver"), ("wk_api", "app.paiement_transition"),
                      ("wk_api", "app.paiements_a_verifier"), ("wk_api", "app.paiements_expirer"),
                      ("wk_api", "app.portail_forfaits"), ("wk_api", "app.portail_site"), ("wk_api", "app.site_hotes_depuis_inventaire"),
                      ("wk_api", "app.tenant_courant"), ("wk_api", "app.voucher_importer"), ("wk_coa", "radius.coa_target"), ("wk_coa", "radius.mark_cut"),
                      ("wk_coa", "radius.sessions_to_cut"), ("wk_maint", "radius.close_ghost_sessions"),
                      ("wk_maint", "radius.marquer_spool_vide"), ("wk_maint", "radius.purge_auth_log"),
                      ("wk_radius", "radius.authorize"), ("wk_radius", "radius.client_lookup"), ("wk_radius", "radius.post_auth"),
                      ("wk_wg", "app.wg_pairs")]


def test_toute_fonction_security_definer_fixe_son_search_path():
    with admin() as c:
        fautives = c.execute("""
            SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname IN ('app', 'radius', 'ledger') AND p.prosecdef
               AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) x WHERE x LIKE 'search_path=%')
        """).fetchall()
    assert fautives == []


def test_exception_message_authenticator_tracee_par_routeur():
    """ADR 0003 : require_ma vaut 'yes' par défaut, 'no' seulement par exception en base."""
    with en_tant_que_radius() as c:
        assert c.execute("SELECT require_ma FROM radius.client_lookup('10.213.1.20')").fetchone() == ("yes",)
    with admin() as c:
        c.execute("UPDATE app.router SET require_ma_exception = true WHERE shortname = 'r2'")
    try:
        with en_tant_que_radius() as c:
            assert c.execute("SELECT require_ma FROM radius.client_lookup('10.213.1.20')").fetchone() == ("no",)
    finally:
        with admin() as c:
            c.execute("UPDATE app.router SET require_ma_exception = false WHERE shortname = 'r2'")


def test_execute_jamais_accorde_a_public_et_droits_exacts():
    with admin() as c:
        lignes = c.execute("""
            SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
                   p.proacl::text
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname IN ('app', 'radius', 'ledger')
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
