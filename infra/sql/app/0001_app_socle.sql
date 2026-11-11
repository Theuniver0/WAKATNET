-- WAKATNET — migration 0001 : socle du schéma app (phase 1, ticket 02).
-- ADR 0006 (contrats), ADR 0008 (migrations SQL d'abord, reprises par Prisma en phase 2).
-- Exécutée par infra/sql/migrer.sh, dans une transaction, par le superutilisateur.

-- ---------------------------------------------------------------------------
-- Rôles : le propriétaire des objets ne se connecte jamais (ADR 0006 §1).
-- Les rôles de connexion reçoivent leur mot de passe hors migration (migrer.sh).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wakatnet_owner') THEN
    CREATE ROLE wakatnet_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wk_radius') THEN
    CREATE ROLE wk_radius LOGIN;
  END IF;
END $$;

-- Rien pour PUBLIC : ni connexion implicite aux schémas, ni EXECUTE par défaut (ADR 0008 §3 bis).
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CREATE ON DATABASE wakatnet TO wakatnet_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE wakatnet_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
-- Le propriétaire utilise gen_random_bytes (pgcrypto, schéma public) : accès explicite,
-- puisque PUBLIC n'a plus aucun droit sur ce schéma.
GRANT USAGE ON SCHEMA public TO wakatnet_owner;

SET ROLE wakatnet_owner;

CREATE SCHEMA app;

CREATE TABLE app.tenant (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nom         text NOT NULL,
  -- Suspension ADMINISTRATIVE par le super-admin. Jamais liée au solde de crédits (ADR 0001, 0002).
  suspendu    boolean NOT NULL DEFAULT false,
  cree_le     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.site (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   bigint NOT NULL REFERENCES app.tenant (id),
  nom         text NOT NULL,
  UNIQUE (tenant_id, id)
);

CREATE TABLE app.router (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id             bigint NOT NULL,
  site_id               bigint NOT NULL,
  overlay_ip            inet   NOT NULL UNIQUE CHECK (family(overlay_ip) = 4 AND masklen(overlay_ip) = 32),
  shortname             text   NOT NULL UNIQUE CHECK (shortname ~ '^[A-Za-z0-9._-]{1,64}$'),
  actif                 boolean NOT NULL DEFAULT true,
  -- Époque d'accounting, incrémentée à chaque Accounting-On/Off (ADR 0006 §8).
  epoch                 bigint  NOT NULL DEFAULT 0,
  -- Exception tracée au Message-Authenticator (ADR 0003) ; false = exigé.
  require_ma_exception  boolean NOT NULL DEFAULT false,
  -- Port de /radius incoming du routeur (1700 d'après la doc 7.25 ; à confirmer sur CHR).
  coa_port              integer NOT NULL DEFAULT 1700 CHECK (coa_port BETWEEN 1 AND 65535),
  FOREIGN KEY (tenant_id, site_id) REFERENCES app.site (tenant_id, id)
);

CREATE TABLE app.plan (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        bigint NOT NULL REFERENCES app.tenant (id),
  nom              text   NOT NULL,
  prix_xof         bigint NOT NULL CHECK (prix_xof >= 0),          -- XOF entiers (A1)
  uptime_limit_s   integer CHECK (uptime_limit_s > 0),             -- temps consommé (§5.3)
  validity_s       integer CHECK (validity_s > 0),                 -- fenêtre depuis l'activation
  data_limit_bytes bigint  CHECK (data_limit_bytes > 0),           -- volume total
  -- Chaîne Mikrotik-Rate-Limit saisie par le propriétaire : caractères contrôlés (ADR 0006 §2).
  rate_limit       text    CHECK (rate_limit ~ '^[0-9A-Za-z/ .:-]{1,64}$'),
  devices          integer NOT NULL DEFAULT 1 CHECK (devices BETWEEN 1 AND 64),
  bind_mac         boolean NOT NULL DEFAULT false,
  scope            text    NOT NULL DEFAULT 'tenant' CHECK (scope IN ('tenant', 'site')),
  site_id          bigint,
  CHECK ((scope = 'site') = (site_id IS NOT NULL)),
  UNIQUE (tenant_id, id)
);

-- Ticket : code + COPIE FIGÉE du forfait (§5.3). Modifier le forfait ne change pas les tickets vendus.
CREATE TABLE app.voucher (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id          bigint NOT NULL,
  plan_id            bigint NOT NULL,
  code               text   NOT NULL CHECK (code ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8,16}$'),
  f_prix_xof         bigint  NOT NULL CHECK (f_prix_xof >= 0),
  f_uptime_limit_s   integer,
  f_validity_s       integer,
  f_data_limit_bytes bigint,
  f_rate_limit       text    CHECK (f_rate_limit ~ '^[0-9A-Za-z/ .:-]{1,64}$'),
  f_devices          integer NOT NULL CHECK (f_devices BETWEEN 1 AND 64),
  f_bind_mac         boolean NOT NULL DEFAULT false,
  f_scope            text    NOT NULL CHECK (f_scope IN ('tenant', 'site')),
  f_site_id          bigint,
  expires_at         timestamptz,                  -- expiration absolue (lot périmé)
  activated_at       timestamptz,                  -- posé au premier Start (ticket 04)
  cree_le            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES app.plan (tenant_id, id)
);

-- Journal d'audit minimal (SPEC §10.1) ; enrichi en phase 2.
CREATE TABLE app.audit_log (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  le      timestamptz NOT NULL DEFAULT now(),
  acteur  text NOT NULL,
  action  text NOT NULL,
  objet   text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- Codes de ticket (ADR 0006 §15) : 31 symboles sans ambiguïté, générateur
-- cryptographique (pgcrypto), tirage par rejet des octets >= 248 (= 31 x 8),
-- donc sans biais de modulo. random() est interdit.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.generer_code(p_longueur integer DEFAULT 8)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, public, pg_temp
AS $$
DECLARE
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  resultat text := '';
  octets   bytea;
  i        integer;
  b        integer;
BEGIN
  IF p_longueur NOT BETWEEN 8 AND 16 THEN
    RAISE EXCEPTION 'longueur de code hors bornes : %', p_longueur;
  END IF;
  WHILE length(resultat) < p_longueur LOOP
    octets := public.gen_random_bytes(32);
    FOR i IN 0 .. 31 LOOP
      b := get_byte(octets, i);
      IF b < 248 THEN
        resultat := resultat || substr(alphabet, (b % 31) + 1, 1);
        EXIT WHEN length(resultat) = p_longueur;
      END IF;
    END LOOP;
  END LOOP;
  RETURN resultat;
END;
$$;

-- Crée un ticket avec la copie figée de son forfait ; renvoie le code.
CREATE FUNCTION app.voucher_creer(p_tenant bigint, p_plan bigint, p_expires_at timestamptz DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, public, pg_temp
AS $$
DECLARE
  p     app.plan%ROWTYPE;
  code  text;
BEGIN
  SELECT * INTO STRICT p FROM app.plan WHERE id = p_plan AND tenant_id = p_tenant;
  FOR essai IN 1 .. 5 LOOP
    code := app.generer_code(8);
    BEGIN
      INSERT INTO app.voucher (tenant_id, plan_id, code, f_prix_xof, f_uptime_limit_s, f_validity_s,
                               f_data_limit_bytes, f_rate_limit, f_devices, f_bind_mac, f_scope, f_site_id, expires_at)
      VALUES (p_tenant, p_plan, code, p.prix_xof, p.uptime_limit_s, p.validity_s,
              p.data_limit_bytes, p.rate_limit, p.devices, p.bind_mac, p.scope, p.site_id, p_expires_at);
      RETURN code;
    EXCEPTION WHEN unique_violation THEN
      -- Collision (rare : ~8,5 x 10^11 codes) : nouveau tirage.
    END;
  END LOOP;
  RAISE EXCEPTION 'impossible de générer un code unique';
END;
$$;

RESET ROLE;

-- Fonctions d'administration : aucun rôle de connexion n'y a droit (l'API les recevra en phase 2).
REVOKE ALL ON FUNCTION app.generer_code(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.voucher_creer(bigint, bigint, timestamptz) FROM PUBLIC;
