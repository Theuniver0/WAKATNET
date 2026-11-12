-- WAKATNET — migration 0022 : corrections de la revue de fin de phase 3 (trois relectures).
-- Tickets : .scratch/phase-3-portail-paiement/issues/03-paiements-mock.md, 04-confirmation-credits.md,
--           05-rapprochement.md, 06-portail.md
-- Les migrations 0019 à 0021 sont fusionnées, donc immuables (ADR 0008) : les fonctions sont
-- redéfinies ici (CREATE OR REPLACE garde leurs droits).

SET ROLE wakatnet_owner;

-- ---------------------------------------------------------------------------
-- Création d'un paiement : limites de demandes et forfait figé à l'achat.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.paiement_creer(p_public_id text, p_plan bigint, p_operateur text, p_numero_clair text,
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
  -- Limites de demandes (revue de fin de phase 3) : sans elles, n'importe qui déclencherait sans
  -- fin des demandes de paiement (push Moov) vers n'importe quel numéro. Sérialisées par un verrou
  -- consultatif, comme la récupération (0021).
  PERFORM pg_advisory_xact_lock(hashtext('paiement:' || v_site.id || ':' || encode(p_numero_hmac, 'hex')));
  PERFORM pg_advisory_xact_lock(hashtext('paiement:jeton:' || encode(p_jeton, 'hex')));
  IF (SELECT count(*) FROM app.payment p WHERE p.site_id = v_site.id AND p.numero_hmac = p_numero_hmac
         AND p.cree_le > now() - interval '10 minutes') >= 3
     OR (SELECT count(*) FROM app.payment p WHERE p.jeton_appareil = p_jeton AND p.cree_le > now() - interval '10 minutes') >= 5
     OR (SELECT count(*) FROM app.payment p WHERE p.site_id = v_site.id AND p.cree_le > now() - interval '1 minute') >= 30 THEN
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
  RETURN QUERY SELECT 'cree'::text, v_p.id, v_p.reference, v_p.montant, v_p.tenant_id, v_p.fournisseur, v_p.statut;
END;
$$;

-- ---------------------------------------------------------------------------
-- Transition : ticket depuis le forfait figé ; référence du fournisseur bornée (une valeur trop
-- longue ne doit pas faire échouer la confirmation).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.paiement_transition(p_reference text, p_vers text, p_reference_fournisseur text,
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
  v_essai   integer;
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
           reference_fournisseur = coalesce(left(p_reference_fournisseur, 128), reference_fournisseur),
           detail = detail || jsonb_build_object('mismatch', jsonb_build_object('montant', p_montant, 'devise', p_devise))
     WHERE id = v_p.id;
    INSERT INTO app.audit_log (tenant_id, acteur, action, objet, details)
    VALUES (v_p.tenant_id, 'plateforme', 'alerte_paiement_mismatch', 'paiement:' || v_p.id,
            jsonb_build_object('attendu', v_p.montant, 'recu', p_montant, 'devise', p_devise, 'origine', p_origine));
    RETURN 'MISMATCH';
  END IF;

  IF p_vers = 'SUCCEEDED' THEN
    SELECT * INTO STRICT v_t FROM app.tenant t WHERE t.id = v_p.tenant_id;
    -- Ticket depuis le forfait FIGÉ à l'achat (0022) ; même générateur que app.voucher_creer.
    -- Un paiement sans copie (créé avant 0022) prend le forfait courant, comme avant.
    IF v_p.detail ? 'forfait' THEN
      v_code := NULL;
      FOR v_essai IN 1 .. 5 LOOP
        BEGIN
          v_code := app.generer_code(8);
          INSERT INTO app.voucher (tenant_id, plan_id, code, f_prix_xof, f_uptime_limit_s, f_validity_s, f_data_limit_bytes,
                                   f_rate_limit, f_devices, f_bind_mac, f_scope, f_site_id)
          VALUES (v_p.tenant_id, v_p.plan_id, v_code, (v_p.detail #>> '{forfait,prix_xof}')::bigint,
                  (v_p.detail #>> '{forfait,uptime_limit_s}')::integer, (v_p.detail #>> '{forfait,validity_s}')::integer,
                  (v_p.detail #>> '{forfait,data_limit_bytes}')::bigint, v_p.detail #>> '{forfait,rate_limit}',
                  (v_p.detail #>> '{forfait,devices}')::integer, (v_p.detail #>> '{forfait,bind_mac}')::boolean,
                  v_p.detail #>> '{forfait,scope}', (v_p.detail #>> '{forfait,site_id}')::bigint);
          EXIT;
        EXCEPTION WHEN unique_violation THEN
          v_code := NULL;                                -- collision de code (rare) : nouveau tirage
        END;
      END LOOP;
      IF v_code IS NULL THEN RAISE EXCEPTION 'impossible de générer un code unique'; END IF;
    ELSE
      v_code := app.voucher_creer(v_p.tenant_id, v_p.plan_id);
    END IF;
    SELECT v.id INTO STRICT v_voucher FROM app.voucher v WHERE v.tenant_id = v_p.tenant_id AND v.code = v_code;
    UPDATE app.payment SET statut = 'SUCCEEDED', voucher_id = v_voucher, maj_le = now(),
           reference_fournisseur = coalesce(left(p_reference_fournisseur, 128), reference_fournisseur),
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
         reference_fournisseur = coalesce(left(p_reference_fournisseur, 128), reference_fournisseur)
   WHERE id = v_p.id;
  RETURN p_vers;
END;
$$;

-- ---------------------------------------------------------------------------
-- Hôtes du hotspot d'un site : RECALCULÉS depuis les routeurs actifs du site (et non ajoutés sans
-- fin), plafonnés à 32. Une liste trop longue ne doit jamais faire échouer un enrôlement.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.site_hotes_depuis_inventaire(p_router bigint)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  UPDATE app.site s SET hotspot_hotes = (
    SELECT coalesce((array_agg(DISTINCT h ORDER BY h))[1:32], '{}') FROM (
      SELECT lower(x ->> k) AS h
        FROM app.router r, jsonb_array_elements(coalesce(r.inventaire -> 'hotspots', '[]'::jsonb)) x, unnest(ARRAY['adresse', 'dns']) k
       WHERE r.site_id = s.id AND r.tenant_id = s.tenant_id AND r.actif) t
     WHERE h ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$')
   FROM app.router r WHERE r.id = p_router AND s.id = r.site_id AND s.tenant_id = r.tenant_id
$$;

-- ---------------------------------------------------------------------------
-- Purge (ADR 0005 §2) : numéro en clair à sa date, tentatives de récupération de plus de 24 h ;
-- chaque purge non vide est inscrite au journal d'audit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.numeros_purger()
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_n integer;
  v_t integer;
BEGIN
  WITH p AS (UPDATE app.payment SET numero_clair = NULL
              WHERE numero_clair IS NOT NULL AND purge_numero_le < now() RETURNING 1)
  SELECT count(*)::integer INTO v_n FROM p;
  WITH t AS (DELETE FROM app.recuperation_tentative WHERE le < now() - interval '24 hours' RETURNING 1)
  SELECT count(*)::integer INTO v_t FROM t;
  IF v_n > 0 OR v_t > 0 THEN
    INSERT INTO app.audit_log (tenant_id, acteur, action, objet, details)
    VALUES (NULL, 'plateforme', 'purge_donnees_personnelles', 'payment',
            jsonb_build_object('numeros_effaces', v_n, 'tentatives_effacees', v_t));
  END IF;
  RETURN v_n;
END;
$$;

-- ---------------------------------------------------------------------------
-- Moindre privilège : aucune route ne s'en sert avant la phase 4 (revue Standards).
-- credits_solde acceptait n'importe quel propriétaire ; la lecture directe des paiements
-- n'avait ni usage ni test de cloisonnement.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION app.credits_solde(bigint) FROM wk_api;
REVOKE SELECT ON app.payment FROM wk_api;
REVOKE SELECT (id, tenant_id, site_id, plan_id, montant, devise, operateur, fournisseur, reference, statut,
               numero_masque, voucher_id, cree_le, maj_le) ON app.payment FROM wk_api;

RESET ROLE;
