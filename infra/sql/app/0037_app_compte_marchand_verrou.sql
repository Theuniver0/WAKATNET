-- WAKATNET — migration 0037 : audit de sécurité du paiement réel pawaPay (13/11/2026).
-- Ticket : docs/adr/0020-adaptateur-pawapay.md, section « Audit du 13/11/2026 : corrigé ».
--
--   1. Course entre app.compte_marchand_enregistrer (0035) et app.paiement_creer (0032), en READ COMMITTED : le
--      contrôle « paiements encore ouverts » ne voyait pas un paiement en cours de création (non validé). Ce paiement
--      aurait été débité sur l'ANCIEN compte, puis vérifié avec le NOUVEAU jeton (NOT_FOUND → FAILED) : encaissé sans
--      ticket. Désormais la ligne app.compte_marchand du propriétaire sérialise les deux :
--        - paiement_creer la prend FOR SHARE (plusieurs paiements à la fois restent possibles) ;
--        - compte_marchand_enregistrer la prend FOR UPDATE AVANT son contrôle, dans une instruction distincte : après
--          l'attente, le contrôle (nouvelle instruction, nouvel instantané) voit le paiement validé et refuse.
--      Ordre des verrous : paiement_creer prend ses verrous consultatifs puis la ligne du compte ; l'enregistrement ne
--      prend que la ligne du compte. Aucun interblocage possible entre les deux.
--   2. PUT /v1/compte-marchand : le contrôle des paiements ouverts (409) est fait AVANT l'appel au fournisseur, et les
--      vérifications chez le fournisseur (GET /v2/active-conf de pawaPay) sont limitées à 5 par heure et par
--      propriétaire, en base comme les autres limites du dépôt (relecture : un propriétaire ne doit pas faire appeler
--      le fournisseur en boucle avec de faux jetons).
--   3. Référence du fournisseur notée AVANT charge() quand elle est déterministe (pawaPay : depositId dérivé de notre
--      référence). Un callback sans clientReferenceId, arrivé après un charge() resté sans réponse (paiement CREATED),
--      retrouve ainsi son paiement par app.paiement_par_reference_fournisseur (0035).
--
-- Les migrations précédentes sont immuables : les fonctions sont reprises de leur dernière version (0032 pour
-- paiement_creer, 0035 pour compte_marchand_enregistrer), mêmes signatures, SECURITY DEFINER et search_path.

SET ROLE wakatnet_owner;

-- ------------------------------------------------------------------ 1. verrou du compte marchand

CREATE OR REPLACE FUNCTION app.compte_marchand_enregistrer(p_fournisseur text, p_cles bytea)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_tenant bigint := app.tenant_courant();
  v_webhook text;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'compte marchand sans propriétaire (contexte RLS absent)'; END IF;
  -- 0037 : verrou de la ligne AVANT le contrôle. Un paiement_creer en cours (FOR SHARE) est attendu ; le contrôle
  -- ci-dessous, instruction suivante, le voit alors validé. Un paiement_creer qui arrive après attend notre fin.
  PERFORM 1 FROM app.compte_marchand m WHERE m.tenant_id = v_tenant FOR UPDATE;
  IF EXISTS (SELECT 1 FROM app.compte_marchand m WHERE m.tenant_id = v_tenant)
     AND EXISTS (SELECT 1 FROM app.payment p WHERE p.tenant_id = v_tenant
                  AND p.statut IN ('CREATED', 'PENDING', 'EXPIRED', 'FAILED') AND p.verifier_jusqu_au > now()) THEN
    RAISE EXCEPTION 'changement de compte marchand impossible : paiements encore ouverts' USING ERRCODE = 'object_in_use';
  END IF;
  INSERT INTO app.compte_marchand (tenant_id, fournisseur, cles) VALUES (v_tenant, p_fournisseur, p_cles)
  ON CONFLICT (tenant_id) DO UPDATE SET fournisseur = EXCLUDED.fournisseur, cles = EXCLUDED.cles, maj_le = now()
  RETURNING webhook_id INTO v_webhook;
  INSERT INTO app.audit_log (tenant_id, acteur, action, objet, details)
  VALUES (v_tenant, 'tenant:' || v_tenant, 'compte_marchand_enregistre', 'compte_marchand', jsonb_build_object('fournisseur', p_fournisseur));
  RETURN v_webhook;
END;
$$;
REVOKE ALL ON FUNCTION app.compte_marchand_enregistrer(text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.compte_marchand_enregistrer(text, bytea) TO wk_api;

CREATE OR REPLACE FUNCTION app.paiement_creer(p_public_id text, p_plan bigint, p_operateur text, p_numero_clair text,
                                              p_numero_hmac bytea, p_numero_masque text, p_jeton bytea, p_soumission text,
                                              p_reference text, p_source text, p_ip inet DEFAULT NULL)
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
  v_routeur boolean;
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
  -- Limites de demandes (0022) ; garde du site par source (0031, M7) ; budget propre aux routeurs du site (0032).
  -- Le verrou du site sérialise les comptes de la garde.
  PERFORM pg_advisory_xact_lock(hashtext('paiement:' || v_site.id || ':' || encode(p_numero_hmac, 'hex')));
  PERFORM pg_advisory_xact_lock(hashtext('paiement:jeton:' || encode(p_jeton, 'hex')));
  PERFORM pg_advisory_xact_lock(hashtext('paiement:site:' || v_site.id));
  v_routeur := app._depuis_routeur(v_site.id, p_ip);
  IF (SELECT count(*) FROM app.payment p WHERE p.site_id = v_site.id AND p.numero_hmac = p_numero_hmac
         AND p.cree_le > now() - interval '10 minutes') >= 3
     OR (SELECT count(*) FROM app.payment p WHERE p.jeton_appareil = p_jeton AND p.cree_le > now() - interval '10 minutes') >= 5
     OR (v_routeur AND (SELECT count(*) FROM app.paiement_demande d WHERE d.site_id = v_site.id AND d.routeur
           AND d.le > now() - interval '1 minute') >= 30)
     OR (NOT v_routeur AND ((SELECT count(*) FROM app.paiement_demande d WHERE d.site_id = v_site.id AND NOT d.routeur
           AND d.source = v_source AND d.le > now() - interval '1 minute') >= 30
        OR (SELECT count(*) FROM app.paiement_demande d WHERE d.site_id = v_site.id AND NOT d.routeur
           AND d.le > now() - interval '1 minute') >= 100)) THEN
    RETURN QUERY SELECT 'trop_de_demandes'::text, NULL::bigint, NULL::text, NULL::bigint, NULL::bigint, NULL::text, NULL::text; RETURN;
  END IF;
  SELECT * INTO v_plan FROM app.plan p
   WHERE p.id = p_plan AND p.tenant_id = v_site.tenant_id AND p.prix_xof > 0 AND (p.scope = 'tenant' OR p.site_id = v_site.id);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'forfait_inconnu'::text, NULL::bigint, NULL::text, NULL::bigint, NULL::bigint, NULL::text, NULL::text; RETURN;
  END IF;
  -- 0037 : ligne du compte marchand verrouillée en partage jusqu'à la validation du paiement. Un changement de compte
  -- en cours est attendu (le paiement est alors créé sur le NOUVEAU compte, lu par les instructions suivantes) ; un
  -- changement qui arrive après attend que ce paiement soit validé, le voit ouvert et est refusé.
  PERFORM 1 FROM app.compte_marchand m WHERE m.tenant_id = v_site.tenant_id FOR SHARE;
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
  INSERT INTO app.paiement_demande (site_id, source, routeur) VALUES (v_site.id, v_source, v_routeur);
  DELETE FROM app.paiement_demande WHERE le < now() - interval '1 hour';
  RETURN QUERY SELECT 'cree'::text, v_p.id, v_p.reference, v_p.montant, v_p.tenant_id, v_p.fournisseur, v_p.statut;
END;
$$;
REVOKE ALL ON FUNCTION app.paiement_creer(text, bigint, text, text, bytea, text, bytea, text, text, text, inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.paiement_creer(text, bigint, text, text, bytea, text, bytea, text, text, text, inet) TO wk_api;

-- ------------------------------------------------------------------ 2. avant la vérification chez le fournisseur

-- Vérifications de compte demandées au fournisseur, par propriétaire (fenêtre glissante d'une heure).
CREATE TABLE app.compte_marchand_verification (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES app.tenant (id) ON DELETE CASCADE,
  le        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX compte_marchand_verification_tenant ON app.compte_marchand_verification (tenant_id, le);
ALTER TABLE app.compte_marchand_verification ENABLE ROW LEVEL SECURITY;   -- aucune politique : fonctions seulement

-- Contrôles faits AVANT d'appeler le fournisseur (PUT /v1/compte-marchand), pour le propriétaire du contexte RLS :
--   'paiements_ouverts'     : un compte existe et des paiements sont encore vérifiables (le 409 de l'enregistrement) ;
--   'trop_de_verifications' : 5 vérifications déjà demandées dans l'heure (p_verification seulement) ;
--   'ok'                    : la vérification est comptée (même si elle échoue ensuite chez le fournisseur).
-- compte_marchand_enregistrer refait le contrôle des paiements sous verrou : celui-ci n'évite que l'appel inutile.
CREATE FUNCTION app.compte_marchand_avant_verification(p_verification boolean)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_tenant bigint := app.tenant_courant();
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'compte marchand sans propriétaire (contexte RLS absent)'; END IF;
  IF EXISTS (SELECT 1 FROM app.compte_marchand m WHERE m.tenant_id = v_tenant)
     AND EXISTS (SELECT 1 FROM app.payment p WHERE p.tenant_id = v_tenant
                  AND p.statut IN ('CREATED', 'PENDING', 'EXPIRED', 'FAILED') AND p.verifier_jusqu_au > now()) THEN
    RETURN 'paiements_ouverts';
  END IF;
  IF NOT coalesce(p_verification, true) THEN RETURN 'ok'; END IF;
  -- Le verrou sérialise le compte : des requêtes parallèles ne dépassent pas la limite.
  PERFORM pg_advisory_xact_lock(hashtext('compte_marchand:verification:' || v_tenant));
  IF (SELECT count(*) FROM app.compte_marchand_verification v
       WHERE v.tenant_id = v_tenant AND v.le > now() - interval '1 hour') >= 5 THEN
    RETURN 'trop_de_verifications';
  END IF;
  INSERT INTO app.compte_marchand_verification (tenant_id) VALUES (v_tenant);
  DELETE FROM app.compte_marchand_verification v WHERE v.tenant_id = v_tenant AND v.le < now() - interval '1 hour';
  RETURN 'ok';
END;
$$;
REVOKE ALL ON FUNCTION app.compte_marchand_avant_verification(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.compte_marchand_avant_verification(boolean) TO wk_api;

-- ------------------------------------------------------------------ 3. référence du fournisseur notée avant charge()

-- Note la référence du fournisseur d'un paiement encore CREATED, si elle est vide (ou déjà la même : rejouable).
-- Refus (exception) sinon : le service n'appelle alors pas charge(), aucun argent ne bouge.
CREATE FUNCTION app.paiement_reference_fournisseur_noter(p_reference text, p_reference_fournisseur text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
BEGIN
  IF p_reference_fournisseur IS NULL OR length(p_reference_fournisseur) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'référence du fournisseur invalide';
  END IF;
  UPDATE app.payment p SET reference_fournisseur = p_reference_fournisseur, maj_le = now()
   WHERE p.reference = p_reference AND p.statut = 'CREATED'
     AND (p.reference_fournisseur IS NULL OR p.reference_fournisseur = p_reference_fournisseur);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'référence du fournisseur non notée : paiement inconnu, déjà engagé ou déjà référencé autrement';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.paiement_reference_fournisseur_noter(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.paiement_reference_fournisseur_noter(text, text) TO wk_api;

RESET ROLE;
