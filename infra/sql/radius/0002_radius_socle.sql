-- WAKATNET — migration 0002 : socle du schéma radius (phase 1, ticket 02).
-- Contrats : ADR 0006 §1, §2, §3, §4, §5, §15 ; instant de référence : ADR 0007.
-- Toute la décision d'accès vit ici (C2). Aucune fonction ne lève d'exception
-- à cause d'une donnée : un cas inattendu donne un refus codé (ADR 0006 §1, §4).

SET ROLE wakatnet_owner;

CREATE SCHEMA radius;

-- Secret RADIUS de chaque routeur : en clair (écart S3 accepté le 11/11/2026,
-- ADR 0006 §14), lisible seulement par wakatnet_owner, exposé par client_lookup
-- (et coa_target au ticket 09).
CREATE TABLE radius.router_secret (
  router_id  bigint PRIMARY KEY REFERENCES app.router (id) ON DELETE CASCADE,
  secret     text   NOT NULL CHECK (length(secret) BETWEEN 16 AND 128)
);

-- Paramètres globaux (C2 : les réglages vivent en SQL, pas en unlang).
CREATE TABLE radius.parametre (
  cle    text PRIMARY KEY,
  valeur text NOT NULL
);
INSERT INTO radius.parametre (cle, valeur) VALUES
  ('acct_interim_interval_s', '120');   -- accepté le 11/11/2026 (ADR 0006 §5)

-- ---------------------------------------------------------------------------
-- radius.client_lookup(p_src) — une ligne pour le routeur ACTIF de cette IP,
-- sinon aucune (ADR 0006 §1). Lue par map_clients (rlm_sql_map) :
--   colonnes -> FreeRADIUS-Client-IP-Address, -Secret, -Shortname,
--               -Virtual-Server, -Require-MA (toujours présent, jamais NULL :
--               sinon FreeRADIUS n'exige pas le Message-Authenticator, client.c l. 1594).
-- p_src est du texte : une valeur invalide donne zéro ligne, jamais une erreur.
-- ---------------------------------------------------------------------------
CREATE FUNCTION radius.client_lookup(p_src text)
RETURNS TABLE (ip text, secret text, shortname text, virtual_server text, require_ma text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = radius, pg_temp
AS $$
DECLARE
  v_ip inet;
BEGIN
  BEGIN
    v_ip := p_src::inet;
  EXCEPTION WHEN others THEN
    RETURN;
  END;
  RETURN QUERY
    SELECT host(r.overlay_ip),
           s.secret,
           r.shortname,
           'wakatnet'::text,
           CASE WHEN r.require_ma_exception THEN 'no' ELSE 'yes' END
      FROM app.router r
      JOIN radius.router_secret s ON s.router_id = r.id
     WHERE r.overlay_ip = v_ip
       AND r.actif;
END;
$$;

-- ---------------------------------------------------------------------------
-- radius._authorize_at — logique d'accès à instant donné (ADR 0007, forme a).
-- AUCUN droit pour wk_radius : seul l'enveloppe radius.authorize (now()) l'appelle.
-- Renvoie UNE ligne (ADR 0006 §2) :
--   0 cleartext_password -> control:Cleartext-Password
--   1 decision           -> control:Tmp-String-1 ('Accept' ou 'Reject', toujours explicite)
--   2 reply_message      -> control:Tmp-String-2 (cause du refus)
-- Le pilote PostgreSQL de FreeRADIUS rend NULL sous forme de chaîne VIDE
-- (observé le 11/11/2026, ADR 0006 §2) : aucune décision ne repose sur NULL.
--   3 session_timeout    -> reply:Session-Timeout
--   4 rate_limit         -> reply:Mikrotik-Rate-Limit
--   5 port_limit         -> reply:Port-Limit
--   6 interim            -> reply:Acct-Interim-Interval
-- Un refus ne porte jamais d'attribut d'Accept (colonnes 3 à 6 NULL).
-- Ticket 02 : cas « ticket neuf » et « code inconnu ». Les autres refus (§4)
-- arrivent aux tickets 03 à 07.
-- ---------------------------------------------------------------------------
CREATE FUNCTION radius._authorize_at(p_user text, p_src text, p_calling text, p_called text, p_now timestamptz)
RETURNS TABLE (cleartext_password text, decision text, reply_message text,
               session_timeout bigint, rate_limit text, port_limit integer, interim integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = radius, pg_temp
AS $$
DECLARE
  v_ip      inet;
  v_routeur app.router%ROWTYPE;
  v_ticket  app.voucher%ROWTYPE;
  v_code    text := upper(coalesce(p_user, ''));
  v_restes  bigint[];
  v_timeout bigint;
BEGIN
  BEGIN
    v_ip := p_src::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  -- Routeur : déduit de l'IP source uniquement (§5.1). Le propriétaire en découle.
  SELECT * INTO v_routeur FROM app.router r WHERE r.overlay_ip = v_ip AND r.actif;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, 'Reject'::text, 'ticket_inconnu'::text,
                        NULL::bigint, NULL::text, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  -- Ticket : clé (propriétaire, code), jamais le code seul (T6).
  SELECT * INTO v_ticket FROM app.voucher v
   WHERE v.tenant_id = v_routeur.tenant_id AND v.code = v_code;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, 'Reject'::text, 'ticket_inconnu'::text,
                        NULL::bigint, NULL::text, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  -- Session-Timeout = min des restes (§5.3). Ticket neuf : rien de consommé, jamais activé.
  v_restes := ARRAY[]::bigint[];
  IF v_ticket.f_uptime_limit_s IS NOT NULL THEN
    v_restes := v_restes || v_ticket.f_uptime_limit_s::bigint;
  END IF;
  IF v_ticket.f_validity_s IS NOT NULL THEN
    v_restes := v_restes || v_ticket.f_validity_s::bigint;
  END IF;
  IF v_ticket.expires_at IS NOT NULL THEN
    v_restes := v_restes || floor(extract(epoch FROM (v_ticket.expires_at - p_now)))::bigint;
  END IF;
  SELECT min(x) INTO v_timeout FROM unnest(v_restes) AS x;

  RETURN QUERY SELECT
    v_ticket.code,
    'Accept'::text,
    NULL::text,
    v_timeout,
    v_ticket.f_rate_limit,
    v_ticket.f_devices,
    (SELECT valeur::integer FROM radius.parametre WHERE cle = 'acct_interim_interval_s');
END;
$$;

-- Enveloppe publique : l'instant est TOUJOURS now() (règle 5, ADR 0007).
CREATE FUNCTION radius.authorize(p_user text, p_src text, p_calling text, p_called text)
RETURNS TABLE (cleartext_password text, decision text, reply_message text,
               session_timeout bigint, rate_limit text, port_limit integer, interim integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = radius, pg_temp
AS $$
  SELECT * FROM radius._authorize_at(p_user, p_src, p_calling, p_called, now());
$$;

RESET ROLE;

-- Droits exacts (ADR 0006 §1, ADR 0008 §3 bis).
REVOKE ALL ON FUNCTION radius.client_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION radius._authorize_at(text, text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION radius.authorize(text, text, text, text) FROM PUBLIC;
GRANT USAGE ON SCHEMA radius TO wk_radius;
GRANT EXECUTE ON FUNCTION radius.client_lookup(text) TO wk_radius;
GRANT EXECUTE ON FUNCTION radius.authorize(text, text, text, text) TO wk_radius;

-- Délai maximal d'une requête de FreeRADIUS : borne principale (ADR 0006 §13).
ALTER ROLE wk_radius SET statement_timeout = '500ms';
