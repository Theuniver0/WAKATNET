-- WAKATNET — migration 0019 : paiements, compte marchand, confirmation d'une vente, crédits du
-- mode A (phase 3, tickets 03 et 04).
-- Tickets : .scratch/phase-3-portail-paiement/issues/03-paiements-mock.md, 04-confirmation-credits.md
-- Contrats : ADR 0013 §1, §2, §4, §5, §7, §8, §9, §11 ; SPEC §7.2, §8.2 ; ADR 0001, 0002, 0005 ; A5, A7.
--
-- Invariants du §7.2, portés par le SCHÉMA et non par la seule convention :
--   jamais de ticket sans paiement confirmé : le seul chemin qui crée un ticket vendu en ligne est
--     app.paiement_transition(..., 'SUCCEEDED'), dans la même transaction que la commission ;
--   jamais de paiement confirmé sans ticket : CHECK (statut confirmé) = (voucher_id renseigné).

SET ROLE wakatnet_owner;

-- ---------------------------------------------------------------------------
-- Paramètres d'argent du propriétaire (ADR 0001, 0002, 0013 §5).
-- ---------------------------------------------------------------------------
ALTER TABLE app.tenant
  ADD COLUMN settlement_mode   text    NOT NULL DEFAULT 'A' CHECK (settlement_mode IN ('A', 'B', 'C')),
  ADD COLUMN commission_bps    integer NOT NULL DEFAULT 1000 CHECK (commission_bps BETWEEN 0 AND 10000),
  ADD COLUMN commission_min    bigint  NOT NULL DEFAULT 0 CHECK (commission_min >= 0),
  ADD COLUMN offline_fee_bps   integer NOT NULL DEFAULT 1000 CHECK (offline_fee_bps BETWEEN 0 AND 10000),
  ADD COLUMN offline_fee_min   bigint  NOT NULL DEFAULT 10 CHECK (offline_fee_min >= 0),
  ADD COLUMN plafond_decouvert bigint  NOT NULL DEFAULT 3000 CHECK (plafond_decouvert >= 0),
  -- Mise en service des frais papier : jamais rétroactifs (relecture argent, I3).
  ADD COLUMN frais_papier_depuis timestamptz NOT NULL DEFAULT now();

-- Site : identifiant public (portail, jamais le numéro) et hôte hotspot déclaré (ADR 0013 §10).
ALTER TABLE app.site
  ADD COLUMN public_id     text NOT NULL UNIQUE DEFAULT translate(encode(public.gen_random_bytes(12), 'base64'), '+/', '-_')
                           CHECK (public_id ~ '^[A-Za-z0-9_-]{16}$'),
  -- Hôtes de la page de connexion du hotspot (adresse et nom DNS de chaque profil), relevés à
  -- l'enrôlement : SEULES cibles admises pour l'auto-connexion (relecture argent, I1).
  ADD COLUMN hotspot_hotes text[] NOT NULL DEFAULT '{}'
    CHECK (array_length(hotspot_hotes, 1) IS NULL OR array_length(hotspot_hotes, 1) <= 32);

-- ---------------------------------------------------------------------------
-- Compte marchand du propriétaire (mode A) : clés chiffrées par l'API (ADR 0013 §8). La base ne
-- voit que du chiffré ; l'identifiant de webhook est aléatoire (pas d'énumération).
-- ---------------------------------------------------------------------------
CREATE TABLE app.compte_marchand (
  tenant_id     bigint PRIMARY KEY REFERENCES app.tenant (id),
  fournisseur   text   NOT NULL CHECK (fournisseur ~ '^[a-z][a-z0-9_]{1,31}$'),
  webhook_id    text   NOT NULL UNIQUE DEFAULT translate(encode(public.gen_random_bytes(18), 'base64'), '+/', '-_')
                       CHECK (webhook_id ~ '^[A-Za-z0-9_-]{24}$'),
  cles          bytea  NOT NULL CHECK (length(cles) BETWEEN 30 AND 8192),
  maj_le        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.compte_marchand ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Paiement (ADR 0013 §2) et événements bruts des webhooks (§10.1).
-- ---------------------------------------------------------------------------
CREATE TABLE app.payment (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id              bigint NOT NULL REFERENCES app.tenant (id),
  site_id                bigint NOT NULL,
  plan_id                bigint NOT NULL,
  montant                bigint NOT NULL CHECK (montant > 0),
  devise                 text   NOT NULL DEFAULT 'XOF' CHECK (devise = 'XOF'),
  operateur              text   NOT NULL CHECK (operateur IN ('orange_bf', 'moov_bf')),
  fournisseur            text   NOT NULL,
  -- Notre référence, envoyée au fournisseur (idempotence de charge()).
  reference              text   NOT NULL UNIQUE CHECK (reference ~ '^wk_[A-Za-z0-9_-]{22}$'),
  reference_fournisseur  text   CHECK (length(reference_fournisseur) <= 128),
  statut                 text   NOT NULL DEFAULT 'CREATED'
                         CHECK (statut IN ('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'MISMATCH', 'REFUNDED')),
  -- Numéro du payeur sous trois formes (ADR 0005 §2) ; le clair est purgé à purge_numero_le.
  numero_clair           text   CHECK (numero_clair ~ '^[0-9]{8}$'),
  numero_hmac            bytea  NOT NULL CHECK (length(numero_hmac) = 32),
  numero_masque          text   NOT NULL,
  purge_numero_le        timestamptz NOT NULL,
  -- Empreinte du jeton d'appareil (ADR 0005 §1) ; le jeton lui-même ne quitte jamais l'appareil.
  jeton_appareil         bytea  NOT NULL CHECK (length(jeton_appareil) = 32),
  -- Clé de soumission du formulaire (P9) : une double soumission rend le même paiement.
  soumission             text   NOT NULL CHECK (soumission ~ '^[A-Za-z0-9_-]{16,64}$'),
  voucher_id             bigint UNIQUE REFERENCES app.voucher (id),
  cree_le                timestamptz NOT NULL DEFAULT now(),
  maj_le                 timestamptz NOT NULL DEFAULT now(),
  expire_le              timestamptz NOT NULL,          -- délai du portail (3 min)
  verifier_jusqu_au      timestamptz NOT NULL,          -- rapprochement pendant 24 h
  prochaine_verif_le     timestamptz NOT NULL,
  detail                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, soumission),
  FOREIGN KEY (tenant_id, site_id) REFERENCES app.site (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES app.plan (tenant_id, id),
  -- Jamais de paiement confirmé sans ticket, jamais de ticket lié à un paiement non confirmé.
  CHECK ((statut IN ('SUCCEEDED', 'REFUNDED')) = (voucher_id IS NOT NULL))
);
CREATE INDEX payment_a_verifier ON app.payment (prochaine_verif_le)
  WHERE statut IN ('CREATED', 'PENDING', 'EXPIRED', 'FAILED');
CREATE INDEX payment_numero ON app.payment (site_id, numero_hmac);
ALTER TABLE app.payment ENABLE ROW LEVEL SECURITY;
CREATE POLICY cloisonnement ON app.payment TO wk_api
  USING (tenant_id = app.tenant_courant()) WITH CHECK (tenant_id = app.tenant_courant());

CREATE TABLE app.payment_event (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fournisseur   text   NOT NULL,
  id_evenement  text   NOT NULL CHECK (length(id_evenement) BETWEEN 1 AND 200),
  tenant_id     bigint NOT NULL REFERENCES app.tenant (id),
  payment_id    bigint REFERENCES app.payment (id),
  recu_le       timestamptz NOT NULL DEFAULT now(),
  corps         bytea  NOT NULL,
  -- Par propriétaire : un propriétaire ne peut pas « réserver » l'identifiant d'événement d'un
  -- autre et empêcher la conservation de son corps brut (relecture argent, M1).
  UNIQUE (tenant_id, fournisseur, id_evenement)
);
ALTER TABLE app.payment_event ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Solde de crédits d'un propriétaire (ADR 0013 §4) : recalculé, jamais stocké.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.credits_solde(p_tenant bigint)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, ledger, pg_temp
AS $$ SELECT ledger.solde('proprietaire:' || p_tenant || ':credits') $$;

-- Vente en ligne possible ? (ADR 0001, 0013 §7) — lue à la CRÉATION d'un paiement seulement.
CREATE FUNCTION app._vente_en_ligne(p_tenant bigint)
RETURNS text
LANGUAGE sql STABLE
SET search_path = app, ledger, pg_temp
AS $$
  SELECT CASE
    WHEN t.suspendu THEN 'vente_suspendue'
    WHEN t.settlement_mode <> 'A' THEN 'vente_suspendue'
    WHEN NOT EXISTS (SELECT 1 FROM app.compte_marchand m WHERE m.tenant_id = t.id) THEN 'sans_compte_marchand'
    WHEN app.credits_solde(t.id) < -t.plafond_decouvert THEN 'vente_suspendue'
    ELSE 'ok' END
    FROM app.tenant t WHERE t.id = p_tenant
$$;

-- ---------------------------------------------------------------------------
-- Rechargement des crédits (ADR 0013 §7) : super-admin seulement (aucun rôle de connexion n'a
-- EXECUTE), idempotent sur la référence. Alerte « crédits bas » : voir app._alerte_credits.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.credits_recharger(p_tenant bigint, p_montant bigint, p_reference text)
RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, ledger, pg_temp
AS $$
DECLARE
  v_tx bigint;
BEGIN
  IF p_montant IS NULL OR p_montant <= 0 THEN
    RAISE EXCEPTION 'rechargement : montant entier strictement positif';
  END IF;
  IF p_reference !~ '^[A-Za-z0-9_.-]{1,100}$' THEN
    RAISE EXCEPTION 'rechargement : référence invalide';
  END IF;
  PERFORM 1 FROM app.tenant WHERE id = p_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'rechargement : propriétaire inconnu'; END IF;
  v_tx := ledger.ecrire('recharge:' || p_reference, 'recharge', 'recharge:' || p_reference, NULL, NULL,
    jsonb_build_array(jsonb_build_object('compte', 'plateforme:tresorerie', 'debit', p_montant),
                      jsonb_build_object('compte', 'proprietaire:' || p_tenant || ':credits', 'credit', p_montant)));
  INSERT INTO app.audit_log (tenant_id, acteur, action, objet, details)
  SELECT p_tenant, 'super-admin', 'credits_recharges', 'recharge:' || p_reference, jsonb_build_object('montant', p_montant)
   WHERE NOT EXISTS (SELECT 1 FROM app.audit_log WHERE action = 'credits_recharges' AND objet = 'recharge:' || p_reference);
  RETURN v_tx;
END;
$$;

-- Alerte « crédits bas » : solde sous 20 % du dernier rechargement ; une seule par rechargement.
CREATE FUNCTION app._alerte_credits(p_tenant bigint)
RETURNS void
LANGUAGE plpgsql
SET search_path = app, ledger, pg_temp
AS $$
DECLARE
  v_dernier ledger.transaction%ROWTYPE;
  v_montant bigint;
BEGIN
  SELECT t.* INTO v_dernier FROM ledger.transaction t
    JOIN ledger.ecriture e ON e.transaction_id = t.id
    JOIN ledger.compte c ON c.id = e.compte_id
   WHERE t.nature = 'recharge' AND c.code = 'proprietaire:' || p_tenant || ':credits'
   ORDER BY t.id DESC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT e.credit INTO v_montant FROM ledger.ecriture e JOIN ledger.compte c ON c.id = e.compte_id
   WHERE e.transaction_id = v_dernier.id AND c.code = 'proprietaire:' || p_tenant || ':credits';
  IF app.credits_solde(p_tenant) * 5 < v_montant THEN
    INSERT INTO app.audit_log (tenant_id, acteur, action, objet, details)
    SELECT p_tenant, 'plateforme', 'alerte_credits_bas', 'transaction:' || v_dernier.id,
           jsonb_build_object('solde', app.credits_solde(p_tenant), 'dernier_rechargement', v_montant)
     WHERE NOT EXISTS (SELECT 1 FROM app.audit_log WHERE action = 'alerte_credits_bas' AND objet = 'transaction:' || v_dernier.id);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Compte marchand : enregistrement (propriétaire du contexte RLS) et lectures internes.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.compte_marchand_enregistrer(p_fournisseur text, p_cles bytea)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_tenant bigint := app.tenant_courant();
  v_webhook text;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'compte marchand sans propriétaire (contexte RLS absent)'; END IF;
  -- Changer de fournisseur avec des paiements encore ouverts les rendrait invérifiables : verify()
  -- serait demandé au nouveau fournisseur, qui ne les connaît pas (relecture argent, I4).
  IF EXISTS (SELECT 1 FROM app.compte_marchand m WHERE m.tenant_id = v_tenant AND m.fournisseur <> p_fournisseur)
     AND EXISTS (SELECT 1 FROM app.payment p WHERE p.tenant_id = v_tenant
                  AND p.statut IN ('CREATED', 'PENDING', 'EXPIRED', 'FAILED') AND p.verifier_jusqu_au > now()) THEN
    RAISE EXCEPTION 'changement de fournisseur impossible : paiements encore ouverts' USING ERRCODE = 'object_in_use';
  END IF;
  INSERT INTO app.compte_marchand (tenant_id, fournisseur, cles) VALUES (v_tenant, p_fournisseur, p_cles)
  ON CONFLICT (tenant_id) DO UPDATE SET fournisseur = EXCLUDED.fournisseur, cles = EXCLUDED.cles, maj_le = now()
  RETURNING webhook_id INTO v_webhook;
  INSERT INTO app.audit_log (tenant_id, acteur, action, objet, details)
  VALUES (v_tenant, 'tenant:' || v_tenant, 'compte_marchand_enregistre', 'compte_marchand', jsonb_build_object('fournisseur', p_fournisseur));
  RETURN v_webhook;
END;
$$;

-- Par identifiant de webhook (route publique) : le propriétaire vient de la base, jamais du client.
CREATE FUNCTION app.compte_marchand_par_webhook(p_fournisseur text, p_webhook_id text)
RETURNS TABLE (tenant_id bigint, cles bytea)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$ SELECT m.tenant_id, m.cles FROM app.compte_marchand m WHERE m.fournisseur = p_fournisseur AND m.webhook_id = p_webhook_id $$;

CREATE FUNCTION app.compte_marchand_du_proprietaire(p_tenant bigint)
RETURNS TABLE (fournisseur text, cles bytea, webhook_id text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$ SELECT m.fournisseur, m.cles, m.webhook_id FROM app.compte_marchand m WHERE m.tenant_id = p_tenant $$;

-- Hôtes de connexion du hotspot d'un routeur enrôlé (adresse et nom DNS de chaque profil,
-- inventaire de l'étape 1) ajoutés à son site. Appelée par l'API après l'enrôlement.
CREATE FUNCTION app.site_hotes_depuis_inventaire(p_router bigint)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  UPDATE app.site s SET hotspot_hotes = (
    SELECT coalesce(array_agg(DISTINCT h ORDER BY h), '{}') FROM (
      SELECT unnest(s.hotspot_hotes) AS h
      UNION
      SELECT lower(x ->> k) FROM app.router r, jsonb_array_elements(r.inventaire -> 'hotspots') x, unnest(ARRAY['adresse', 'dns']) k
       WHERE r.id = p_router) t
     WHERE h ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$')
   FROM app.router r WHERE r.id = p_router AND s.id = r.site_id AND s.tenant_id = r.tenant_id
$$;

-- ---------------------------------------------------------------------------
-- Forfaits proposés sur le portail d'un site (route publique).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.portail_site(p_public_id text)
RETURNS TABLE (site_id bigint, tenant_id bigint, site_nom text, hotspot_hotes text[], vente text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, ledger, pg_temp
AS $$
  SELECT s.id, s.tenant_id, s.nom, s.hotspot_hotes, app._vente_en_ligne(s.tenant_id)
    FROM app.site s WHERE s.public_id = p_public_id
$$;

CREATE FUNCTION app.portail_forfaits(p_public_id text)
RETURNS TABLE (plan_id bigint, nom text, prix_xof bigint, uptime_limit_s integer, validity_s integer,
               data_limit_bytes bigint, devices integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  SELECT p.id, p.nom, p.prix_xof, p.uptime_limit_s, p.validity_s, p.data_limit_bytes, p.devices
    FROM app.site s JOIN app.plan p ON p.tenant_id = s.tenant_id
   WHERE s.public_id = p_public_id AND p.prix_xof > 0 AND (p.scope = 'tenant' OR p.site_id = s.id)
   ORDER BY p.prix_xof, p.id
$$;

-- ---------------------------------------------------------------------------
-- Création d'un paiement (route publique du portail). Idempotente sur (site, soumission) : P9.
--   statut : 'cree' | 'deja' | 'site_inconnu' | 'forfait_inconnu' | 'vente_suspendue' | 'sans_compte_marchand'
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.paiement_creer(p_public_id text, p_plan bigint, p_operateur text, p_numero_clair text,
                                   p_numero_hmac bytea, p_numero_masque text, p_jeton bytea, p_soumission text,
                                   p_reference text)
RETURNS TABLE (statut text, payment_id bigint, reference text, montant bigint, tenant_id bigint,
               fournisseur text, statut_paiement text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, ledger, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_site   app.site%ROWTYPE;
  v_plan   app.plan%ROWTYPE;
  v_vente  text;
  v_p      app.payment%ROWTYPE;
BEGIN
  SELECT * INTO v_site FROM app.site s WHERE s.public_id = p_public_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'site_inconnu'::text, NULL::bigint, NULL::text, NULL::bigint, NULL::bigint, NULL::text, NULL::text; RETURN;
  END IF;
  -- P9 : même soumission → même paiement, sans rien recréer.
  SELECT * INTO v_p FROM app.payment p WHERE p.tenant_id = v_site.tenant_id AND p.soumission = p_soumission;
  IF FOUND THEN
    RETURN QUERY SELECT 'deja'::text, v_p.id, v_p.reference, v_p.montant, v_p.tenant_id, v_p.fournisseur, v_p.statut; RETURN;
  END IF;
  SELECT * INTO v_plan FROM app.plan p
   WHERE p.id = p_plan AND p.tenant_id = v_site.tenant_id AND p.prix_xof > 0 AND (p.scope = 'tenant' OR p.site_id = v_site.id);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'forfait_inconnu'::text, NULL::bigint, NULL::text, NULL::bigint, NULL::bigint, NULL::text, NULL::text; RETURN;
  END IF;
  v_vente := app._vente_en_ligne(v_site.tenant_id);
  IF v_vente <> 'ok' THEN
    RETURN QUERY SELECT v_vente, NULL::bigint, NULL::text, NULL::bigint, NULL::bigint, NULL::text, NULL::text; RETURN;
  END IF;
  INSERT INTO app.payment (tenant_id, site_id, plan_id, montant, operateur, fournisseur, reference, numero_clair,
                           numero_hmac, numero_masque, purge_numero_le, jeton_appareil, soumission, expire_le,
                           verifier_jusqu_au, prochaine_verif_le)
  SELECT v_site.tenant_id, v_site.id, v_plan.id, v_plan.prix_xof, p_operateur, m.fournisseur, p_reference, p_numero_clair,
         p_numero_hmac, p_numero_masque, now() + interval '6 months', p_jeton, p_soumission, now() + interval '3 minutes',
         now() + interval '24 hours', now() + interval '2 minutes'
    FROM app.compte_marchand m WHERE m.tenant_id = v_site.tenant_id
  ON CONFLICT (tenant_id, soumission) DO NOTHING
  RETURNING * INTO v_p;
  IF v_p.id IS NULL THEN   -- course entre deux soumissions identiques : la première a gagné
    SELECT * INTO STRICT v_p FROM app.payment p WHERE p.tenant_id = v_site.tenant_id AND p.soumission = p_soumission;
    RETURN QUERY SELECT 'deja'::text, v_p.id, v_p.reference, v_p.montant, v_p.tenant_id, v_p.fournisseur, v_p.statut; RETURN;
  END IF;
  RETURN QUERY SELECT 'cree'::text, v_p.id, v_p.reference, v_p.montant, v_p.tenant_id, v_p.fournisseur, v_p.statut;
END;
$$;

-- ---------------------------------------------------------------------------
-- Transition d'état (ADR 0013 §2), seule porte de changement de statut. Ligne verrouillée.
-- Vers SUCCEEDED : montant et devise vérifiés (sinon MISMATCH, P4), puis, dans CETTE transaction,
-- ticket (copie figée du forfait), lien paiement ↔ ticket, commission au grand livre (A7).
-- Rend le statut résultant. Idempotente : rejouer une transition ne change rien (P1).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.paiement_transition(p_reference text, p_vers text, p_reference_fournisseur text,
                                        p_montant bigint, p_devise text, p_origine text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, ledger, pg_temp
AS $$
DECLARE
  v_p       app.payment%ROWTYPE;
  v_t       app.tenant%ROWTYPE;
  v_code    text;
  v_voucher bigint;
  v_comm    bigint;
BEGIN
  IF p_vers NOT IN ('PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED') THEN
    RAISE EXCEPTION 'transition vers % interdite par cette fonction', p_vers;
  END IF;
  SELECT * INTO v_p FROM app.payment p WHERE p.reference = p_reference FOR UPDATE;
  IF NOT FOUND THEN RETURN 'inconnu'; END IF;
  IF v_p.statut = p_vers OR v_p.statut IN ('SUCCEEDED', 'REFUNDED', 'MISMATCH') THEN
    RETURN v_p.statut;                               -- idempotence ; états finaux intouchables ici
  END IF;
  IF p_vers = 'PENDING' AND v_p.statut <> 'CREATED' THEN RETURN v_p.statut; END IF;
  IF p_vers = 'FAILED' AND v_p.statut NOT IN ('CREATED', 'PENDING') THEN RETURN v_p.statut; END IF;
  IF p_vers = 'EXPIRED' AND v_p.statut NOT IN ('CREATED', 'PENDING') THEN RETURN v_p.statut; END IF;

  IF p_vers = 'SUCCEEDED' AND (p_montant IS DISTINCT FROM v_p.montant OR p_devise IS DISTINCT FROM v_p.devise) THEN
    UPDATE app.payment SET statut = 'MISMATCH', maj_le = now(),
           reference_fournisseur = coalesce(p_reference_fournisseur, reference_fournisseur),
           detail = detail || jsonb_build_object('mismatch', jsonb_build_object('montant', p_montant, 'devise', p_devise))
     WHERE id = v_p.id;
    INSERT INTO app.audit_log (tenant_id, acteur, action, objet, details)
    VALUES (v_p.tenant_id, 'plateforme', 'alerte_paiement_mismatch', 'paiement:' || v_p.id,
            jsonb_build_object('attendu', v_p.montant, 'recu', p_montant, 'devise', p_devise, 'origine', p_origine));
    RETURN 'MISMATCH';
  END IF;

  IF p_vers = 'SUCCEEDED' THEN
    SELECT * INTO STRICT v_t FROM app.tenant t WHERE t.id = v_p.tenant_id;
    -- Ticket : même générateur et même copie figée que app.voucher_creer (0001).
    v_code := app.voucher_creer(v_p.tenant_id, v_p.plan_id);
    SELECT v.id INTO STRICT v_voucher FROM app.voucher v WHERE v.tenant_id = v_p.tenant_id AND v.code = v_code;
    UPDATE app.payment SET statut = 'SUCCEEDED', voucher_id = v_voucher, maj_le = now(),
           reference_fournisseur = coalesce(p_reference_fournisseur, reference_fournisseur),
           detail = CASE WHEN v_p.statut = 'EXPIRED'
                         THEN detail || jsonb_build_object('succes_apres_expiration', now()) ELSE detail END
     WHERE id = v_p.id;
    v_comm := ledger.commission(v_p.montant, v_t.commission_bps, v_t.commission_min);
    IF v_comm > 0 THEN
      PERFORM ledger.ecrire('commission:paiement:' || v_p.id, 'commission', 'paiement:' || v_p.id,
        v_t.commission_bps, v_t.commission_min,
        jsonb_build_array(jsonb_build_object('compte', 'proprietaire:' || v_p.tenant_id || ':credits', 'debit', v_comm),
                          jsonb_build_object('compte', 'plateforme:produit:commission', 'credit', v_comm)));
    END IF;
    INSERT INTO app.audit_log (tenant_id, acteur, action, objet, details)
    VALUES (v_p.tenant_id, 'plateforme', CASE WHEN v_p.statut = 'EXPIRED' THEN 'paiement_succes_apres_expiration'
                                              ELSE 'paiement_confirme' END,
            'paiement:' || v_p.id, jsonb_build_object('origine', p_origine, 'voucher_id', v_voucher, 'commission', v_comm));
    PERFORM app._alerte_credits(v_p.tenant_id);
    RETURN 'SUCCEEDED';
  END IF;

  UPDATE app.payment SET statut = p_vers, maj_le = now(),
         reference_fournisseur = coalesce(p_reference_fournisseur, reference_fournisseur)
   WHERE id = v_p.id;
  RETURN p_vers;
END;
$$;

-- Événement de webhook reçu (corps brut conservé, §10.1). Rend true si NOUVEAU (P1 : un doublon
-- est enregistré une seule fois ; le traitement reste de toute façon idempotent).
CREATE FUNCTION app.paiement_evenement(p_fournisseur text, p_id_evenement text, p_tenant bigint,
                                       p_reference text, p_corps bytea)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO app.payment_event (fournisseur, id_evenement, tenant_id, payment_id, corps)
  VALUES (p_fournisseur, p_id_evenement, p_tenant,
          (SELECT id FROM app.payment WHERE reference = p_reference AND tenant_id = p_tenant), p_corps)
  ON CONFLICT (tenant_id, fournisseur, id_evenement) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

-- Le paiement appartient-il à ce propriétaire ? (un webhook ne touche que les paiements de SON compte)
CREATE FUNCTION app.paiement_du_proprietaire(p_reference text, p_tenant bigint)
RETURNS TABLE (statut text, montant bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$ SELECT p.statut, p.montant FROM app.payment p WHERE p.reference = p_reference AND p.tenant_id = p_tenant $$;

-- État d'un paiement pour le portail : le code du ticket n'est rendu qu'au porteur du jeton
-- d'appareil (ADR 0005 §1).
CREATE FUNCTION app.paiement_etat(p_public_id text, p_reference text, p_jeton bytea)
RETURNS TABLE (statut text, code text, expire_le timestamptz, montant bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  SELECT p.statut, CASE WHEN p.jeton_appareil = p_jeton THEN v.code END, p.expire_le, p.montant
    FROM app.payment p JOIN app.site s ON s.id = p.site_id LEFT JOIN app.voucher v ON v.id = p.voucher_id
   WHERE p.reference = p_reference AND s.public_id = p_public_id
$$;

REVOKE ALL ON FUNCTION app.credits_solde(bigint), app._vente_en_ligne(bigint), app.credits_recharger(bigint, bigint, text),
  app._alerte_credits(bigint), app.compte_marchand_enregistrer(text, bytea), app.compte_marchand_par_webhook(text, text),
  app.compte_marchand_du_proprietaire(bigint), app.portail_site(text), app.portail_forfaits(text),
  app.paiement_creer(text, bigint, text, text, bytea, text, bytea, text, text),
  app.paiement_transition(text, text, text, bigint, text, text),
  app.paiement_evenement(text, text, bigint, text, bytea), app.paiement_du_proprietaire(text, bigint),
  app.paiement_etat(text, text, bytea), app.site_hotes_depuis_inventaire(bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.credits_solde(bigint), app.compte_marchand_enregistrer(text, bytea),
  app.compte_marchand_par_webhook(text, text), app.compte_marchand_du_proprietaire(bigint), app.portail_site(text),
  app.portail_forfaits(text), app.paiement_creer(text, bigint, text, text, bytea, text, bytea, text, text),
  app.paiement_transition(text, text, text, bigint, text, text), app.paiement_evenement(text, text, bigint, text, bytea),
  app.paiement_du_proprietaire(text, bigint), app.paiement_etat(text, text, bytea),
  app.site_hotes_depuis_inventaire(bigint) TO wk_api;

-- Lecture des paiements par le propriétaire (RLS) ; aucune écriture directe (A5 : seules les
-- fonctions ci-dessus changent un statut).
GRANT SELECT (id, tenant_id, site_id, plan_id, montant, devise, operateur, fournisseur, reference, statut,
              numero_masque, voucher_id, cree_le, maj_le) ON app.payment TO wk_api;

RESET ROLE;
