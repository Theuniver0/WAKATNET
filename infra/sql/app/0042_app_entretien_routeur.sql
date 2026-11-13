-- WAKATNET — migration 0042 : étape 3 « entretien » de l'enrôlement (SPEC §6.2, ADR 0023). Un script planifié du routeur
-- tire, toutes les 6 h, sa configuration WAKATNET à jour (pairs, routes, /radius, pare-feu, walled garden) : ajout d'un
-- nœud, nouvelle IP de B (ADR 0004 §3), IP du portail, sans réenrôlement.
--   - jeton d'entretien propre au routeur, aléatoire (32 octets), posé UNE fois juste après l'enrôlement ; seule son
--     empreinte SHA-256 est gardée ;
--   - lu par le serveur sans session : routeur ACTIF seulement (un routeur révoqué ne reçoit plus rien).
SET ROLE wakatnet_owner;

ALTER TABLE app.router ADD COLUMN entretien_empreinte bytea UNIQUE CHECK (entretien_empreinte IS NULL OR length(entretien_empreinte) = 32);

-- Posé une seule fois : un jeton déjà posé n'est jamais remplacé par cette fonction.
CREATE FUNCTION app.entretien_jeton_poser(p_router bigint, p_empreinte bytea)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  WITH m AS (UPDATE app.router SET entretien_empreinte = p_empreinte
              WHERE id = p_router AND actif AND entretien_empreinte IS NULL AND length(p_empreinte) = 32
             RETURNING 1)
  SELECT count(*) = 1 FROM m
$$;

-- Ce que l'entretien doit regénérer. JAMAIS le secret RADIUS (relecture de sécurité n° 7) : le script le relit sur le
-- routeur ; un jeton d'entretien qui fuit (export de configuration collé sur un forum) ne donne donc pas le secret.
CREATE FUNCTION app.entretien_lire(p_empreinte bytea)
RETURNS TABLE (router_id bigint, overlay_ip text, coa_port integer, listen_port integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  SELECT r.id, host(r.overlay_ip), r.coa_port,
         CASE WHEN (r.inventaire ->> 'listen_port') ~ '^[0-9]{1,5}$' THEN (r.inventaire ->> 'listen_port')::integer END
    FROM app.router r
   WHERE r.entretien_empreinte = p_empreinte AND r.actif AND length(p_empreinte) = 32
$$;

-- Rotation par le propriétaire (relecture de sécurité n° 3) : nouveau jeton pour SON routeur actif (RLS : propriétaire
-- courant) ; l'ancien cesse aussitôt de valoir. Sert aussi aux routeurs enrôlés avant cette migration.
CREATE FUNCTION app.entretien_jeton_renouveler(p_router bigint, p_empreinte bytea)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  WITH m AS (UPDATE app.router SET entretien_empreinte = p_empreinte
              WHERE id = p_router AND tenant_id = app.tenant_courant() AND actif AND enrole_le IS NOT NULL
                AND length(p_empreinte) = 32
             RETURNING 1)
  SELECT count(*) = 1 FROM m
$$;

REVOKE ALL ON FUNCTION app.entretien_jeton_poser(bigint, bytea), app.entretien_lire(bytea), app.entretien_jeton_renouveler(bigint, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.entretien_jeton_poser(bigint, bytea), app.entretien_lire(bytea), app.entretien_jeton_renouveler(bigint, bytea) TO wk_api;

RESET ROLE;
