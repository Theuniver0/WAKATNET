-- WAKATNET — migration 0015 : lecture des pairs WireGuard par wg-agent (phase 2, ticket 05).
-- Ticket : .scratch/phase-2-multi-proprietaires/issues/05-wg-agent.md
-- Contrat : ADR 0012 §1. La base est la source de vérité des pairs (SPEC §6.1).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wk_wg') THEN
    CREATE ROLE wk_wg LOGIN;
  END IF;
END $$;

SET ROLE wakatnet_owner;

-- Pairs voulus : routeurs ACTIFS ayant une clé. Un routeur révoqué (actif = false) disparaît
-- d'ici, donc de wg0, au tour suivant de wg-agent (ticket 06).
CREATE FUNCTION app.wg_pairs()
RETURNS TABLE (public_key text, overlay_ip text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  SELECT r.wg_public_key, host(r.overlay_ip)
    FROM app.router r
   WHERE r.actif AND r.wg_public_key IS NOT NULL
   ORDER BY r.id
$$;
REVOKE ALL ON FUNCTION app.wg_pairs() FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO wk_wg;
GRANT EXECUTE ON FUNCTION app.wg_pairs() TO wk_wg;

-- Réveil immédiat de wg-agent (LISTEN wakatnet_pairs) ; le tour périodique reste le filet.
-- Une notification par instruction, sans contenu : wg-agent relit toujours l'état complet.
CREATE FUNCTION app._notifier_pairs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM pg_notify('wakatnet_pairs', '');
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app._notifier_pairs() FROM PUBLIC;

CREATE TRIGGER notifier_pairs
  AFTER INSERT OR DELETE OR UPDATE OF actif, wg_public_key, overlay_ip ON app.router
  FOR EACH STATEMENT EXECUTE FUNCTION app._notifier_pairs();

RESET ROLE;

ALTER ROLE wk_wg SET log_min_error_statement = 'panic';
ALTER ROLE wk_wg SET log_min_duration_statement = -1;
ALTER ROLE wk_wg SET log_statement = 'none';
ALTER ROLE wk_wg SET statement_timeout = '5s';
