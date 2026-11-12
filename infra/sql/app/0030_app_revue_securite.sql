-- WAKATNET — migration 0030 : corrections de la revue de sécurité de la phase 5 (ticket 08).
-- Ticket : .scratch/phase-5-haute-disponibilite/issues/08-revue-securite.md ; docs/REVUE_SECURITE.md (E2, M2, M3).
--
-- E2 et M2 : le compteur d'échecs était LU avant la vérification et ÉCRIT après. Des requêtes parallèles
-- lisaient toutes « 4 échecs » : environ 1 000 essais par 15 min au lieu de 5, et le TOTP du super-admin
-- n'avait aucune limite. Désormais, chaque essai est RÉSERVÉ (inscrit) sous verrou consultatif AVANT la
-- vérification, puis effacé s'il réussit : 5 essais en 15 min au plus, même en parallèle.
-- M3 : un propriétaire peut retirer l'accès d'un gérant ou d'un vendeur (sessions fermées sur-le-champ).

SET ROLE wakatnet_owner;

-- Connexion : réservation d'un essai. NULL = trop d'essais (5 en 15 min pour cette adresse).
CREATE FUNCTION app.connexion_reserver(p_email text)
RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_email text := lower(left(p_email, 254));
  v_id bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('wakatnet_connexion:' || v_email));
  IF (SELECT count(*) FROM app.connexion_echec e WHERE e.email = v_email AND e.le > now() - interval '15 minutes') >= 5 THEN
    RETURN NULL;
  END IF;
  INSERT INTO app.connexion_echec (email) VALUES (v_email) RETURNING id INTO v_id;
  DELETE FROM app.connexion_echec WHERE le < now() - interval '1 day';
  RETURN v_id;
END;
$$;

-- Essai réussi : la réservation ne compte plus comme un échec.
CREATE FUNCTION app.connexion_reussie(p_essai bigint)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$ DELETE FROM app.connexion_echec WHERE id = p_essai $$;

-- TOTP du super-admin : même mécanique, par utilisateur. Au-delà de 5 essais en 15 min : la session est
-- FERMÉE et l'événement est inscrit au journal d'audit (rend NULL).
CREATE TABLE app.totp_essai (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  utilisateur_id bigint NOT NULL REFERENCES app.utilisateur (id),
  le             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX totp_essai_utilisateur ON app.totp_essai (utilisateur_id, le);
ALTER TABLE app.totp_essai ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION app.totp_reserver(p_empreinte bytea)
RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_u bigint;
  v_id bigint;
BEGIN
  SELECT s.utilisateur_id INTO v_u FROM app.session_utilisateur s JOIN app.utilisateur u ON u.id = s.utilisateur_id
   WHERE s.empreinte = p_empreinte AND s.expire_le > now() AND u.role = 'super_admin' AND u.actif;
  IF v_u IS NULL THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('wakatnet_totp:' || v_u));
  IF (SELECT count(*) FROM app.totp_essai e WHERE e.utilisateur_id = v_u AND e.le > now() - interval '15 minutes') >= 5 THEN
    DELETE FROM app.session_utilisateur WHERE empreinte = p_empreinte;
    INSERT INTO app.audit_log (tenant_id, acteur, action, objet)
    VALUES (NULL, 'utilisateur:' || v_u, 'totp_trop_d_essais', 'utilisateur:' || v_u);
    RETURN NULL;
  END IF;
  INSERT INTO app.totp_essai (utilisateur_id) VALUES (v_u) RETURNING id INTO v_id;
  DELETE FROM app.totp_essai WHERE le < now() - interval '1 day';
  RETURN v_id;
END;
$$;

CREATE FUNCTION app.totp_reussi(p_essai bigint)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$ DELETE FROM app.totp_essai WHERE id = p_essai $$;

-- M3 : retrait de l'accès d'un gérant ou d'un vendeur, par SON propriétaire (contexte RLS), sessions
-- fermées, audité. Rend false si l'utilisateur n'est pas un gérant ou vendeur de ce propriétaire.
CREATE FUNCTION app.utilisateur_desactiver(p_utilisateur bigint, p_auteur bigint)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_tenant bigint := app.tenant_courant();
BEGIN
  UPDATE app.utilisateur SET actif = false
   WHERE id = p_utilisateur AND tenant_id = v_tenant AND role IN ('gerant', 'vendeur');
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM app.session_utilisateur WHERE utilisateur_id = p_utilisateur;
  INSERT INTO app.audit_log (tenant_id, acteur, action, objet)
  VALUES (v_tenant, 'utilisateur:' || p_auteur, 'utilisateur_desactive', 'utilisateur:' || p_utilisateur);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION app.connexion_reserver(text), app.connexion_reussie(bigint), app.totp_reserver(bytea),
  app.totp_reussi(bigint), app.utilisateur_desactiver(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.connexion_reserver(text), app.connexion_reussie(bigint), app.totp_reserver(bytea),
  app.totp_reussi(bigint), app.utilisateur_desactiver(bigint, bigint) TO wk_api;

RESET ROLE;
