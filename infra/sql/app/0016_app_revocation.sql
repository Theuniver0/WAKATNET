-- WAKATNET — migration 0016 : révocation d'un routeur par son propriétaire (phase 2, ticket 06).
-- Ticket : .scratch/phase-2-multi-proprietaires/issues/06-revocation.md
-- wk_api ne peut changer QUE la colonne actif, et seulement sur les routeurs que la RLS lui
-- montre (politique cloisonnement, USING et WITH CHECK). Le déclencheur notifier_pairs
-- (migration 0015) réveille wg-agent, qui retire le pair.
SET ROLE wakatnet_owner;
GRANT UPDATE (actif) ON app.router TO wk_api;
RESET ROLE;
