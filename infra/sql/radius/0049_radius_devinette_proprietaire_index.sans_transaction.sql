-- WAKATNET — migration 0049 : index du budget anti-devinette PAR PROPRIÉTAIRE (migration 0048, scan de sécurité F3).
-- SANS TRANSACTION (voir 0012 et migrer.sh) : CREATE INDEX CONCURRENTLY ne bloque ni authorize ni les INSERT de post_auth,
-- même sur un auth_log de 90 jours. Idempotente : une construction interrompue (index invalide) est reprise.
SET ROLE wakatnet_owner;

SELECT EXISTS (SELECT FROM pg_index i
                WHERE i.indexrelid = to_regclass('radius.auth_log_echecs_faibles_proprietaire')
                  AND NOT i.indisvalid) AS index_invalide \gset
\if :index_invalide
DROP INDEX CONCURRENTLY radius.auth_log_echecs_faibles_proprietaire;
\endif

-- Compte de radius._routeur_restreint et de post_auth : échecs de forme faible d'un propriétaire sur l'heure.
CREATE INDEX CONCURRENTLY IF NOT EXISTS auth_log_echecs_faibles_proprietaire
  ON radius.auth_log (tenant_id, at)
  WHERE forme_faible AND resultat = 'Reject' AND cause = 'ticket_inconnu';

-- Recherche de l'alerte budget_proprietaire déjà posée (post_auth, à chaque échec de forme faible).
SELECT EXISTS (SELECT FROM pg_index i
                WHERE i.indexrelid = to_regclass('radius.alerte_budget_proprietaire')
                  AND NOT i.indisvalid) AS index_alerte_invalide \gset
\if :index_alerte_invalide
DROP INDEX CONCURRENTLY radius.alerte_budget_proprietaire;
\endif
CREATE INDEX CONCURRENTLY IF NOT EXISTS alerte_budget_proprietaire
  ON radius.alerte (tenant_id, at) WHERE type = 'budget_proprietaire';

RESET ROLE;
