-- WAKATNET — migration 0023 : comptes, sessions, rôles, points de vente (phase 4, ticket 02).
-- Ticket : .scratch/phase-4-exploitation/issues/02-comptes-auth.md
-- Contrats : ADR 0014 §1 à §4. Le mot de passe arrive DÉJÀ haché par l'API (scrypt) ; la base ne
-- voit jamais un mot de passe en clair, ni un jeton de session (empreinte SHA-256 seulement).

SET ROLE wakatnet_owner;

-- Points de vente (§2.1) : un gérant ou un vendeur y est rattaché.
CREATE TABLE app.point_of_sale (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES app.tenant (id),
  nom       text   NOT NULL CHECK (length(nom) BETWEEN 1 AND 80),
  cree_le   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, nom)
);

CREATE TABLE app.utilisateur (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        bigint REFERENCES app.tenant (id),
  point_of_sale_id bigint,
  role             text   NOT NULL CHECK (role IN ('super_admin', 'proprietaire', 'gerant', 'vendeur')),
  email            text   NOT NULL UNIQUE CHECK (email = lower(email) AND email ~ '^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,24}$'),
  nom              text   NOT NULL DEFAULT '' CHECK (length(nom) <= 80),
  mot_de_passe     text   NOT NULL CHECK (mot_de_passe ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$'),
  -- TOTP (super-admin) : secret chiffré par l'API ; dernier pas accepté (pas de rejeu, ADR 0014 §3).
  totp_secret      bytea,
  totp_dernier_pas bigint NOT NULL DEFAULT 0,
  actif            boolean NOT NULL DEFAULT true,
  cree_le          timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'super_admin') = (tenant_id IS NULL)),
  CHECK ((role IN ('gerant', 'vendeur')) = (point_of_sale_id IS NOT NULL)),
  CHECK (role <> 'super_admin' OR totp_secret IS NOT NULL),
  FOREIGN KEY (tenant_id, point_of_sale_id) REFERENCES app.point_of_sale (tenant_id, id)
);

CREATE TABLE app.session_utilisateur (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  utilisateur_id bigint NOT NULL REFERENCES app.utilisateur (id),
  empreinte      bytea  NOT NULL UNIQUE CHECK (length(empreinte) = 32),
  cree_le        timestamptz NOT NULL DEFAULT now(),
  expire_le      timestamptz NOT NULL,                 -- 12 h glissantes…
  limite_le      timestamptz NOT NULL,                 -- …7 jours au plus
  totp_ok        boolean NOT NULL DEFAULT false
);
CREATE INDEX session_utilisateur_par_utilisateur ON app.session_utilisateur (utilisateur_id);

CREATE TABLE app.connexion_echec (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email  text   NOT NULL,
  le     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connexion_echec_email ON app.connexion_echec (email, le);

-- RLS (ADR 0012 §6) : le propriétaire ne voit que ses points de vente et ses utilisateurs.
ALTER TABLE app.point_of_sale ENABLE ROW LEVEL SECURITY;
CREATE POLICY cloisonnement ON app.point_of_sale TO wk_api
  USING (tenant_id = app.tenant_courant()) WITH CHECK (tenant_id = app.tenant_courant());
ALTER TABLE app.utilisateur ENABLE ROW LEVEL SECURITY;
CREATE POLICY cloisonnement ON app.utilisateur TO wk_api
  USING (tenant_id = app.tenant_courant()) WITH CHECK (tenant_id = app.tenant_courant() AND role IN ('gerant', 'vendeur'));
ALTER TABLE app.session_utilisateur ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connexion_echec ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE (nom) ON app.point_of_sale TO wk_api;
-- Le propriétaire crée gérants et vendeurs de SON propriétaire (WITH CHECK) ; jamais un super-admin.
GRANT SELECT (id, tenant_id, point_of_sale_id, role, email, nom, actif, cree_le) ON app.utilisateur TO wk_api;
GRANT INSERT (tenant_id, point_of_sale_id, role, email, nom, mot_de_passe) ON app.utilisateur TO wk_api;
GRANT UPDATE (actif) ON app.utilisateur TO wk_api;

-- ---------------------------------------------------------------------------
-- Inscription d'un propriétaire (accès ouvert, ADR 0001 §5) : propriétaire + compte, ensemble.
--   statut : 'cree' | 'email_pris'
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.inscription(p_nom_proprietaire text, p_email text, p_mot_de_passe text)
RETURNS TABLE (statut text, tenant_id bigint, utilisateur_id bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_t bigint;
  v_u bigint;
BEGIN
  IF length(coalesce(p_nom_proprietaire, '')) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'inscription : nom de 1 à 120 caractères';
  END IF;
  IF EXISTS (SELECT 1 FROM app.utilisateur u WHERE u.email = lower(p_email)) THEN
    RETURN QUERY SELECT 'email_pris'::text, NULL::bigint, NULL::bigint; RETURN;
  END IF;
  INSERT INTO app.tenant (nom) VALUES (p_nom_proprietaire) RETURNING id INTO v_t;
  BEGIN
    INSERT INTO app.utilisateur (tenant_id, role, email, nom, mot_de_passe)
    VALUES (v_t, 'proprietaire', lower(p_email), p_nom_proprietaire, p_mot_de_passe) RETURNING id INTO v_u;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'inscription : adresse déjà utilisée' USING ERRCODE = 'unique_violation';
  END;
  INSERT INTO app.audit_log (tenant_id, acteur, action, objet) VALUES (v_t, 'utilisateur:' || v_u, 'inscription', 'tenant:' || v_t);
  RETURN QUERY SELECT 'cree'::text, v_t, v_u;
END;
$$;

-- Lecture pour la connexion (route publique) : rend l'empreinte du mot de passe à l'API, qui
-- vérifie. Échecs comptés par adresse sur 15 min (ADR 0014 §1).
CREATE FUNCTION app.connexion_lire(p_email text)
RETURNS TABLE (utilisateur_id bigint, mot_de_passe text, actif boolean, echecs_recents integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  SELECT u.id, u.mot_de_passe, u.actif AND NOT coalesce(t.suspendu, false),
         (SELECT count(*)::integer FROM app.connexion_echec e WHERE e.email = lower(p_email) AND e.le > now() - interval '15 minutes')
    FROM (SELECT lower(p_email) AS e) x
    LEFT JOIN app.utilisateur u ON u.email = x.e
    LEFT JOIN app.tenant t ON t.id = u.tenant_id
$$;

CREATE FUNCTION app.connexion_echouee(p_email text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  INSERT INTO app.connexion_echec (email) VALUES (lower(left(p_email, 254)));
  DELETE FROM app.connexion_echec WHERE le < now() - interval '1 day';
$$;

CREATE FUNCTION app.session_ouvrir(p_utilisateur bigint, p_empreinte bytea)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  INSERT INTO app.session_utilisateur (utilisateur_id, empreinte, expire_le, limite_le)
  VALUES (p_utilisateur, p_empreinte, now() + interval '12 hours', now() + interval '7 days');
  INSERT INTO app.audit_log (tenant_id, acteur, action, objet)
  SELECT u.tenant_id, 'utilisateur:' || u.id, 'connexion', 'utilisateur:' || u.id FROM app.utilisateur u WHERE u.id = p_utilisateur;
  DELETE FROM app.session_utilisateur WHERE limite_le < now() OR expire_le < now();
$$;

-- Session d'une requête : valide, utilisateur actif, propriétaire non suspendu ; prolongée de 12 h
-- sans dépasser sa limite. Aucune ligne sinon.
CREATE FUNCTION app.session_lire(p_empreinte bytea)
RETURNS TABLE (utilisateur_id bigint, tenant_id bigint, point_of_sale_id bigint, role text, email text, totp_ok boolean)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  UPDATE app.session_utilisateur s SET expire_le = least(now() + interval '12 hours', s.limite_le)
    FROM app.utilisateur u LEFT JOIN app.tenant t ON t.id = u.tenant_id
   WHERE s.empreinte = p_empreinte AND s.utilisateur_id = u.id
     AND s.expire_le > now() AND s.limite_le > now()
     AND u.actif AND NOT coalesce(t.suspendu, false)
  RETURNING u.id, u.tenant_id, u.point_of_sale_id, u.role, u.email, s.totp_ok
$$;

CREATE FUNCTION app.session_fermer(p_empreinte bytea)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$ DELETE FROM app.session_utilisateur WHERE empreinte = p_empreinte $$;

-- TOTP : secret chiffré du super-admin de la session, et validation d'un pas (pas de rejeu).
CREATE FUNCTION app.totp_secret(p_empreinte bytea)
RETURNS TABLE (utilisateur_id bigint, email text, secret bytea, dernier_pas bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  SELECT u.id, u.email, u.totp_secret, u.totp_dernier_pas FROM app.session_utilisateur s JOIN app.utilisateur u ON u.id = s.utilisateur_id
   WHERE s.empreinte = p_empreinte AND s.expire_le > now() AND u.role = 'super_admin' AND u.actif
$$;

CREATE FUNCTION app.totp_valider(p_empreinte bytea, p_pas bigint)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_u bigint;
BEGIN
  -- Le pas doit être STRICTEMENT postérieur au dernier accepté : un code ne sert qu'une fois.
  UPDATE app.utilisateur u SET totp_dernier_pas = p_pas
    FROM app.session_utilisateur s
   WHERE s.empreinte = p_empreinte AND s.utilisateur_id = u.id AND u.role = 'super_admin' AND u.totp_dernier_pas < p_pas
  RETURNING u.id INTO v_u;
  IF v_u IS NULL THEN RETURN false; END IF;
  UPDATE app.session_utilisateur SET totp_ok = true WHERE empreinte = p_empreinte;
  INSERT INTO app.audit_log (tenant_id, acteur, action, objet) VALUES (NULL, 'utilisateur:' || v_u, 'totp_valide', 'utilisateur:' || v_u);
  RETURN true;
END;
$$;

-- Création du super-admin : script manuel sur le nœud (ADR 0014 §3) ; aucun rôle de connexion.
CREATE FUNCTION app.super_admin_creer(p_email text, p_mot_de_passe text, p_totp_secret bytea)
RETURNS bigint
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  INSERT INTO app.utilisateur (role, email, nom, mot_de_passe, totp_secret)
  VALUES ('super_admin', lower(p_email), 'super-admin', p_mot_de_passe, p_totp_secret) RETURNING id
$$;

REVOKE ALL ON FUNCTION app.inscription(text, text, text), app.connexion_lire(text), app.connexion_echouee(text),
  app.session_ouvrir(bigint, bytea), app.session_lire(bytea), app.session_fermer(bytea), app.totp_secret(bytea),
  app.totp_valider(bytea, bigint), app.super_admin_creer(text, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.inscription(text, text, text), app.connexion_lire(text), app.connexion_echouee(text),
  app.session_ouvrir(bigint, bytea), app.session_lire(bytea), app.session_fermer(bytea), app.totp_secret(bytea),
  app.totp_valider(bytea, bigint) TO wk_api;

RESET ROLE;
