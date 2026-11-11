#!/usr/bin/env bash
# WAKATNET — test de fumée du chemin critique, après chaque migration (ADR 0009 §3).
#
# FreeRADIUS se tait sur TOUT échec SQL de client_lookup ou d'authorize (rlm_sql_map ne
# distingue pas une base arrêtée d'un droit retiré ou d'une exception). Un défaut de
# déploiement rendrait donc tout le parc muet. Ce script l'arrête avant : il exécute les
# fonctions du chemin critique AVEC LES DROITS des rôles de FreeRADIUS, dans une
# transaction en lecture seule annulée à la fin (aucune écriture possible).
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
SELECT count(*) FROM radius.authorize('FUMEEFUM', '10.213.255.253', '02-00-00-00-00-00', 'fumee');
SELECT count(*) FROM radius.authorize('', '', '', '');
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
  -- Borne principale du chemin critique (ADR 0006 §13) : sans elle, une requête lente
  -- n'est coupée qu'au query_timeout du pilote, avec reconnexion.
  IF NOT EXISTS (SELECT FROM pg_db_role_setting s
                  WHERE s.setrole = 'wk_radius'::regrole AND s.setdatabase = 0
                    AND 'statement_timeout=500ms' = ANY (s.setconfig)) THEN
    manque := manque || 'wk_radius : statement_timeout = 500ms absent'::text;
  END IF;
  IF cardinality(manque) > 0 THEN
    RAISE EXCEPTION 'fumée : %', array_to_string(manque, ' ; ');
  END IF;
END $$;
SQL
then
  echo "ÉCHEC du test de fumée : le chemin critique de FreeRADIUS est cassé (nœud muet). Voir l'erreur ci-dessus." >&2
  exit 1
fi
echo "fumée : client_lookup et authorize s'exécutent en tant que wk_radius ; droits et délais présents"
