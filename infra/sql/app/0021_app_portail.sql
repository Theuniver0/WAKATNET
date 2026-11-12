-- WAKATNET — migration 0021 : portail captif, retour sur un achat (phase 3, ticket 06).
-- Ticket : .scratch/phase-3-portail-paiement/issues/06-portail.md
-- Contrats : ADR 0005 §1 (jeton d'appareil, repli numéro + référence, jamais la MAC seule,
-- tentatives limitées et journalisées) ; ADR 0013 §9.

SET ROLE wakatnet_owner;

-- Tentatives de récupération : limitées par numéro (HMAC), par appareil et par site.
CREATE TABLE app.recuperation_tentative (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id     bigint NOT NULL REFERENCES app.site (id),
  numero_hmac bytea  NOT NULL,
  jeton       bytea  NOT NULL,
  reussie     boolean NOT NULL,
  le          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recuperation_numero ON app.recuperation_tentative (site_id, numero_hmac, le);
CREATE INDEX recuperation_jeton ON app.recuperation_tentative (jeton, le);
ALTER TABLE app.recuperation_tentative ENABLE ROW LEVEL SECURITY;

-- P6 par le jeton d'appareil : le dernier achat de cet appareil sur ce site, dans les 24 h.
CREATE FUNCTION app.paiement_par_jeton(p_public_id text, p_jeton bytea)
RETURNS TABLE (reference text, statut text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  SELECT p.reference, p.statut FROM app.payment p JOIN app.site s ON s.id = p.site_id
   WHERE s.public_id = p_public_id AND p.jeton_appareil = p_jeton AND p.cree_le > now() - interval '24 hours'
   ORDER BY p.id DESC LIMIT 1
$$;

-- Repli : numéro du payeur + 4 derniers caractères de la référence de l'opérateur (ADR 0005 §1).
-- 5 tentatives par numéro et par site, et 10 par appareil, sur 15 min ; toutes journalisées.
-- En cas de succès, le paiement est rattaché au NOUVEL appareil (son jeton), qui voit alors le code.
--   statut : 'trouve' | 'introuvable' | 'trop_de_tentatives' | 'site_inconnu'
CREATE FUNCTION app.paiement_retrouver(p_public_id text, p_numero_hmac bytea, p_suffixe text, p_jeton bytea)
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
          WHERE t.jeton = p_jeton AND t.le > now() - interval '15 minutes') >= 10 THEN
    INSERT INTO app.audit_log (tenant_id, acteur, action, objet)
    SELECT s.tenant_id, 'portail', 'recuperation_bloquee', 'site:' || s.id FROM app.site s WHERE s.id = v_site;
    RETURN QUERY SELECT 'trop_de_tentatives'::text, NULL::text; RETURN;
  END IF;
  SELECT p.reference INTO v_ref FROM app.payment p
   WHERE p.site_id = v_site AND p.numero_hmac = p_numero_hmac
     AND p.statut IN ('CREATED', 'PENDING', 'EXPIRED', 'SUCCEEDED')
     AND p.reference_fournisseur IS NOT NULL AND length(p_suffixe) = 4
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

REVOKE ALL ON FUNCTION app.paiement_par_jeton(text, bytea), app.paiement_retrouver(text, bytea, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.paiement_par_jeton(text, bytea), app.paiement_retrouver(text, bytea, text, bytea) TO wk_api;

RESET ROLE;
