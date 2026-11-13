-- WAKATNET — migration 0047 : index du budget horaire anti-devinette (migration 0046, scan de sécurité F3).
-- SANS TRANSACTION (voir 0012 et migrer.sh) : CREATE INDEX CONCURRENTLY ne bloque ni authorize ni les INSERT de post_auth,
-- même sur un auth_log de 90 jours. Idempotente : une construction interrompue (index invalide) est reprise.
SET ROLE wakatnet_owner;

SELECT EXISTS (SELECT FROM pg_index i
                WHERE i.indexrelid = to_regclass('radius.auth_log_echecs_faibles')
                  AND NOT i.indisvalid) AS index_invalide \gset
\if :index_invalide
DROP INDEX CONCURRENTLY radius.auth_log_echecs_faibles;
\endif

-- Compte de radius._routeur_restreint : échecs de forme faible d'un routeur sur l'heure.
CREATE INDEX CONCURRENTLY IF NOT EXISTS auth_log_echecs_faibles
  ON radius.auth_log (router_id, at)
  WHERE forme_faible AND resultat = 'Reject' AND cause = 'ticket_inconnu';

RESET ROLE;
