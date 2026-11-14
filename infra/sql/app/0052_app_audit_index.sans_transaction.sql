-- WAKATNET — migration 0052 : index du journal d'audit (relecture du 14/11/2026). app.audit_log n'en avait aucun, alors
-- qu'il est lu à chaque rechargement (idempotence par action et objet : 0019, 0024 ; chemin de l'argent), par les alertes
-- de crédits (0019, 0041) et par la réconciliation des réémissions (0050) : chaque lecture parcourait tout le journal.
-- SANS TRANSACTION (voir radius 0012 et migrer.sh) : CREATE INDEX CONCURRENTLY ne bloque pas les écritures du journal.
-- Idempotente : une construction interrompue (index invalide) est reprise.
SET ROLE wakatnet_owner;

SELECT EXISTS (SELECT FROM pg_index i
                WHERE i.indexrelid = to_regclass('app.audit_log_action_objet') AND NOT i.indisvalid) AS objet_invalide \gset
\if :objet_invalide
DROP INDEX CONCURRENTLY app.audit_log_action_objet;
\endif
-- « Cette action a-t-elle déjà eu lieu sur cet objet ? » (rechargements, alertes notifiées, réémissions).
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_action_objet ON app.audit_log (action, objet);

SELECT EXISTS (SELECT FROM pg_index i
                WHERE i.indexrelid = to_regclass('app.audit_log_action_le') AND NOT i.indisvalid) AS le_invalide \gset
\if :le_invalide
DROP INDEX CONCURRENTLY app.audit_log_action_le;
\endif
-- « Les alertes de crédits des 7 derniers jours » (0041).
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_action_le ON app.audit_log (action, le);

SELECT EXISTS (SELECT FROM pg_index i
                WHERE i.indexrelid = to_regclass('app.audit_log_action_proprietaire') AND NOT i.indisvalid) AS proprio_invalide \gset
\if :proprio_invalide
DROP INDEX CONCURRENTLY app.audit_log_action_proprietaire;
\endif
-- « Une alerte plus récente pour ce propriétaire ? » (0041 : action, tenant_id, id > …).
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_action_proprietaire ON app.audit_log (action, tenant_id, id);

SELECT EXISTS (SELECT FROM pg_index i
                WHERE i.indexrelid = to_regclass('app.audit_log_le') AND NOT i.indisvalid) AS purge_invalide \gset
\if :purge_invalide
DROP INDEX CONCURRENTLY app.audit_log_le;
\endif
-- Purge à 5 ans (radius 0040 : le < …, ORDER BY le LIMIT), toutes actions confondues.
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_le ON app.audit_log (le);

RESET ROLE;
