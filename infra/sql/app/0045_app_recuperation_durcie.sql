-- WAKATNET — migration 0045 : « J'ai payé mais je n'ai pas mon ticket » durci (scan de sécurité du 13/11/2026, F5 et F6).
--   1. Le suffixe de 4 caractères était comparé à la référence du FOURNISSEUR, que le client ne reçoit pas (pawaPay :
--      depositId hexadécimal, 65 536 valeurs ; ADR 0020). L'ADR 0013 prévoyait la référence de l'OPÉRATEUR, reçue par
--      SMS. Pour pawaPay et CinetPay, la récupération est donc refusée tant que cette référence n'est pas enregistrée
--      (liste blanche : le seul simulateur aujourd'hui).
--   2. La limite par appareil se contournait sans cookie : un plafond dur de 10 échecs par (site, numéro) sur 24 h
--      s'ajoute, quel que soit l'appareil (les tentatives sont purgées à 24 h, ADR 0005).
SET ROLE wakatnet_owner;

CREATE OR REPLACE FUNCTION app.paiement_retrouver(p_public_id text, p_numero_hmac bytea, p_suffixe text, p_jeton bytea)
RETURNS TABLE (statut text, reference text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_site bigint;
  v_ref  text;
BEGIN
  SELECT id INTO v_site FROM app.site WHERE public_id = p_public_id;
  IF NOT FOUND THEN RETURN QUERY SELECT 'site_inconnu'::text, NULL::text; RETURN; END IF;
  -- Sérialise les tentatives d'un même numéro sur un même site, et d'un même appareil : sans ce
  -- verrou, des requêtes PARALLÈLES compteraient chacune moins de 5 tentatives (relecture argent, B1).
  PERFORM pg_advisory_xact_lock(hashtext('recuperation:' || v_site || ':' || encode(p_numero_hmac, 'hex')));
  PERFORM pg_advisory_xact_lock(hashtext('recuperation:jeton:' || encode(p_jeton, 'hex')));
  IF (SELECT count(*) FROM app.recuperation_tentative t
       WHERE t.site_id = v_site AND t.numero_hmac = p_numero_hmac AND t.le > now() - interval '15 minutes') >= 5
     OR (SELECT count(*) FROM app.recuperation_tentative t
          WHERE t.jeton = p_jeton AND t.le > now() - interval '15 minutes') >= 10
     -- F5/F6 : plafond DUR sur 24 h par (site, numéro), quel que soit l'appareil (le jeton d'appareil est tiré par le
     -- client, sans cookie il change à chaque requête) : une devinette du suffixe n'accumule plus d'essais.
     OR (SELECT count(*) FROM app.recuperation_tentative t
          WHERE t.site_id = v_site AND t.numero_hmac = p_numero_hmac AND NOT t.reussie
            AND t.le > now() - interval '24 hours') >= 10 THEN
    INSERT INTO app.audit_log (tenant_id, acteur, action, objet)
    SELECT s.tenant_id, 'portail', 'recuperation_bloquee', 'site:' || s.id FROM app.site s WHERE s.id = v_site;
    RETURN QUERY SELECT 'trop_de_tentatives'::text, NULL::text; RETURN;
  END IF;
  SELECT p.reference INTO v_ref FROM app.payment p
   WHERE p.site_id = v_site AND p.numero_hmac = p_numero_hmac
     AND p.statut IN ('CREATED', 'PENDING', 'EXPIRED', 'SUCCEEDED')
     AND p.reference_fournisseur IS NOT NULL AND length(p_suffixe) = 4
     -- F5/F6 : seulement pour un fournisseur dont la référence comparée est celle que le CLIENT reçoit. LISTE BLANCHE
     -- (un fournisseur ajouté plus tard n'y entre pas d'office) : aujourd'hui le seul simulateur. pawaPay (depositId,
     -- ADR 0020) et CinetPay (transaction_id) en sont exclus : le suffixe n'y serait qu'un secret à deviner. En
     -- production, la récupération répond donc « introuvable » tant que la référence de l'opérateur (SMS, ADR 0013)
     -- n'est pas enregistrée par les adaptateurs (décision de Yacouba).
     AND p.fournisseur = 'mock'
     AND upper(right(p.reference_fournisseur, 4)) = upper(p_suffixe)
     AND p.cree_le > now() - interval '7 days'
   ORDER BY p.id DESC LIMIT 1;
  INSERT INTO app.recuperation_tentative (site_id, numero_hmac, jeton, reussie) VALUES (v_site, p_numero_hmac, p_jeton, v_ref IS NOT NULL);
  IF v_ref IS NULL THEN RETURN QUERY SELECT 'introuvable'::text, NULL::text; RETURN; END IF;
  UPDATE app.payment SET jeton_appareil = p_jeton, maj_le = now() WHERE reference = v_ref;
  INSERT INTO app.audit_log (tenant_id, acteur, action, objet)
  SELECT p.tenant_id, 'portail', 'paiement_retrouve', 'paiement:' || p.id FROM app.payment p WHERE p.reference = v_ref;
  RETURN QUERY SELECT 'trouve'::text, v_ref;
END;
$$;

RESET ROLE;
