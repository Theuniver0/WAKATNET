-- WAKATNET — migration 0014 : enrôlement d'un routeur (phase 2, ticket 03).
-- Ticket : .scratch/phase-2-multi-proprietaires/issues/03-api-enrolement.md
-- Contrats : ADR 0012 §2 (adressage), §3 (jeton), §4 (contrat HTTP).
-- Jeton, adresse, secret et audit en UNE transaction : un échec ne consomme pas le jeton.

SET ROLE wakatnet_owner;

-- ---------------------------------------------------------------------------
-- Le jeton est-il utilisable ? (GET /enroll/{jeton}, ne consomme rien.) Rend son
-- expiration, ou NULL s'il est inconnu, expiré ou consommé. wk_api n'a aucun contexte
-- de propriétaire à ce stade : SECURITY DEFINER.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.enroll_token_valide(p_empreinte bytea)
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  SELECT expire_le FROM app.enrollment_token
   WHERE empreinte = p_empreinte AND consomme_le IS NULL AND expire_le > now()
$$;

-- ---------------------------------------------------------------------------
-- Adresse suivante de l'overlay (ADR 0012 §2) : 10.213.1.1 à 10.213.254.254, sans
-- octet final .0 ni .255, jamais réemployée (les routeurs révoqués gardent la leur).
-- L'appelant tient le verrou consultatif.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app._adresse_libre()
RETURNS inet
LANGUAGE sql STABLE
SET search_path = app, pg_temp
AS $$
  SELECT a.ip
    FROM generate_series(0, 254 * 254 - 1) AS g(n)
   CROSS JOIN LATERAL (SELECT ('10.213.' || (1 + g.n / 254) || '.' || (1 + g.n % 254))::inet AS ip) a
   WHERE NOT EXISTS (SELECT 1 FROM app.router r WHERE r.overlay_ip = a.ip)
   ORDER BY g.n
   LIMIT 1
$$;

-- ---------------------------------------------------------------------------
-- Enregistre le routeur et consomme le jeton.
--   statut 'enrole'       : routeur créé, colonnes remplies ;
--   statut 'introuvable'  : jeton inconnu, expiré ou déjà consommé (rien n'est écrit) ;
--   statut 'cle_utilisee' : clé publique déjà portée par un autre routeur (jeton intact) ;
--   statut 'plein'        : plus aucune adresse libre (jeton intact).
-- Le secret RADIUS n'est rendu qu'ici, une seule fois (ADR 0012 §4).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.enroll_register(p_empreinte bytea, p_cle text, p_coa_port integer, p_inventaire jsonb)
RETURNS TABLE (statut text, router_id bigint, tenant_id bigint, site_id bigint, overlay_ip text, secret text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, radius, public, pg_temp
AS $$
DECLARE
  v_jeton   app.enrollment_token%ROWTYPE;
  v_ip      inet;
  v_router  bigint;
  v_secret  text;
BEGIN
  -- Verrou de la ligne du jeton : deux POST concurrents sont sérialisés ici ; le second
  -- relit consomme_le après la validation du premier et repart en 'introuvable'.
  SELECT * INTO v_jeton FROM app.enrollment_token t
   WHERE t.empreinte = p_empreinte AND t.consomme_le IS NULL AND t.expire_le > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'introuvable'::text, NULL::bigint, NULL::bigint, NULL::bigint, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM app.router r WHERE r.wg_public_key = p_cle) THEN
    RETURN QUERY SELECT 'cle_utilisee'::text, NULL::bigint, NULL::bigint, NULL::bigint, NULL::text, NULL::text;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('wakatnet.overlay'));
  v_ip := app._adresse_libre();
  IF v_ip IS NULL THEN
    RETURN QUERY SELECT 'plein'::text, NULL::bigint, NULL::bigint, NULL::bigint, NULL::text, NULL::text;
    RETURN;
  END IF;

  INSERT INTO app.router (tenant_id, site_id, overlay_ip, shortname, wg_public_key, inventaire, enrole_le, coa_port)
  VALUES (v_jeton.tenant_id, v_jeton.site_id, v_ip, 'r-' || replace(host(v_ip), '.', '-'), p_cle, p_inventaire, now(),
          p_coa_port)
  RETURNING id INTO v_router;

  -- 32 caractères de [A-Za-z0-9] (192 bits tirés par pgcrypto ; « + » et « / » remplacés).
  v_secret := translate(encode(public.gen_random_bytes(24), 'base64'), '+/', 'Aa');
  INSERT INTO radius.router_secret (router_id, secret) VALUES (v_router, v_secret);

  UPDATE app.enrollment_token t SET consomme_le = now(), router_id = v_router WHERE t.id = v_jeton.id;

  INSERT INTO app.audit_log (tenant_id, acteur, action, objet, details)
  VALUES (v_jeton.tenant_id, 'enrolement', 'routeur_enrole', 'router:' || v_router,
          jsonb_build_object('overlay_ip', host(v_ip), 'site_id', v_jeton.site_id,
                             'identity', p_inventaire ->> 'identity', 'version', p_inventaire ->> 'version',
                             'modele', p_inventaire ->> 'modele'));

  RETURN QUERY SELECT 'enrole'::text, v_router, v_jeton.tenant_id, v_jeton.site_id, host(v_ip), v_secret;
END;
$$;

REVOKE ALL ON FUNCTION app.enroll_token_valide(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app._adresse_libre() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enroll_register(bytea, text, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.enroll_token_valide(bytea) TO wk_api;
GRANT EXECUTE ON FUNCTION app.enroll_register(bytea, text, integer, jsonb) TO wk_api;

RESET ROLE;
