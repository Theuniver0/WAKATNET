-- WAKATNET — migration 0020 : tâche périodique (rapprochement, expiration, frais papier).
-- Ticket : .scratch/phase-3-portail-paiement/issues/05-rapprochement.md
-- Contrats : ADR 0013 §6 ; SPEC §7.2 (webhook tardif ou perdu, succès après EXPIRED) ; ADR 0002.

SET ROLE wakatnet_owner;

-- Paiements dont le verdict doit être demandé au fournisseur (verify fait foi) : créés depuis plus
-- de 2 min, puis toutes les 5 min, pendant 24 h ; EXPIRED (P7) et FAILED compris : un refus lu
-- dans la réponse de charge() peut être démenti par verify(), qui fait foi.
CREATE FUNCTION app.paiements_a_verifier(p_limite integer DEFAULT 200)
RETURNS TABLE (reference text, tenant_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  SELECT p.reference, p.tenant_id FROM app.payment p
   WHERE p.statut IN ('CREATED', 'PENDING', 'EXPIRED', 'FAILED')
     AND p.prochaine_verif_le <= now() AND p.verifier_jusqu_au > now()
   ORDER BY p.prochaine_verif_le
   LIMIT greatest(1, least(p_limite, 1000))
$$;

-- Prochaine vérification dans 5 min (après une tentative, réussie ou non).
CREATE FUNCTION app.paiement_replanifier(p_reference text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$ UPDATE app.payment SET prochaine_verif_le = now() + interval '5 minutes' WHERE reference = p_reference $$;

-- Délai du portail dépassé : CREATED ou PENDING → EXPIRED (le rapprochement continue, P7).
CREATE FUNCTION app.paiements_expirer()
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_ref text;
  v_n   integer := 0;
BEGIN
  FOR v_ref IN SELECT reference FROM app.payment WHERE statut IN ('CREATED', 'PENDING') AND expire_le < now() ORDER BY id LOOP
    IF app.paiement_transition(v_ref, 'EXPIRED', NULL, NULL, NULL, 'expiration') = 'EXPIRED' THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;

-- Frais sur les tickets papier activés (ADR 0002) : tout ticket ACTIVÉ qui n'est lié à aucun
-- paiement en ligne, sans transaction « frais_papier:voucher:ID ». Taux et plancher du
-- propriétaire figés dans l'écriture. Idempotent par la clé du grand livre ; hors du chemin
-- d'authentification (le solde n'est jamais lu par radius.authorize).
CREATE FUNCTION app.frais_papier_prelever(p_limite integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, ledger, pg_temp
AS $$
DECLARE
  r   record;
  v_n integer := 0;
  v_f bigint;
BEGIN
  FOR r IN
    SELECT v.id, v.tenant_id, v.f_prix_xof, t.offline_fee_bps, t.offline_fee_min
      FROM app.voucher v JOIN app.tenant t ON t.id = v.tenant_id
     WHERE v.activated_at IS NOT NULL
       -- Jamais rétroactif : seuls les tickets activés après la mise en service des frais (I3).
       AND v.activated_at >= t.frais_papier_depuis
       -- Un frais nul n'écrit rien : il ne doit pas rester candidat à chaque tour (I2, famine).
       AND ledger.commission(v.f_prix_xof, t.offline_fee_bps, t.offline_fee_min) > 0
       AND NOT EXISTS (SELECT 1 FROM app.payment p WHERE p.voucher_id = v.id)
       AND NOT EXISTS (SELECT 1 FROM ledger.transaction x WHERE x.cle = 'frais_papier:voucher:' || v.id)
     ORDER BY v.id
     LIMIT greatest(1, least(p_limite, 5000))
  LOOP
    v_f := ledger.commission(r.f_prix_xof, r.offline_fee_bps, r.offline_fee_min);
    IF v_f > 0 THEN
      PERFORM ledger.ecrire('frais_papier:voucher:' || r.id, 'frais_papier', 'voucher:' || r.id,
        r.offline_fee_bps, r.offline_fee_min,
        jsonb_build_array(jsonb_build_object('compte', 'proprietaire:' || r.tenant_id || ':credits', 'debit', v_f),
                          jsonb_build_object('compte', 'plateforme:produit:frais_papier', 'credit', v_f)));
      PERFORM app._alerte_credits(r.tenant_id);
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;

-- Numéro du payeur en clair : effacé à sa date de purge (6 mois) ; le HMAC et la forme masquée
-- restent (ADR 0005 §2).
CREATE FUNCTION app.numeros_purger()
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  WITH p AS (UPDATE app.payment SET numero_clair = NULL
              WHERE numero_clair IS NOT NULL AND purge_numero_le < now() RETURNING 1)
  SELECT count(*)::integer FROM p
$$;

REVOKE ALL ON FUNCTION app.paiements_a_verifier(integer), app.paiement_replanifier(text), app.paiements_expirer(),
  app.frais_papier_prelever(integer), app.numeros_purger() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.paiements_a_verifier(integer), app.paiement_replanifier(text), app.paiements_expirer(),
  app.frais_papier_prelever(integer), app.numeros_purger() TO wk_api;

RESET ROLE;
