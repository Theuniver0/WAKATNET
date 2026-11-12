-- WAKATNET — migration 0035 : relecture de l'adaptateur pawaPay (ADR 0020, règle 4).
-- Ticket : docs/adr/0020-adaptateur-pawapay.md.
--
--   1. Changer les clés du compte marchand (autre compte pawaPay, bac à sable → production…) avec des paiements encore
--      ouverts les rendrait invérifiables : verify() interrogerait un compte qui ne les connaît pas (NOT_FOUND → échec),
--      et des dépôts encaissés resteraient sans ticket. 0019 ne bloquait que le changement de FOURNISSEUR ; désormais,
--      tout changement est refusé tant qu'un paiement est encore vérifiable.
--   2. Un callback qui ne porterait pas notre référence est rattaché par l'identifiant du fournisseur (depositId).

SET ROLE wakatnet_owner;

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

CREATE INDEX payment_reference_fournisseur ON app.payment (tenant_id, reference_fournisseur) WHERE reference_fournisseur IS NOT NULL;

-- Notre référence, à partir de l'identifiant du fournisseur, pour CE propriétaire et CE fournisseur.
CREATE FUNCTION app.paiement_par_reference_fournisseur(p_tenant bigint, p_fournisseur text, p_reference_fournisseur text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  SELECT p.reference FROM app.payment p
   WHERE p.tenant_id = p_tenant AND p.fournisseur = p_fournisseur AND p.reference_fournisseur = p_reference_fournisseur
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.paiement_par_reference_fournisseur(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.paiement_par_reference_fournisseur(bigint, text, text) TO wk_api;

RESET ROLE;
