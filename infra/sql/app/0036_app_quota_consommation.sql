-- WAKATNET — migration 0036 : quota d'enrôlement contrôlé aussi à la CONSOMMATION du jeton (revue de sécurité M4,
-- audit du 13/11/2026).
-- Ticket : docs/REVUE_SECURITE.md (M4) ; docs/adr/0017-quota-et-verification.md (« Audit du 13/11/2026 »).
--
-- Constats :
--   1. [Moyen] Le plafond global des comptes non validés (100 routeurs enrôlés par 24 h, arrêt à 90 % de l'overlay)
--      n'était contrôlé qu'à la création du jeton. Il compte les routeurs enrôlés, pas les jetons ouverts : N comptes
--      qui prennent chacun 2 jetons d'un coup, puis enrôlent dans les 30 min, le dépassaient largement.
--   2. [Faible] Un jeton émis survivait à la suspension du compte et à la baisse de son quota.
-- Correctif :
--   - enroll_register refait, sous les mêmes verrous que enrolement_autorise (propriétaire, puis global), les contrôles
--     de suspension, de quota (routeurs enrôlés, révoqués compris, plus celui-ci) et, pour un compte non validé, du
--     plafond global. Refus : 'suspendu', 'quota' ou 'plafond', jeton intact ;
--   - admin_acces (baisse du quota) et admin_regler (suspension) expirent les jetons ouverts du propriétaire.
--
-- Ordre des verrous dans enroll_register (aucun interblocage avec l'existant) :
--   ligne du jeton (FOR UPDATE) → wakatnet_quota:<propriétaire> → wakatnet_quota:global → wakatnet.overlay.
--   enrolement_autorise prend wakatnet_quota:<propriétaire> puis wakatnet_quota:global, et n'attend jamais une ligne
--   de jeton existante (il en insère une nouvelle). admin_acces et admin_regler ne prennent aucun verrou consultatif :
--   ils verrouillent la ligne du propriétaire en FOR NO KEY UPDATE (que enroll_register ne fait que lire, et sur laquelle la clé étrangère
--   de app.router ne prend qu'un FOR KEY SHARE, compatible), puis les lignes des jetons ouverts.

SET ROLE wakatnet_owner;

-- ---------------------------------------------------------------------------
-- Enregistre le routeur et consomme le jeton (0014), avec les contrôles de M4 refaits ici.
--   statut 'enrole'       : routeur créé, colonnes remplies ;
--   statut 'introuvable'  : jeton inconnu, expiré ou déjà consommé (rien n'est écrit) ;
--   statut 'cle_utilisee' : clé publique déjà portée par un autre routeur (jeton intact) ;
--   statut 'suspendu'     : propriétaire suspendu (jeton intact) ;
--   statut 'quota'        : routeurs enrôlés (révoqués compris) + celui-ci > quota courant (jeton intact) ;
--   statut 'plafond'      : compte non validé, plafond global de 100 par 24 h ou overlay à 90 % (jeton intact) ;
--   statut 'plein'        : plus aucune adresse libre (jeton intact).
-- Le secret RADIUS n'est rendu qu'ici, une seule fois (ADR 0012 §4).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.enroll_register(p_empreinte bytea, p_cle text, p_coa_port integer, p_inventaire jsonb)
RETURNS TABLE (statut text, router_id bigint, tenant_id bigint, site_id bigint, overlay_ip text, secret text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, radius, public, pg_temp
AS $$
DECLARE
  v_jeton   app.enrollment_token%ROWTYPE;
  v_tenant  app.tenant%ROWTYPE;
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

  -- M4 (audit du 13/11/2026) : même verrou par propriétaire que enrolement_autorise, tenu jusqu'à l'insertion du
  -- routeur ; le propriétaire est relu APRÈS le verrou (suspension et quota courants, pas ceux de l'émission).
  PERFORM pg_advisory_xact_lock(hashtext('wakatnet_quota:' || v_jeton.tenant_id));
  SELECT * INTO v_tenant FROM app.tenant n WHERE n.id = v_jeton.tenant_id;
  IF v_tenant.suspendu THEN
    RETURN QUERY SELECT 'suspendu'::text, NULL::bigint, NULL::bigint, NULL::bigint, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM app.router r WHERE r.tenant_id = v_jeton.tenant_id) + 1 > v_tenant.quota_routeurs THEN
    RETURN QUERY SELECT 'quota'::text, NULL::bigint, NULL::bigint, NULL::bigint, NULL::text, NULL::text;
    RETURN;
  END IF;
  -- ADR 0019 : compte non validé par le super-admin → plafond global, compté en routeurs ENRÔLÉS, sous le verrou
  -- global tenu jusqu'à l'insertion : des consommations parallèles ne le dépassent pas.
  IF NOT v_tenant.valide_admin THEN
    PERFORM pg_advisory_xact_lock(hashtext('wakatnet_quota:global'));
    IF (SELECT count(*) FROM app.router r JOIN app.tenant n ON n.id = r.tenant_id
         WHERE NOT n.valide_admin AND r.enrole_le > now() - interval '24 hours') >= 100
       OR (SELECT count(*) FROM app.router r WHERE r.overlay_ip << '10.213.0.0/16'::inet) >= 0.9 * 254 * 254 THEN
      RETURN QUERY SELECT 'plafond'::text, NULL::bigint, NULL::bigint, NULL::bigint, NULL::text, NULL::text;
      RETURN;
    END IF;
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

-- ---------------------------------------------------------------------------
-- Jetons ouverts d'un propriétaire → expirés (suspension, baisse du quota). Rend leur nombre. expire_le respecte
-- CHECK (expire_le > cree_le) ; les lecteurs comparent à now() : le jeton n'est plus utilisable dès la validation.
-- L'appelant tient la ligne du propriétaire. Un enroll_register déjà engagé sur l'un d'eux (ligne verrouillée) passe
-- en premier ; sinon, son SELECT … FOR UPDATE relit la ligne expirée et rend 'introuvable'.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app._jetons_expirer(p_tenant bigint)
RETURNS integer
LANGUAGE plpgsql VOLATILE
SET search_path = app, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE app.enrollment_token t SET expire_le = greatest(now(), t.cree_le + interval '1 microsecond')
   WHERE t.tenant_id = p_tenant AND t.consomme_le IS NULL AND t.expire_le > now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION app._jetons_expirer(bigint) FROM PUBLIC;

-- Super-admin (0034) : valider l'adresse, ou RELEVER le quota, vaut validation du compte ; valider l'adresse porte le
-- quota à 10 au moins. Baisser le quota ne valide pas le compte, et expire désormais ses jetons ouverts (audit du
-- 13/11/2026), inscrits au journal d'audit.
CREATE OR REPLACE FUNCTION app.admin_acces(p_tenant bigint, p_quota integer, p_valider_email boolean, p_admin bigint)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_avant integer;
  v_expires integer := 0;
BEGIN
  SELECT quota_routeurs INTO v_avant FROM app.tenant WHERE id = p_tenant FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_valider_email OR p_quota > v_avant THEN
    UPDATE app.tenant SET valide_admin = true WHERE id = p_tenant;
  END IF;
  IF p_valider_email THEN
    UPDATE app.utilisateur SET email_verifie_le = now()
     WHERE tenant_id = p_tenant AND role = 'proprietaire' AND email_verifie_le IS NULL;
    UPDATE app.tenant SET quota_routeurs = greatest(quota_routeurs, 10) WHERE id = p_tenant;
  END IF;
  IF p_quota IS NOT NULL THEN
    UPDATE app.tenant SET quota_routeurs = p_quota WHERE id = p_tenant;
    IF p_quota < v_avant THEN
      v_expires := app._jetons_expirer(p_tenant);
    END IF;
  END IF;
  INSERT INTO app.audit_log (tenant_id, acteur, action, objet, details)
  VALUES (p_tenant, 'utilisateur:' || p_admin, 'admin_acces', 'tenant:' || p_tenant,
          jsonb_build_object('quota_routeurs', p_quota, 'email_valide', coalesce(p_valider_email, false),
                             'jetons_expires', v_expires));
  RETURN true;
END;
$$;

-- Super-admin (0024) : suspension, commission, plafond de découvert. Suspendre expire désormais les jetons ouverts
-- (audit du 13/11/2026) : ils ne reviennent pas à la levée de la suspension.
CREATE OR REPLACE FUNCTION app.admin_regler(p_tenant bigint, p_suspendu boolean, p_commission_bps integer, p_plafond bigint, p_admin bigint)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_avant jsonb;
  v_expires integer := 0;
BEGIN
  SELECT jsonb_build_object('suspendu', suspendu, 'commission_bps', commission_bps, 'plafond_decouvert', plafond_decouvert)
    INTO v_avant FROM app.tenant WHERE id = p_tenant FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE app.tenant SET suspendu = coalesce(p_suspendu, suspendu),
                        commission_bps = coalesce(p_commission_bps, commission_bps),
                        plafond_decouvert = coalesce(p_plafond, plafond_decouvert)
   WHERE id = p_tenant;
  IF p_suspendu THEN
    v_expires := app._jetons_expirer(p_tenant);
  END IF;
  INSERT INTO app.audit_log (tenant_id, acteur, action, objet, details)
  VALUES (p_tenant, 'utilisateur:' || p_admin, 'admin_reglage', 'tenant:' || p_tenant,
          jsonb_build_object('avant', v_avant, 'suspendu', p_suspendu, 'commission_bps', p_commission_bps, 'plafond_decouvert', p_plafond,
                             'jetons_expires', v_expires));
  RETURN true;
END;
$$;

-- CREATE OR REPLACE garde les droits ; ils sont redits ici pour la relecture (inchangés depuis 0014, 0024 et 0033).
REVOKE ALL ON FUNCTION app.enroll_register(bytea, text, integer, jsonb), app.admin_acces(bigint, integer, boolean, bigint),
  app.admin_regler(bigint, boolean, integer, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.enroll_register(bytea, text, integer, jsonb), app.admin_acces(bigint, integer, boolean, bigint),
  app.admin_regler(bigint, boolean, integer, bigint, bigint) TO wk_api;

RESET ROLE;
