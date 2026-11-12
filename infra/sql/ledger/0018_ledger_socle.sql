-- WAKATNET — migration 0018 : grand livre en partie double, ajout seul (phase 3, ticket 02).
-- Ticket : .scratch/phase-3-portail-paiement/issues/02-grand-livre.md
-- Contrats : ADR 0013 §3, §4, §5 ; SPEC §8.1, §8.4 ; CONTRIBUTING A1 à A4, A6.
--
-- Seule porte d'écriture : ledger.ecrire(). Aucun rôle de connexion n'a de droit sur ce schéma :
-- seules des fonctions SECURITY DEFINER du propriétaire y écrivent (confirmation d'une vente,
-- rechargement, frais papier). Le solde n'est jamais stocké : il se recalcule (§8.4, rejeu).

SET ROLE wakatnet_owner;

CREATE SCHEMA ledger;

CREATE TABLE ledger.compte (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code      text   NOT NULL UNIQUE
            CHECK (code ~ '^(plateforme:[a-z_]+(:[a-z_]+)*|proprietaire:[1-9][0-9]{0,18}:credits)$'),
  -- Sens normal du solde : débit (actif) ou crédit (dette, produit).
  sens      text   NOT NULL CHECK (sens IN ('debit', 'credit')),
  -- Sans clé étrangère vers app.tenant : le grand livre survit à toute suppression ou
  -- troncature applicative (ajout seul, A2 ; durée comptable légale, ADR 0005 §2).
  tenant_id bigint,
  cree_le   timestamptz NOT NULL DEFAULT now(),
  CHECK ((tenant_id IS NULL) = (code LIKE 'plateforme:%'))
);

INSERT INTO ledger.compte (code, sens) VALUES
  ('plateforme:tresorerie', 'debit'),
  ('plateforme:produit:commission', 'credit'),
  ('plateforme:produit:frais_papier', 'credit');

CREATE TABLE ledger.transaction (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Clé d'idempotence (A3) : une même clé ne compte jamais deux fois.
  cle       text   NOT NULL UNIQUE CHECK (length(cle) BETWEEN 1 AND 200),
  nature    text   NOT NULL CHECK (nature IN ('recharge', 'commission', 'frais_papier', 'correction')),
  -- Objet métier concerné : paiement:ID, voucher:ID, recharge:REF, transaction:ID (correction).
  objet     text   NOT NULL CHECK (objet ~ '^[a-z_]+:[A-Za-z0-9_.:-]{1,120}$'),
  -- Taux et plancher figés au moment de l'opération (A3, ADR 0002).
  taux_bps  integer CHECK (taux_bps BETWEEN 0 AND 10000),
  minimum   bigint  CHECK (minimum >= 0),
  cree_le   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transaction_objet ON ledger.transaction (objet);

CREATE TABLE ledger.ecriture (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id bigint NOT NULL REFERENCES ledger.transaction (id),
  compte_id      bigint NOT NULL REFERENCES ledger.compte (id),
  debit          bigint NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit         bigint NOT NULL DEFAULT 0 CHECK (credit >= 0),
  CHECK ((debit > 0) <> (credit > 0))
);
CREATE INDEX ecriture_transaction ON ledger.ecriture (transaction_id);
CREATE INDEX ecriture_compte ON ledger.ecriture (compte_id);

-- ---------------------------------------------------------------------------
-- Équilibre, vérifié À LA VALIDATION (déclencheurs différés) : au moins deux lignes et
-- Σ débits = Σ crédits pour chaque transaction touchée, même par un INSERT ultérieur.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ledger._verifier(p_tx bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ledger, pg_temp
AS $$
DECLARE
  v_n      bigint;
  v_debit  numeric;
  v_credit numeric;
BEGIN
  SELECT count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    INTO v_n, v_debit, v_credit
    FROM ledger.ecriture WHERE transaction_id = p_tx;
  IF v_n < 2 OR v_debit <> v_credit THEN
    RAISE EXCEPTION 'grand livre : transaction % déséquilibrée (% lignes, débits %, crédits %)', p_tx, v_n, v_debit, v_credit
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE FUNCTION ledger._equilibre_transaction()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ledger, pg_temp
AS $$ BEGIN PERFORM ledger._verifier(NEW.id); RETURN NULL; END; $$;

CREATE FUNCTION ledger._equilibre_ecriture()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ledger, pg_temp
AS $$ BEGIN PERFORM ledger._verifier(NEW.transaction_id); RETURN NULL; END; $$;

-- SECURITY DEFINER : un déclencheur DIFFÉRÉ s'exécute à la validation, hors de la fonction qui a
-- écrit, donc avec les droits du rôle de connexion (wk_api), qui n'en a aucun sur ledger.
CREATE CONSTRAINT TRIGGER equilibre_transaction AFTER INSERT ON ledger.transaction
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger._equilibre_transaction();
CREATE CONSTRAINT TRIGGER equilibre_ecriture AFTER INSERT ON ledger.ecriture
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger._equilibre_ecriture();

-- ---------------------------------------------------------------------------
-- Ajout seul (A2), pour TOUS les rôles, propriétaire des tables compris.
-- Une correction est une contre-écriture (nature 'correction').
-- ---------------------------------------------------------------------------
CREATE FUNCTION ledger._ajout_seul()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'grand livre en ajout seul : % interdit sur ledger.%', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER ajout_seul BEFORE UPDATE OR DELETE ON ledger.compte FOR EACH ROW EXECUTE FUNCTION ledger._ajout_seul();
CREATE TRIGGER ajout_seul BEFORE UPDATE OR DELETE ON ledger.transaction FOR EACH ROW EXECUTE FUNCTION ledger._ajout_seul();
CREATE TRIGGER ajout_seul BEFORE UPDATE OR DELETE ON ledger.ecriture FOR EACH ROW EXECUTE FUNCTION ledger._ajout_seul();
CREATE TRIGGER ajout_seul_vidage BEFORE TRUNCATE ON ledger.compte FOR EACH STATEMENT EXECUTE FUNCTION ledger._ajout_seul();
CREATE TRIGGER ajout_seul_vidage BEFORE TRUNCATE ON ledger.transaction FOR EACH STATEMENT EXECUTE FUNCTION ledger._ajout_seul();
CREATE TRIGGER ajout_seul_vidage BEFORE TRUNCATE ON ledger.ecriture FOR EACH STATEMENT EXECUTE FUNCTION ledger._ajout_seul();

-- ---------------------------------------------------------------------------
-- Arrondis (ADR 0013 §5) : au franc le plus proche, 0,5 vers le haut, en entiers.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ledger.commission(p_montant bigint, p_bps integer, p_minimum bigint DEFAULT 0)
RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_montant < 0 OR p_bps NOT BETWEEN 0 AND 10000 OR p_minimum < 0 THEN NULL
    ELSE greatest((p_montant * p_bps + 5000) / 10000, p_minimum)
  END
$$;

-- ---------------------------------------------------------------------------
-- Compte de crédits d'un propriétaire, créé à la première écriture.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ledger._compte(p_code text)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = ledger, pg_temp
AS $$
DECLARE
  v_id     bigint;
  v_tenant bigint;
BEGIN
  SELECT id INTO v_id FROM ledger.compte WHERE code = p_code;
  IF FOUND THEN RETURN v_id; END IF;
  IF p_code !~ '^proprietaire:[1-9][0-9]{0,18}:credits$' THEN
    RAISE EXCEPTION 'grand livre : compte inconnu %', p_code;
  END IF;
  v_tenant := split_part(p_code, ':', 2)::bigint;
  -- Contrôle à la CRÉATION du compte (pas de clé étrangère : voir ledger.compte).
  IF NOT EXISTS (SELECT 1 FROM app.tenant WHERE id = v_tenant) THEN
    RAISE EXCEPTION 'grand livre : propriétaire % inconnu', v_tenant;
  END IF;
  INSERT INTO ledger.compte (code, sens, tenant_id) VALUES (p_code, 'credit', v_tenant)
  ON CONFLICT (code) DO NOTHING;
  SELECT id INTO STRICT v_id FROM ledger.compte WHERE code = p_code;
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- ledger.ecrire — SEULE porte d'écriture.
--   p_lignes : [{"compte": "...", "debit": n} | {"compte": "...", "credit": n}, ...], n entier > 0.
-- Idempotente sur p_cle : même contenu → transaction existante rendue ; contenu différent →
-- erreur (un conflit n'est jamais un double comptage). Équilibre vérifié à la validation.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ledger.ecrire(p_cle text, p_nature text, p_objet text, p_taux_bps integer,
                              p_minimum bigint, p_lignes jsonb)
RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ledger, pg_temp
AS $$
DECLARE
  v_id        bigint;
  v_existant  ledger.transaction%ROWTYPE;
  v_ligne     jsonb;
  v_canon     jsonb;
  v_canon_ex  jsonb;
BEGIN
  IF jsonb_typeof(p_lignes) <> 'array' OR jsonb_array_length(p_lignes) < 2 THEN
    RAISE EXCEPTION 'grand livre : au moins deux lignes';
  END IF;
  FOR v_ligne IN SELECT * FROM jsonb_array_elements(p_lignes) LOOP
    IF jsonb_typeof(v_ligne -> 'compte') <> 'string'
       OR ((v_ligne ? 'debit') = (v_ligne ? 'credit'))
       OR (SELECT count(*) FROM jsonb_object_keys(v_ligne)) <> 2
       OR coalesce(v_ligne ->> 'debit', v_ligne ->> 'credit') !~ '^[1-9][0-9]{0,17}$' THEN
      RAISE EXCEPTION 'grand livre : ligne invalide %', v_ligne;
    END IF;
  END LOOP;
  -- Forme canonique (ordre indifférent) pour comparer avec une transaction existante.
  SELECT jsonb_agg(x ORDER BY x::text) INTO v_canon FROM (
    SELECT jsonb_build_object('compte', l ->> 'compte',
                              'debit', coalesce((l ->> 'debit')::bigint, 0),
                              'credit', coalesce((l ->> 'credit')::bigint, 0)) AS x
      FROM jsonb_array_elements(p_lignes) l) s;

  PERFORM pg_advisory_xact_lock(hashtext('ledger:' || p_cle));
  SELECT * INTO v_existant FROM ledger.transaction WHERE cle = p_cle;
  IF FOUND THEN
    SELECT jsonb_agg(x ORDER BY x::text) INTO v_canon_ex FROM (
      SELECT jsonb_build_object('compte', c.code, 'debit', e.debit, 'credit', e.credit) AS x
        FROM ledger.ecriture e JOIN ledger.compte c ON c.id = e.compte_id
       WHERE e.transaction_id = v_existant.id) s;
    IF v_existant.nature = p_nature AND v_existant.objet = p_objet
       AND v_existant.taux_bps IS NOT DISTINCT FROM p_taux_bps
       AND v_existant.minimum IS NOT DISTINCT FROM p_minimum
       AND v_canon_ex = v_canon THEN
      RETURN v_existant.id;
    END IF;
    RAISE EXCEPTION 'grand livre : clé % déjà écrite avec un autre contenu', p_cle
      USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO ledger.transaction (cle, nature, objet, taux_bps, minimum)
  VALUES (p_cle, p_nature, p_objet, p_taux_bps, p_minimum)
  RETURNING id INTO v_id;
  INSERT INTO ledger.ecriture (transaction_id, compte_id, debit, credit)
  SELECT v_id, ledger._compte(l ->> 'compte'),
         coalesce((l ->> 'debit')::bigint, 0), coalesce((l ->> 'credit')::bigint, 0)
    FROM jsonb_array_elements(p_lignes) l;
  RETURN v_id;
END;
$$;

-- Solde d'un compte dans son sens normal (débit : Σd − Σc ; crédit : Σc − Σd). 0 si inconnu.
CREATE FUNCTION ledger.solde(p_code text)
RETURNS bigint
LANGUAGE sql STABLE
SET search_path = ledger, pg_temp
AS $$
  SELECT coalesce((SELECT CASE c.sens WHEN 'debit' THEN sum(e.debit) - sum(e.credit)
                                      ELSE sum(e.credit) - sum(e.debit) END
                     FROM ledger.compte c JOIN ledger.ecriture e ON e.compte_id = c.id
                    WHERE c.code = p_code
                    GROUP BY c.sens), 0)::bigint
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ledger FROM PUBLIC;
REVOKE ALL ON SCHEMA ledger FROM PUBLIC;

RESET ROLE;
