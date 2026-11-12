#!/usr/bin/env bash
# WAKATNET — test de fumée du chemin critique, après chaque migration (ADR 0009 §3).
#
# FreeRADIUS se tait sur TOUT échec SQL de client_lookup ou d'authorize (rlm_sql_map ne
# distingue pas une base arrêtée d'un droit retiré ou d'une exception). Un défaut de
# déploiement rendrait donc tout le parc muet. Ce script le DÉTECTE juste après les
# migrations (déjà validées, donc déjà servies : il ne les empêche pas) et fait échouer
# migrer.sh. Il exécute les fonctions du chemin critique AVEC LES DROITS des rôles de
# FreeRADIUS, dans une transaction en lecture seule annulée à la fin (aucune écriture).
# SET LOCAL ROLE ne vérifie pas la connexion : LOGIN, CONNECT et l'expiration du mot de
# passe sont contrôlés à part. Non couverts : mot de passe lui-même et pg_hba.conf.
#
# Appelé par migrer.sh ; peut être relancé seul :
#   bash infra/sql/fumee.sh
# Variables lues : PGUSER / PGDATABASE (ou POSTGRES_USER / POSTGRES_DB), et les variables
# libpq habituelles (PGHOST, PGPASSWORD). Aucune n'est passée en argument de commande.
# Code de sortie non nul au premier défaut.
set -euo pipefail

export PGUSER="${PGUSER:-${POSTGRES_USER:?POSTGRES_USER manquant}}"
export PGDATABASE="${PGDATABASE:-${POSTGRES_DB:?POSTGRES_DB manquant}}"

if ! psql -X -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
-- 1. Exécution réelle, en tant que wk_radius, des deux fonctions dont l'échec rend le nœud muet.
BEGIN TRANSACTION READ ONLY;
SET LOCAL ROLE wk_radius;
SELECT count(*) FROM radius.client_lookup('10.213.255.253');
SELECT count(*) FROM radius.client_lookup('pas-une-ip');
-- Contrat (ADR 0006 §1) : authorize rend UNE ligne. Sans ligne, map_auth rend « noop » et
-- tout le parc reçoit un Reject : ce n'est pas un silence, mais c'est aussi grave.
DO $$
DECLARE
  n_code bigint;
  n_vide bigint;
BEGIN
  SELECT count(*) INTO n_code FROM radius.authorize('FUMEEFUM', '10.213.255.253', '02-00-00-00-00-00', 'fumee');
  SELECT count(*) INTO n_vide FROM radius.authorize('', '', '', '');
  IF n_code <> 1 OR n_vide <> 1 THEN
    RAISE EXCEPTION 'fumée : radius.authorize doit rendre une ligne (code : %, vide : %)', n_code, n_vide;
  END IF;
END $$;
ROLLBACK;

-- 1 bis. Chemin d'un VRAI client (Accept), avec le statement_timeout du rôle, que SET ROLE
-- n'applique pas. Le routeur inconnu ci-dessus sort de authorize dès ses premières lignes :
-- une erreur plpgsql dans la recherche du ticket ou du forfait n'apparaîtrait qu'ici.
-- Données créées par le superutilisateur dans la transaction, puis ANNULÉES (ROLLBACK) :
-- rien ne reste en base. IP et nom choisis libres, pour ne heurter aucun routeur réel.
BEGIN;
DO $$
DECLARE
  v_tenant bigint; v_site bigint; v_router bigint; v_plan bigint; v_ip inet; v_delai text;
BEGIN
  SELECT ip INTO v_ip
    FROM generate_series(200, 253) n, LATERAL (SELECT ('10.213.255.' || n)::inet AS ip) x
   WHERE NOT EXISTS (SELECT FROM app.router r WHERE r.overlay_ip = x.ip)
   ORDER BY n DESC LIMIT 1;
  IF v_ip IS NULL THEN
    RAISE EXCEPTION 'fumée : aucune IP libre en 10.213.255.200-253 pour le routeur de fumée';
  END IF;
  INSERT INTO app.tenant (nom) VALUES ('fumée (annulé)') RETURNING id INTO v_tenant;
  INSERT INTO app.site (tenant_id, nom) VALUES (v_tenant, 'fumée') RETURNING id INTO v_site;
  INSERT INTO app.router (tenant_id, site_id, overlay_ip, shortname)
    VALUES (v_tenant, v_site, v_ip, 'fumee-' || md5(random()::text)) RETURNING id INTO v_router;
  INSERT INTO radius.router_secret (router_id, secret) VALUES (v_router, md5(random()::text));
  INSERT INTO app.plan (tenant_id, nom, prix_xof, uptime_limit_s)
    VALUES (v_tenant, 'fumée', 0, 3600) RETURNING id INTO v_plan;
  PERFORM set_config('wakatnet.fumee_ip', host(v_ip), true);
  PERFORM set_config('wakatnet.fumee_code', app.voucher_creer(v_tenant, v_plan), true);
  -- Délai du rôle, appliqué tel quel à la suite de la transaction.
  SELECT split_part(c, '=', 2) INTO v_delai
    FROM pg_db_role_setting s, unnest(s.setconfig) c
   WHERE s.setrole = 'wk_radius'::regrole AND s.setdatabase IN (0, (SELECT oid FROM pg_database
                                                                 WHERE datname = current_database()))
     AND c LIKE 'statement\_timeout=%'
   ORDER BY s.setdatabase DESC LIMIT 1;
  PERFORM set_config('statement_timeout', coalesce(v_delai, '0'), true);
END $$;
SET LOCAL ROLE wk_radius;
DO $$
DECLARE
  n_client bigint; v_decision text; v_cause text; n bigint;
BEGIN
  SELECT count(*) INTO n_client FROM radius.client_lookup(current_setting('wakatnet.fumee_ip'));
  SELECT count(*), max(decision), max(reply_message) INTO n, v_decision, v_cause
    FROM radius.authorize(current_setting('wakatnet.fumee_code'), current_setting('wakatnet.fumee_ip'),
                          '02-00-00-00-00-00', 'fumee');
  IF n_client <> 1 OR n <> 1 OR v_decision IS DISTINCT FROM 'Accept' THEN
    RAISE EXCEPTION 'fumée : client valide refusé (client_lookup : % ligne(s) ; authorize : % ligne(s), %, %)',
      n_client, n, v_decision, v_cause;
  END IF;
END $$;
ROLLBACK;

-- 2. Droits des fonctions qui écrivent (non exécutées ici) et délais des rôles.
DO $$
DECLARE
  manque text[] := '{}';
  f record;
BEGIN
  FOR f IN SELECT * FROM (VALUES
      ('wk_radius', 'radius.post_auth(text, text, text, text, text)'),
      ('wk_acct',   'radius.acct_start(text, text, text, text, text, text, text, text, text, text, text, text)'),
      ('wk_acct',   'radius.acct_interim(text, text, text, text, text, text, text, text, text, text, text, text)'),
      ('wk_acct',   'radius.acct_stop(text, text, text, text, text, text, text, text, text, text, text, text)'),
      ('wk_acct',   'radius.acct_on_off(text, text)')) AS v(role, fonction)
  LOOP
    IF to_regprocedure(f.fonction) IS NULL THEN
      manque := manque || format('%s : fonction absente', f.fonction);
    ELSIF NOT has_function_privilege(f.role, f.fonction, 'EXECUTE') THEN
      manque := manque || format('%s : EXECUTE manquant pour %s', f.fonction, f.role);
    END IF;
  END LOOP;
  -- Connexion des rôles de FreeRADIUS : SET LOCAL ROLE ci-dessus ne la vérifie pas.
  FOR f IN SELECT * FROM (VALUES ('wk_radius'), ('wk_acct')) AS v(role) LOOP
    IF NOT EXISTS (SELECT FROM pg_roles r WHERE r.rolname = f.role AND r.rolcanlogin
                     AND (r.rolvaliduntil IS NULL OR r.rolvaliduntil > now())) THEN
      manque := manque || format('%s : LOGIN retiré ou mot de passe expiré', f.role);
    END IF;
    IF NOT has_database_privilege(f.role, current_database(), 'CONNECT') THEN
      manque := manque || format('%s : CONNECT manquant sur la base %s', f.role, current_database());
    END IF;
  END LOOP;
  -- Borne principale du chemin critique (ADR 0006 §13) : sans elle, une requête lente
  -- n'est coupée qu'au query_timeout du pilote, avec reconnexion.
  -- Valeur lue telle que PostgreSQL l'applique (500ms, 0.5s et 500 sont équivalents),
  -- posée pour le rôle seul ou pour le rôle dans cette base : 0 < délai <= 500 ms.
  FOR f IN
    SELECT c.nom, (SELECT split_part(x, '=', 2)
                     FROM pg_db_role_setting s, unnest(s.setconfig) x
                    WHERE s.setrole = c.role::regrole
                      AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
                      AND x LIKE c.nom || '=%'
                    ORDER BY s.setdatabase DESC LIMIT 1) AS valeur, c.role
      FROM (VALUES ('wk_radius', 'statement_timeout'), ('wk_radius', 'log_min_error_statement'),
                   ('wk_acct', 'log_min_error_statement')) AS c(role, nom)
  LOOP
    IF f.valeur IS NULL THEN
      manque := manque || format('%s : %s absent', f.role, f.nom);
    ELSIF f.nom = 'statement_timeout' THEN
      PERFORM set_config('statement_timeout', f.valeur, true);
      IF (SELECT setting::bigint FROM pg_settings WHERE name = 'statement_timeout') NOT BETWEEN 1 AND 500 THEN
        manque := manque || format('wk_radius : statement_timeout = %s (attendu : de 1 à 500 ms)', f.valeur);
      END IF;
      PERFORM set_config('statement_timeout', '0', true);
    ELSIF f.valeur <> 'panic' THEN
      -- ADR 0006 §10 : les requêtes de FreeRADIUS portent le code du ticket en clair.
      manque := manque || format('%s : log_min_error_statement = %s (le code serait journalisé)', f.role, f.valeur);
    END IF;
  END LOOP;
  IF cardinality(manque) > 0 THEN
    RAISE EXCEPTION 'fumée : %', array_to_string(manque, ' ; ');
  END IF;
END $$;
SQL
then
  echo "ÉCHEC du test de fumée : le chemin critique de FreeRADIUS est cassé (nœud muet). Voir l'erreur ci-dessus." >&2
  exit 1
fi
echo "fumée : client_lookup et authorize s'exécutent en tant que wk_radius (refus et Accept, sous son délai) ; connexion, droits, délais et journalisation présents"
