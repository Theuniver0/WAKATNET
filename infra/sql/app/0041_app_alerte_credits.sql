-- WAKATNET — migration 0041 : l'alerte « crédits bas » parvient au propriétaire (SPEC §8.2 : « Alerte quand le solde passe
-- sous 20 % du dernier rechargement »). Jusqu'ici, app._alerte_credits (0019) l'écrivait au journal d'audit, et rien ne
-- la lisait (revue Spec du 13/11/2026).
--   1. app.credits_alerte() : état de l'alerte pour le propriétaire COURANT (tableau de bord, bandeau) ;
--   2. app.alertes_credits_a_notifier() et app.alerte_credits_notifiee() : envoi par e-mail depuis la tâche périodique,
--      une fois par alerte, à l'adresse VÉRIFIÉE du propriétaire ; l'envoi est inscrit au journal d'audit.
SET ROLE wakatnet_owner;

-- Même règle que app._alerte_credits : solde × 5 < dernier rechargement (solde sous 20 %). Sans rechargement : pas d'alerte.
CREATE FUNCTION app.credits_alerte()
RETURNS TABLE (bas boolean, solde_xof bigint, dernier_rechargement_xof bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, ledger, pg_temp
AS $$
  WITH t AS (SELECT app.tenant_courant() AS id),
  r AS (SELECT e.credit AS montant
          FROM ledger.transaction x JOIN ledger.ecriture e ON e.transaction_id = x.id
          JOIN ledger.compte k ON k.id = e.compte_id, t
         WHERE x.nature = 'recharge' AND k.code = 'proprietaire:' || t.id || ':credits'
         ORDER BY x.id DESC LIMIT 1)
  SELECT coalesce(app.credits_solde(t.id) * 5 < r.montant, false), app.credits_solde(t.id), r.montant
    FROM t LEFT JOIN r ON true
   WHERE t.id IS NOT NULL
$$;

-- Alertes des 7 derniers jours pas encore envoyées, avec l'adresse vérifiée et active du propriétaire. Les plus récentes
-- d'abord, et seulement si la règle vaut ENCORE (relecture de sécurité n° 4) : une adresse rejetée pour de bon ne bloque
-- pas les autres, et un propriétaire qui a rechargé entre-temps ne reçoit pas une alerte périmée.
CREATE FUNCTION app.alertes_credits_a_notifier(p_lot integer DEFAULT 20)
RETURNS TABLE (audit_id bigint, email text, solde_xof bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, ledger, pg_temp
AS $$
  SELECT a.id, u.email, app.credits_solde(a.tenant_id)
    FROM app.audit_log a
    JOIN app.utilisateur u ON u.tenant_id = a.tenant_id AND u.role = 'proprietaire' AND u.actif AND u.email_verifie_le IS NOT NULL
   WHERE a.action = 'alerte_credits_bas' AND a.le > now() - interval '7 days'
     AND NOT EXISTS (SELECT 1 FROM app.audit_log n WHERE n.action = 'alerte_credits_notifiee' AND n.objet = 'audit:' || a.id)
     AND app.credits_solde(a.tenant_id) * 5 < (a.details ->> 'dernier_rechargement')::bigint
     AND NOT EXISTS (SELECT 1 FROM app.audit_log p WHERE p.action = 'alerte_credits_bas' AND p.tenant_id = a.tenant_id AND p.id > a.id)
   ORDER BY a.id DESC
   LIMIT greatest(1, least(coalesce(p_lot, 20), 100))
$$;

-- Envoi inscrit au journal, une fois par alerte (idempotent).
CREATE FUNCTION app.alerte_credits_notifiee(p_audit bigint)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  INSERT INTO app.audit_log (tenant_id, acteur, action, objet)
  SELECT a.tenant_id, 'plateforme', 'alerte_credits_notifiee', 'audit:' || a.id
    FROM app.audit_log a
   WHERE a.id = p_audit AND a.action = 'alerte_credits_bas'
     AND NOT EXISTS (SELECT 1 FROM app.audit_log n WHERE n.action = 'alerte_credits_notifiee' AND n.objet = 'audit:' || a.id)
$$;

REVOKE ALL ON FUNCTION app.credits_alerte(), app.alertes_credits_a_notifier(integer), app.alerte_credits_notifiee(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.credits_alerte(), app.alertes_credits_a_notifier(integer), app.alerte_credits_notifiee(bigint) TO wk_api;

RESET ROLE;
