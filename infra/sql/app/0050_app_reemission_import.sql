-- WAKATNET — migration 0050 : réémission des tickets importés de Mikhmon (décision de Yacouba du 14/11/2026, suite du scan
-- de sécurité F3). Les codes importés courts (4 à 6 chiffres) restent devinables malgré les budgets anti-devinette (ADR
-- 0011) : le propriétaire peut remplacer ceux qui n'ont JAMAIS servi par des codes de la plateforme.
--   - éligible : origine « import », jamais activé (ni activation, ni connexion acceptée), pas expiré ;
--   - chaque ticket éligible reçoit un remplaçant, code de la plateforme, avec SA copie figée du forfait (prix, durées,
--     débit, portée… tels qu'importés), dans des lots de la plateforme (1 000 au plus), imprimables comme les autres ;
--   - l'ancien GARDE son code, est EXPIRÉ et pointe vers son remplaçant (reemis_par). Saisi, il répond « expiré » : il ne
--     consomme pas le budget anti-devinette (seuls les « ticket inconnu » comptent), un réimport de l'export Mikhmon le
--     voit en doublon (il ne revit jamais), et le support sait quel ticket le remplace ;
--   - « le premier activé gagne » (relecture de la règle 4) : authorize lit sans verrou, un client peut donc se
--     connecter avec l'ancien code pendant la réémission ; son accounting active l'ancien ticket (recherche par code,
--     0008), et app.reemission_reconcilier(), à chaque tour des tâches, expire alors le remplaçant s'il n'a pas servi
--     (sinon : alerte, la valeur a servi deux fois) ;
--   - par tranches (p_max) : chaque appel est une transaction courte, et chaque ticket est revérifié une fois verrouillé.
-- Aucun crédit n'est consommé : remplacement un pour un, pas un stock nouveau ; le plafond du découvert ne s'applique pas
-- (les frais papier se prélèvent à l'activation, sur la copie figée, identique). Propriétaire seulement.
SET ROLE wakatnet_owner;

ALTER TABLE app.voucher ADD COLUMN reemis_par bigint REFERENCES app.voucher (id);
CREATE INDEX voucher_reemis_par ON app.voucher (reemis_par) WHERE reemis_par IS NOT NULL;

-- Sans SET : une fonction SQL simple peut être intégrée à la requête appelante (noms entièrement qualifiés).
CREATE FUNCTION app._import_inutilise(v app.voucher)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT v.origine = 'import' AND v.reemis_par IS NULL AND v.activated_at IS NULL
     AND (v.expires_at IS NULL OR v.expires_at > now())
     -- Toute session pose une activation (acct_start, 0005) : la clé primaire de radius.activation suffit.
     AND NOT EXISTS (SELECT 1 FROM radius.activation a WHERE a.voucher_id = v.id)
     AND NOT EXISTS (SELECT 1 FROM radius.auth_log l WHERE l.voucher_id = v.id AND l.resultat = 'Accept')
$$;

-- Ce qui peut être réémis, par forfait, pour le propriétaire COURANT ; « courts » : codes de forme faible (0046).
CREATE FUNCTION app.import_a_reemettre()
RETURNS TABLE (plan_id bigint, plan_nom text, tickets bigint, courts bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  SELECT v.plan_id, p.nom, count(*), count(*) FILTER (WHERE radius._forme_faible(v.code))
    FROM app.voucher v JOIN app.plan p ON p.id = v.plan_id AND p.tenant_id = v.tenant_id
   WHERE v.tenant_id = app.tenant_courant() AND v.origine = 'import' AND v.activated_at IS NULL
     AND app._import_inutilise(v)
   GROUP BY v.plan_id, p.nom
   ORDER BY v.plan_id
$$;

-- Réémission d'une TRANCHE (au plus p_max tickets, de 1 à 1 000 ; l'appelant répète jusqu'à « rien »). p_plan NULL :
-- tous les forfaits. statut : 'cree' (une ligne par lot créé) | 'pdv_inconnu' | 'rien'.
CREATE FUNCTION app.import_reemettre(p_pdv bigint, p_plan bigint, p_utilisateur bigint, p_max integer)
RETURNS TABLE (statut text, lot_id bigint, plan_id bigint, quantite integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_t      bigint := app.tenant_courant();
  v_ancien app.voucher%ROWTYPE;
  v_frais  app.voucher%ROWTYPE;
  v_lots   jsonb := '{}';          -- forfait → lot de cette tranche
  v_lot    bigint;
  v_nouv   bigint;
  v_total  integer := 0;
  v_code   text;
BEGIN
  IF v_t IS NULL THEN RAISE EXCEPTION 'réémission sans propriétaire (contexte RLS absent)'; END IF;
  IF p_max IS NULL OR p_max NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'tranche de 1 à 1 000 tickets'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.point_of_sale WHERE id = p_pdv AND tenant_id = v_t) THEN
    RETURN QUERY SELECT 'pdv_inconnu'::text, NULL::bigint, NULL::bigint, NULL::integer; RETURN;
  END IF;
  -- Une réémission à la fois par propriétaire.
  PERFORM pg_advisory_xact_lock(hashtext('import_reemettre'), v_t::integer);
  FOR v_ancien IN SELECT * FROM app.voucher v
                   WHERE v.tenant_id = v_t AND v.origine = 'import' AND v.activated_at IS NULL
                     AND (p_plan IS NULL OR v.plan_id = p_plan) AND app._import_inutilise(v)
                   ORDER BY v.plan_id, v.id
                   LIMIT p_max
                   FOR UPDATE SKIP LOCKED LOOP
    -- Revérifié une fois verrouillé, avec un instantané neuf : une connexion acceptée entre-temps l'exclut.
    SELECT * INTO v_frais FROM app.voucher WHERE id = v_ancien.id;
    CONTINUE WHEN NOT app._import_inutilise(v_frais);
    v_lot := (v_lots ->> v_ancien.plan_id::text)::bigint;
    IF v_lot IS NULL THEN
      INSERT INTO app.voucher_batch (tenant_id, plan_id, point_of_sale_id, quantite, cree_par)
      VALUES (v_t, v_ancien.plan_id, p_pdv, 1, p_utilisateur) RETURNING id INTO v_lot;
      v_lots := v_lots || jsonb_build_object(v_ancien.plan_id::text, v_lot);
    END IF;
    -- Remplaçant : code de la plateforme, copie figée de l'ANCIEN (ce qui a été vendu ou promis). Collision de code
    -- (rare) : nouveau tirage, sans sous-transaction (ON CONFLICT).
    v_nouv := NULL;
    FOR essai IN 1 .. 5 LOOP
      v_code := app.generer_code(8);
      INSERT INTO app.voucher (tenant_id, plan_id, code, origine, batch_id, f_prix_xof, f_uptime_limit_s, f_validity_s,
                               f_data_limit_bytes, f_rate_limit, f_devices, f_bind_mac, f_scope, f_site_id)
      VALUES (v_t, v_ancien.plan_id, v_code, 'wakatnet', v_lot, v_ancien.f_prix_xof, v_ancien.f_uptime_limit_s,
              v_ancien.f_validity_s, v_ancien.f_data_limit_bytes, v_ancien.f_rate_limit, v_ancien.f_devices,
              v_ancien.f_bind_mac, v_ancien.f_scope, v_ancien.f_site_id)
      ON CONFLICT (tenant_id, code) DO NOTHING
      RETURNING id INTO v_nouv;
      EXIT WHEN v_nouv IS NOT NULL;
    END LOOP;
    IF v_nouv IS NULL THEN RAISE EXCEPTION 'impossible de générer un code unique'; END IF;
    UPDATE app.voucher SET expires_at = now(), reemis_par = v_nouv WHERE id = v_ancien.id;
    v_total := v_total + 1;
  END LOOP;
  IF v_total = 0 THEN
    RETURN QUERY SELECT 'rien'::text, NULL::bigint, NULL::bigint, NULL::integer; RETURN;
  END IF;
  -- Quantité réelle de chaque lot de la tranche.
  UPDATE app.voucher_batch b SET quantite = (SELECT count(*) FROM app.voucher v WHERE v.batch_id = b.id AND v.tenant_id = v_t)
   WHERE b.id IN (SELECT (x.value)::bigint FROM jsonb_each_text(v_lots) x);
  INSERT INTO app.audit_log (tenant_id, acteur, action, objet, details)
  VALUES (v_t, 'utilisateur:' || p_utilisateur, 'import_reemis', 'pdv:' || p_pdv,
          jsonb_build_object('tickets', v_total, 'forfait', p_plan, 'lots', v_lots));
  RETURN QUERY
    SELECT 'cree'::text, b.id, b.plan_id, b.quantite FROM app.voucher_batch b
     WHERE b.id IN (SELECT (x.value)::bigint FROM jsonb_each_text(v_lots) x) ORDER BY b.id;
END;
$$;

-- « Le premier activé gagne » : un ancien ticket activé (connexion pendant la réémission) expire son remplaçant resté
-- inutilisé ; si les deux ont servi, une alerte (la valeur a servi deux fois). Appelée à chaque tour des tâches.
CREATE FUNCTION app.reemission_reconcilier()
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  n integer := 0;
  r record;
BEGIN
  FOR r IN SELECT o.id AS ancien, o.tenant_id, nv.id AS nouveau, nv.activated_at AS nouveau_active
             FROM app.voucher o JOIN app.voucher nv ON nv.id = o.reemis_par
            WHERE o.reemis_par IS NOT NULL AND o.activated_at IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM app.audit_log a
                               WHERE a.tenant_id = o.tenant_id AND a.objet = 'ticket:' || o.id
                                 AND a.action IN ('reemission_conflit', 'reemission_double'))
            FOR UPDATE OF nv LOOP
    IF r.nouveau_active IS NULL THEN
      UPDATE app.voucher SET expires_at = now() WHERE id = r.nouveau AND activated_at IS NULL;
      INSERT INTO app.audit_log (tenant_id, acteur, action, objet, details)
      VALUES (r.tenant_id, 'plateforme', 'reemission_conflit', 'ticket:' || r.ancien,
              jsonb_build_object('remplacant_expire', r.nouveau));
    ELSE
      INSERT INTO app.audit_log (tenant_id, acteur, action, objet, details)
      VALUES (r.tenant_id, 'plateforme', 'reemission_double', 'ticket:' || r.ancien,
              jsonb_build_object('remplacant', r.nouveau));
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION app._import_inutilise(app.voucher), app.import_a_reemettre(),
                       app.import_reemettre(bigint, bigint, bigint, integer), app.reemission_reconcilier() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_a_reemettre(), app.import_reemettre(bigint, bigint, bigint, integer),
                          app.reemission_reconcilier() TO wk_api;

RESET ROLE;
