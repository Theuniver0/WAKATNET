-- L2 : exécuté en tant que wk_radius (connexion TCP par mot de passe, comme FreeRADIUS).
-- Chaque requête « interdite » doit échouer ; ON_ERROR_STOP est donc désactivé ici.
\set ON_ERROR_STOP off
\echo '--- identité de la session'
SELECT current_user, session_user;
\echo '--- [doit RÉUSSIR] fonction radius.client_lookup'
SELECT * FROM radius.client_lookup('10.213.1.10');
\echo '--- [doit RÉUSSIR] fonction radius.authorize (jouet)'
SELECT attribute, op, kind FROM radius.authorize('TICKETLAB1', '10.213.1.10', 'AA-BB-CC-00-00-01', 'hotspot1');
\echo '--- [doit ÉCHOUER] lecture directe de app.routers'
SELECT * FROM app.routers;
\echo '--- [doit ÉCHOUER] lecture directe de app.tickets_lab'
SELECT * FROM app.tickets_lab;
\echo '--- [doit ÉCHOUER] lecture du grand livre ledger.entries'
SELECT * FROM ledger.entries;
\echo '--- [doit ÉCHOUER] écriture dans app.routers'
UPDATE app.routers SET active = true;
\echo '--- [doit ÉCHOUER] création d objet dans le schéma radius'
CREATE TABLE radius.pirate (x int);
\echo '--- [doit ÉCHOUER] création d objet dans le schéma public'
CREATE TABLE public.pirate (x int);
\echo '--- privilèges effectifs (information_schema)'
SELECT routine_schema, routine_name, privilege_type
  FROM information_schema.routine_privileges WHERE grantee = 'wk_radius' ORDER BY 2;
-- (has_table_privilege('app.routers') échoue faute d'USAGE sur le schéma : on passe par l'OID.)
SELECT n.nspname AS schema, c.relname AS table_name,
       has_table_privilege('wk_radius', c.oid, 'SELECT') AS can_select,
       has_table_privilege('wk_radius', c.oid, 'UPDATE') AS can_update
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname IN ('app', 'ledger') AND c.relkind = 'r' ORDER BY 1, 2;
SELECT n.nspname AS schema, has_schema_privilege('wk_radius', n.oid, 'USAGE') AS usage,
       has_schema_privilege('wk_radius', n.oid, 'CREATE') AS create
  FROM pg_namespace n WHERE n.nspname IN ('app', 'ledger', 'radius', 'public') ORDER BY 1;
