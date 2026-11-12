-- WAKATNET — migration 0013 : rôle de l'API, jeton d'enrôlement, RLS (phase 2, ticket 02).
-- Ticket : .scratch/phase-2-multi-proprietaires/issues/02-socle-applicatif.md
-- Contrats : ADR 0012 §2, §3, §4, §6. Un seul historique de migrations (ADR 0012 §5).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wk_api') THEN
    CREATE ROLE wk_api LOGIN;
  END IF;
END $$;

SET ROLE wakatnet_owner;

-- ---------------------------------------------------------------------------
-- Routeur enrôlé : clé publique WireGuard et inventaire envoyé par l'étape 1.
-- Clé : 32 octets en base64 (44 caractères, « = » final). Unique : deux routeurs
-- ne partagent jamais un pair.
-- ---------------------------------------------------------------------------
ALTER TABLE app.router
  ADD COLUMN wg_public_key text UNIQUE CHECK (wg_public_key ~ '^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$'),
  ADD COLUMN inventaire    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN enrole_le     timestamptz;

-- ---------------------------------------------------------------------------
-- Jeton d'enrôlement (ADR 0012 §3) : seule l'empreinte SHA-256 est stockée.
-- ---------------------------------------------------------------------------
CREATE TABLE app.enrollment_token (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   bigint NOT NULL,
  site_id     bigint NOT NULL,
  empreinte   bytea  NOT NULL UNIQUE CHECK (length(empreinte) = 32),
  cree_le     timestamptz NOT NULL DEFAULT now(),
  expire_le   timestamptz NOT NULL,
  consomme_le timestamptz,
  router_id   bigint REFERENCES app.router (id),
  CHECK (expire_le > cree_le),
  CHECK ((consomme_le IS NULL) = (router_id IS NULL)),
  FOREIGN KEY (tenant_id, site_id) REFERENCES app.site (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Droits de wk_api : le strict nécessaire des routes de la phase 2. Rien sur radius.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA app TO wk_api;
GRANT SELECT (id, suspendu) ON app.tenant TO wk_api;
GRANT SELECT ON app.site, app.router, app.plan, app.voucher, app.enrollment_token TO wk_api;
GRANT INSERT ON app.enrollment_token, app.audit_log TO wk_api;
GRANT SELECT ON app.audit_log TO wk_api;

-- ---------------------------------------------------------------------------
-- RLS (ADR 0012 §6). Sans contexte : zéro ligne. Le propriétaire des tables
-- (wakatnet_owner), donc les fonctions radius.* en SECURITY DEFINER, n'y est pas
-- soumis : pas de FORCE ROW LEVEL SECURITY.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.tenant_courant() RETURNS bigint
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('wakatnet.tenant_id', true), '')::bigint $$;
REVOKE ALL ON FUNCTION app.tenant_courant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_courant() TO wk_api;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['site', 'router', 'plan', 'voucher', 'audit_log', 'enrollment_token'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY cloisonnement ON app.%I TO wk_api
                      USING (tenant_id = app.tenant_courant())
                      WITH CHECK (tenant_id = app.tenant_courant())', t);
  END LOOP;
END $$;
RESET ROLE;

-- L'API manipule le secret RADIUS rendu par l'enrôlement (ticket 03) et des codes de
-- ticket : aucune instruction de wk_api dans le journal de PostgreSQL (S1), comme
-- wk_radius (migration 0010). Délai borné : l'API ne doit jamais tenir un verrou longtemps.
ALTER ROLE wk_api SET log_min_error_statement = 'panic';
ALTER ROLE wk_api SET log_min_duration_statement = -1;
ALTER ROLE wk_api SET log_statement = 'none';
ALTER ROLE wk_api SET statement_timeout = '5s';
