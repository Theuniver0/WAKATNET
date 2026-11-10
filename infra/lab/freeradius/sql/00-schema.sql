-- =====================================================================
-- WAKATNET — LABO FreeRADIUS (infra/lab/freeradius) — JOUET DE LABORATOIRE
-- Ce schéma n'est PAS le modèle de données de la phase 1 (spec §9).
-- Il sert uniquement à prouver L1 (clients dynamiques), L2 (rôle limité
-- à EXECUTE sur radius.*) et L5 (authorize CHAP via fonction SQL).
-- Valeurs de labo uniquement, aucun secret réel.
-- Exécuté par run-lab.sh en tant que superutilisateur postgres, dans la
-- base wakatnet_lab fraîchement créée.
-- =====================================================================
\set ON_ERROR_STOP on

-- Rôle propriétaire des objets : ne se connecte jamais.
CREATE ROLE wk_owner NOLOGIN;
-- Rôle utilisé par FreeRADIUS : ne peut qu'exécuter les fonctions radius.*
-- (mot de passe de labo, évident, injecté par run-lab.sh via :'radius_pw').
CREATE ROLE wk_radius LOGIN PASSWORD :'radius_pw';

REVOKE ALL ON DATABASE wakatnet_lab FROM PUBLIC;
GRANT CONNECT ON DATABASE wakatnet_lab TO wk_radius;
GRANT CREATE ON DATABASE wakatnet_lab TO wk_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

SET ROLE wk_owner;

CREATE SCHEMA app;
CREATE SCHEMA ledger;
CREATE SCHEMA radius;

-- Les fonctions ne sont pas exécutables par PUBLIC par défaut.
ALTER DEFAULT PRIVILEGES FOR ROLE wk_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE app.routers (
    id            bigserial PRIMARY KEY,
    overlay_ip    inet    NOT NULL UNIQUE,      -- /32 du routeur dans l'overlay WireGuard
    shortname     text    NOT NULL UNIQUE,
    radius_secret text    NOT NULL,             -- secret RADIUS propre à ce routeur
    active        boolean NOT NULL DEFAULT true
);

-- Jouet : un ticket = un mot de passe en clair (CHAP l'exige) + 2 attributs.
CREATE TABLE app.tickets_lab (
    code            text    PRIMARY KEY,
    password_clear  text    NOT NULL,
    session_timeout integer NOT NULL,
    rate_limit      text    NOT NULL
);

-- Table « sensible » : prouve qu'un nœud RADIUS compromis ne lit pas le grand livre.
CREATE TABLE ledger.entries (
    id         bigserial PRIMARY KEY,
    amount_xof bigint NOT NULL,
    label      text   NOT NULL
);

-- ---------------------------------------------------------------------
-- radius.client_lookup(src_ip) : secret + nom court du routeur ACTIF, ou rien.
-- ---------------------------------------------------------------------
CREATE FUNCTION radius.client_lookup(p_src_ip inet)
RETURNS TABLE (secret text, shortname text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT r.radius_secret, r.shortname
      FROM app.routers r
     WHERE r.overlay_ip = p_src_ip
       AND r.active;
$$;

-- ---------------------------------------------------------------------
-- radius.authorize(...) : JOUET DE LABO, PAS LE CONTRAT DE LA PHASE 1.
-- Renvoie des lignes au format attendu par rlm_sql
-- (id, username, attribute, value, op) + une colonne kind = check|reply.
-- Ticket inconnu -> aucune ligne (rlm_sql renvoie notfound).
-- ---------------------------------------------------------------------
CREATE FUNCTION radius.authorize(p_username text, p_src_ip inet,
                                 p_calling_station_id text, p_called_station_id text)
RETURNS TABLE (id integer, username text, attribute text, value text, op text, kind text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT 1, t.code, 'Cleartext-Password', t.password_clear, ':=', 'check'
      FROM app.tickets_lab t
      JOIN app.routers r ON r.overlay_ip = p_src_ip AND r.active
     WHERE t.code = p_username
    UNION ALL
    SELECT 2, t.code, 'Session-Timeout', t.session_timeout::text, ':=', 'reply'
      FROM app.tickets_lab t
      JOIN app.routers r ON r.overlay_ip = p_src_ip AND r.active
     WHERE t.code = p_username
    UNION ALL
    SELECT 3, t.code, 'Mikrotik-Rate-Limit', t.rate_limit, ':=', 'reply'
      FROM app.tickets_lab t
      JOIN app.routers r ON r.overlay_ip = p_src_ip AND r.active
     WHERE t.code = p_username;
$$;

RESET ROLE;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA radius FROM PUBLIC;
GRANT USAGE ON SCHEMA radius TO wk_radius;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA radius TO wk_radius;
