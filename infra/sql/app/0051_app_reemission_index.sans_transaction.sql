-- WAKATNET — migration 0051 : index des tickets importés encore réémissibles (migration 0050). SANS TRANSACTION (voir
-- radius 0012 et migrer.sh) : CREATE INDEX CONCURRENTLY ne bloque pas l'accounting, qui met à jour app.voucher
-- (activated_at). Idempotente : une construction interrompue (index invalide) est reprise.
SET ROLE wakatnet_owner;

SELECT EXISTS (SELECT FROM pg_index i
                WHERE i.indexrelid = to_regclass('app.voucher_import_inutilise')
                  AND NOT i.indisvalid) AS index_invalide \gset
\if :index_invalide
DROP INDEX CONCURRENTLY app.voucher_import_inutilise;
\endif

CREATE INDEX CONCURRENTLY IF NOT EXISTS voucher_import_inutilise
  ON app.voucher (tenant_id, plan_id, id) WHERE origine = 'import' AND activated_at IS NULL AND reemis_par IS NULL;

RESET ROLE;
