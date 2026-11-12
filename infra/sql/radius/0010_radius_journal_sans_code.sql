-- WAKATNET — migration 0010 : aucun code de ticket dans le journal de PostgreSQL (ticket 08, revue).
-- Ticket : .scratch/phase-1-coeur-radius/issues/08-base-indisponible.md
-- Contrat : ADR 0006 §10 (jamais de code en clair dans un journal) ; ADR 0009 §4.
--
-- Constaté en exécution le 12/11/2026 : avec log_min_error_statement = error (défaut),
-- toute erreur d'une requête de FreeRADIUS (statement_timeout, droit retiré, exception)
-- écrit « STATEMENT: SELECT … radius.authorize('<code>', …) » dans le journal de la base.
-- Les requêtes de FreeRADIUS portent le code en clair (rlm_sql interpole le User-Name) :
-- pour ses deux rôles, l'instruction n'est jamais journalisée, seule l'erreur l'est.
-- Paramètres réservés au superutilisateur (SUSET) : posés hors SET ROLE.

ALTER ROLE wk_radius SET log_min_error_statement = 'panic';
ALTER ROLE wk_acct SET log_min_error_statement = 'panic';
ALTER ROLE wk_radius SET log_min_duration_statement = -1;
ALTER ROLE wk_acct SET log_min_duration_statement = -1;
ALTER ROLE wk_radius SET log_statement = 'none';
ALTER ROLE wk_acct SET log_statement = 'none';
