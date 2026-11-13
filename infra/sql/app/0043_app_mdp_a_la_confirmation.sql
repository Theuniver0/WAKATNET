-- WAKATNET — migration 0043 : le mot de passe d'un compte non confirmé se choisit À LA CONFIRMATION (scan de sécurité du
-- 13/11/2026, F2). Jusqu'ici :
--   - une inscription non authentifiée remplaçait le mot de passe d'un compte en attente (0039, contre la
--     pré-appropriation) ; confirmer activait ensuite le mot de passe de l'attaquant ;
--   - la validation par le super-admin activait le mot de passe en place, quel que soit son auteur.
-- Désormais seul le détenteur d'un lien de confirmation (boîte de l'adresse, ou remise par Telecom Universel après
-- vérification d'identité) fixe le mot de passe, en même temps qu'il confirme. La pré-appropriation reste fermée : le
-- mot de passe du premier inscrit ne sert à rien tant que le lien n'a pas été utilisé.
SET ROLE wakatnet_owner;

-- 1. Inscription : une adresse déjà inscrite ne voit JAMAIS son mot de passe changer. La purge des adresses non
--    confirmées épargne les comptes validés par le super-admin. Le reste est à l'identique de 0039.
CREATE OR REPLACE FUNCTION app.inscription_demander(p_nom_proprietaire text, p_email text, p_mot_de_passe text, p_source text)
RETURNS TABLE (statut text, utilisateur_id bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_email text := lower(left(p_email, 254));
  v app.utilisateur%ROWTYPE;
  r record;
BEGIN
  IF NOT app._source_admise('inscription', p_source) THEN
    RETURN QUERY SELECT 'trop'::text, NULL::bigint; RETURN;
  END IF;
  BEGIN
    UPDATE app.utilisateur u SET email = 'purge-' || u.id || '@wakatnet.invalid', actif = false
     WHERE u.id IN (SELECT x.id FROM app.utilisateur x WHERE x.role = 'proprietaire' AND x.email_verifie_le IS NULL
                       AND x.cree_le < now() - interval '7 days' AND x.email NOT LIKE '%@wakatnet.invalid'
                       -- Relecture des correctifs : un compte VALIDÉ par le super-admin n'est pas purgé, sinon le lien
                       -- qu'il a remis (7 jours) mourrait avant d'avoir servi. Pas « un lien ouvert » : un tiers en
                       -- rouvrirait sans fin par /renvoyer, et l'adresse ne serait jamais libérée.
                       AND NOT EXISTS (SELECT 1 FROM app.tenant t WHERE t.id = x.tenant_id AND t.valide_admin)
                     LIMIT 100);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'inscription_demander : purge des adresses non confirmées en échec (%)', SQLSTATE;
  END;
  SELECT * INTO v FROM app.utilisateur u WHERE u.email = v_email;
  IF FOUND THEN
    IF v.role = 'proprietaire' AND v.actif AND v.email_verifie_le IS NULL THEN
      -- F2 : rien n'est modifié. L'avis « compte en attente » dit de choisir le mot de passe en confirmant.
      INSERT INTO app.audit_log (tenant_id, acteur, action, objet)
      VALUES (v.tenant_id, 'inscription', 'inscription_repetee_avant_confirmation', 'utilisateur:' || v.id);
      RETURN QUERY SELECT 'attente'::text, v.id; RETURN;
    END IF;
    RETURN QUERY SELECT 'existe'::text, v.id; RETURN;
  END IF;
  BEGIN
    SELECT * INTO r FROM app.inscription(p_nom_proprietaire, p_email, p_mot_de_passe);
  EXCEPTION
    WHEN unique_violation THEN
      SELECT u.id INTO v.id FROM app.utilisateur u WHERE u.email = v_email;
      RETURN QUERY SELECT 'existe'::text, v.id; RETURN;
    WHEN OTHERS THEN
      RETURN QUERY SELECT 'existe'::text, NULL::bigint; RETURN;
  END;
  IF r.statut <> 'cree' THEN
    SELECT u.id INTO v.id FROM app.utilisateur u WHERE u.email = v_email;
    RETURN QUERY SELECT 'existe'::text, v.id; RETURN;
  END IF;
  RETURN QUERY SELECT 'cree'::text, r.utilisateur_id;
END;
$$;

-- 2. Confirmation : le lien ET le mot de passe, ensemble. Le mot de passe n'est posé que sur un compte encore non
--    confirmé ; un lien d'un compte déjà confirmé ne sert à rien.
CREATE FUNCTION app.verification_confirmer(p_empreinte bytea, p_mot_de_passe text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v app.verification_email%ROWTYPE;
  v_tenant bigint;
BEGIN
  IF p_mot_de_passe IS NULL OR p_mot_de_passe !~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$' THEN
    RETURN false;
  END IF;
  SELECT * INTO v FROM app.verification_email e
   WHERE e.empreinte = p_empreinte AND e.consomme_le IS NULL AND e.expire_le > now() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE app.verification_email SET consomme_le = now() WHERE id = v.id;
  DELETE FROM app.verification_email WHERE cree_le < now() - interval '7 days';
  UPDATE app.utilisateur SET email_verifie_le = now(), mot_de_passe = p_mot_de_passe
   WHERE id = v.utilisateur_id AND actif AND email_verifie_le IS NULL RETURNING tenant_id INTO v_tenant;
  IF NOT FOUND THEN RETURN false; END IF;
  -- Mot de passe neuf : toute session ouverte avant (par un autre chemin) est close.
  DELETE FROM app.session_utilisateur WHERE utilisateur_id = v.utilisateur_id;
  -- Les autres liens ouverts de ce compte ne valent plus.
  UPDATE app.verification_email SET expire_le = now()
   WHERE utilisateur_id = v.utilisateur_id AND consomme_le IS NULL AND expire_le > now();
  INSERT INTO app.audit_log (tenant_id, acteur, action, objet)
  VALUES (v_tenant, 'utilisateur:' || v.utilisateur_id, 'email_verifie', 'utilisateur:' || v.utilisateur_id);
  RETURN true;
END;
$$;

-- 3. Validation par le super-admin : relève le quota et valide le compte, mais ne confirme plus l'adresse d'office. Elle
--    rend un lien de confirmation (7 jours) que Telecom Universel remet au propriétaire après avoir vérifié son
--    identité ; c'est lui qui choisit alors son mot de passe.
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

-- Lien de confirmation remis par le super-admin : pour le propriétaire NON confirmé du compte ; null s'il n'y en a pas.
CREATE FUNCTION app.admin_lien_confirmation(p_tenant bigint, p_empreinte bytea, p_admin bigint)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_utilisateur bigint;
BEGIN
  SELECT u.id INTO v_utilisateur FROM app.utilisateur u
   WHERE u.tenant_id = p_tenant AND u.role = 'proprietaire' AND u.actif AND u.email_verifie_le IS NULL
   ORDER BY u.id LIMIT 1;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO app.verification_email (utilisateur_id, empreinte, expire_le) VALUES (v_utilisateur, p_empreinte, now() + interval '7 days');
  INSERT INTO app.audit_log (tenant_id, acteur, action, objet)
  VALUES (p_tenant, 'utilisateur:' || p_admin, 'lien_confirmation_remis', 'utilisateur:' || v_utilisateur);
  RETURN true;
END;
$$;

-- La confirmation sans mot de passe n'est plus offerte à l'API.
REVOKE EXECUTE ON FUNCTION app.verification_consommer(bytea) FROM wk_api;
REVOKE ALL ON FUNCTION app.verification_confirmer(bytea, text), app.admin_lien_confirmation(bigint, bytea, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.verification_confirmer(bytea, text), app.admin_lien_confirmation(bigint, bytea, bigint) TO wk_api;

RESET ROLE;
