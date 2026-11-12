-- WAKATNET — migration 0031 : limites comptées par source (revue de sécurité M2 et M7, docs/REVUE_SECURITE.md).
-- Ticket : docs/REVUE_SECURITE.md (M2, M7) ; ADR 0016 §2 (req.ip = adresse vue par nginx, trustProxy).
-- Relue par un second agent (règle 4) ; ses constats sont repris ci-dessous.
--
-- Source : HMAC (clé WAKATNET_CLE_HMAC, renouvelée chaque jour UTC) de l'IPv4, ou du /64 d'une IPv6
-- (apps/api/src/cle-ip.ts). L'IP n'est jamais gardée en clair, et deux jours ne se relient pas.
--
-- M7 : la garde de 30 paiements par minute comptait PAR SITE : n'importe qui bloquait la vente en ligne d'un
--      concurrent. Elle compte désormais par (site, source) : les clients d'un hotspot sortent par l'IP WAN du
--      routeur, qui garde son budget. Un plafond global de 100 par minute et par site reste, contre l'envoi
--      massif de demandes (push) : bloquer un site exige 4 sources au lieu d'une. RESTE : seul le budget propre
--      de l'IP du routeur (point de terminaison WireGuard, vu par wg-agent) fermerait M7.
-- M2 : le verrou des connexions comptait PAR ADRESSE E-MAIL : quiconque la connaissait tenait le compte bloqué.
--      Désormais : 5 essais en 15 min par (adresse, source), 10 par adresse toutes sources inconnues confondues.
--      Un APPAREIL CONNU (cookie posé à une connexion réussie, 90 jours) a son propre budget de 5 et échappe au
--      plafond global : le titulaire se connecte même pendant une attaque distribuée (recommandation OWASP).

SET ROLE wakatnet_owner;

ALTER TABLE app.connexion_echec ADD COLUMN source text NOT NULL DEFAULT '?';
CREATE INDEX connexion_echec_email_source ON app.connexion_echec (email, source, le);
CREATE INDEX connexion_echec_le ON app.connexion_echec (le);          -- purge

-- Appareils connus : empreinte (SHA-256) du jeton du cookie, jamais le jeton.
CREATE TABLE app.appareil_connu (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text  NOT NULL,
  empreinte  bytea NOT NULL CHECK (length(empreinte) = 32),
  le         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email, empreinte)
);
CREATE INDEX appareil_connu_le ON app.appareil_connu (le);
ALTER TABLE app.appareil_connu ENABLE ROW LEVEL SECURITY;        -- aucune politique : fonctions seulement

CREATE TABLE app.paiement_demande (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id bigint NOT NULL,
  source  text   NOT NULL,
  le      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX paiement_demande_site ON app.paiement_demande (site_id, le);
CREATE INDEX paiement_demande_source ON app.paiement_demande (site_id, source, le);
CREATE INDEX paiement_demande_le ON app.paiement_demande (le);    -- purge
ALTER TABLE app.paiement_demande ENABLE ROW LEVEL SECURITY;      -- aucune politique : fonctions seulement

DROP FUNCTION app.connexion_reserver(text);
CREATE FUNCTION app.connexion_reserver(p_email text, p_source text, p_appareil bytea)
RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_email  text := lower(left(p_email, 254));
  v_source text := left(coalesce(nullif(p_source, ''), '?'), 64);
  v_connu  boolean;
  v_id bigint;
BEGIN
  -- Un seul verrou par adresse : tous les comptes de cette adresse sont lus et écrits sous lui.
  PERFORM pg_advisory_xact_lock(hashtext('wakatnet_connexion:' || v_email));
  v_connu := p_appareil IS NOT NULL AND EXISTS (SELECT 1 FROM app.appareil_connu a WHERE a.email = v_email
               AND a.empreinte = p_appareil AND a.le > now() - interval '90 days');
  IF v_connu THEN
    v_source := 'appareil:' || encode(p_appareil, 'hex');
  END IF;
  IF (SELECT count(*) FROM app.connexion_echec e WHERE e.email = v_email AND e.source = v_source
        AND e.le > now() - interval '15 minutes') >= 5
     OR (NOT v_connu AND (SELECT count(*) FROM app.connexion_echec e WHERE e.email = v_email AND e.source NOT LIKE 'appareil:%'
           AND e.le > now() - interval '15 minutes') >= 10) THEN
    RETURN NULL;
  END IF;
  INSERT INTO app.connexion_echec (email, source) VALUES (v_email, v_source) RETURNING id INTO v_id;
  DELETE FROM app.connexion_echec WHERE le < now() - interval '1 day';
  RETURN v_id;
END;
$$;

-- Essai réussi : la réservation est effacée, et l'appareil devient (ou reste) connu pour 90 jours.
-- 20 appareils au plus par adresse : les plus anciens sortent.
DROP FUNCTION app.connexion_reussie(bigint);
CREATE FUNCTION app.connexion_reussie(p_essai bigint, p_appareil bytea)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_email text;
BEGIN
  DELETE FROM app.connexion_echec WHERE id = p_essai RETURNING email INTO v_email;
  IF v_email IS NULL OR p_appareil IS NULL THEN RETURN; END IF;
  INSERT INTO app.appareil_connu (email, empreinte) VALUES (v_email, p_appareil)
  ON CONFLICT (email, empreinte) DO UPDATE SET le = now();
  DELETE FROM app.appareil_connu a WHERE a.email = v_email AND a.id NOT IN
    (SELECT b.id FROM app.appareil_connu b WHERE b.email = v_email ORDER BY b.le DESC LIMIT 20);
  DELETE FROM app.appareil_connu WHERE le < now() - interval '90 days';
END;
$$;

DROP FUNCTION app.paiement_creer(text, bigint, text, text, bytea, text, bytea, text, text);
CREATE FUNCTION app.paiement_creer(p_public_id text, p_plan bigint, p_operateur text, p_numero_clair text,
                                   p_numero_hmac bytea, p_numero_masque text, p_jeton bytea, p_soumission text,
                                   p_reference text, p_source text)
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
  v_source text := left(coalesce(nullif(p_source, ''), '?'), 64);
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
  -- Limites de demandes (0022), la garde du site comptée par source (M7). Le verrou du site sérialise les
  -- deux comptes de la garde.
  PERFORM pg_advisory_xact_lock(hashtext('paiement:' || v_site.id || ':' || encode(p_numero_hmac, 'hex')));
  PERFORM pg_advisory_xact_lock(hashtext('paiement:jeton:' || encode(p_jeton, 'hex')));
  PERFORM pg_advisory_xact_lock(hashtext('paiement:site:' || v_site.id));
  IF (SELECT count(*) FROM app.payment p WHERE p.site_id = v_site.id AND p.numero_hmac = p_numero_hmac
         AND p.cree_le > now() - interval '10 minutes') >= 3
     OR (SELECT count(*) FROM app.payment p WHERE p.jeton_appareil = p_jeton AND p.cree_le > now() - interval '10 minutes') >= 5
     OR (SELECT count(*) FROM app.paiement_demande d WHERE d.site_id = v_site.id AND d.source = v_source
           AND d.le > now() - interval '1 minute') >= 30
     OR (SELECT count(*) FROM app.paiement_demande d WHERE d.site_id = v_site.id AND d.le > now() - interval '1 minute') >= 100 THEN
    RETURN QUERY SELECT 'trop_de_demandes'::text, NULL::bigint, NULL::text, NULL::bigint, NULL::bigint, NULL::text, NULL::text; RETURN;
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
                           verifier_jusqu_au, prochaine_verif_le, detail)
  SELECT v_site.tenant_id, v_site.id, v_plan.id, v_plan.prix_xof, p_operateur, m.fournisseur, p_reference, p_numero_clair,
         p_numero_hmac, p_numero_masque, now() + interval '6 months', p_jeton, p_soumission, now() + interval '3 minutes',
         now() + interval '24 hours', now() + interval '2 minutes',
         -- Forfait FIGÉ à l'achat : le ticket créé à la confirmation (jusqu'à 24 h plus tard) donne
         -- exactement ce qui a été payé, même si le propriétaire modifie le forfait entre-temps.
         jsonb_build_object('forfait', to_jsonb(v_plan))
    FROM app.compte_marchand m WHERE m.tenant_id = v_site.tenant_id
  ON CONFLICT (tenant_id, soumission) DO NOTHING
  RETURNING * INTO v_p;
  IF v_p.id IS NULL THEN   -- course entre deux soumissions identiques : la première a gagné
    SELECT * INTO STRICT v_p FROM app.payment p WHERE p.tenant_id = v_site.tenant_id AND p.soumission = p_soumission;
    RETURN QUERY SELECT 'deja'::text, v_p.id, v_p.reference, v_p.montant, v_p.tenant_id, v_p.fournisseur, v_p.statut; RETURN;
  END IF;
  INSERT INTO app.paiement_demande (site_id, source) VALUES (v_site.id, v_source);
  DELETE FROM app.paiement_demande WHERE le < now() - interval '1 hour';
  RETURN QUERY SELECT 'cree'::text, v_p.id, v_p.reference, v_p.montant, v_p.tenant_id, v_p.fournisseur, v_p.statut;
END;
$$;

-- connexion_echouee (0023) n'est plus appelée depuis 0030 : retirée.
DROP FUNCTION app.connexion_echouee(text);

REVOKE ALL ON FUNCTION app.connexion_reserver(text, text, bytea), app.connexion_reussie(bigint, bytea),
  app.paiement_creer(text, bigint, text, text, bytea, text, bytea, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.connexion_reserver(text, text, bytea), app.connexion_reussie(bigint, bytea),
  app.paiement_creer(text, bigint, text, text, bytea, text, bytea, text, text, text) TO wk_api;

RESET ROLE;
