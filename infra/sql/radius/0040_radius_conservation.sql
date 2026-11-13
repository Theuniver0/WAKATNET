-- WAKATNET — migration 0040 : durées de conservation décidées par Yacouba le 13/11/2026 (docs/CONFORMITE.md §7 bis).
-- Trois données n'avaient aucune purge (relevé du 13/11/2026). Durées choisies, à valider par le juriste et la CIL (§6) :
--   * sessions RADIUS : MAC et IP effacées 12 mois après le début d'une session FERMÉE. La ligne reste : ses durées et
--     ses octets servent au décompte du ticket (un forfait limité en temps d'usage n'a pas de date de fin) ; l'effacer
--     rendrait du temps gratuit. Les sessions vivantes ne sont jamais touchées (décompte des appareils, ADR 0006 §9) ;
--   * enregistrements d'accounting en quarantaine et anomalies (données brutes, MAC comprise) : supprimés à 12 mois ;
--   * corps bruts des webhooks (app.payment_event.corps ; avec pawaPay, le numéro du payeur en clair : F4) : vidés à
--     6 mois, comme le numéro du payeur (ADR 0005). La ligne reste : identifiant d'événement (dédoublonnage),
--     date de réception et paiement ;
--   * journal d'audit (app.audit_log) : lignes de plus de 5 ans supprimées.
-- Une seule fonction, appelée par wakatnet-purge (rôle wk_maint), par lots, sans effet sur une réplique (le script
-- sort avant, et une réplique refuse toute écriture). Chaque passage qui change quelque chose est journalisé.
SET ROLE wakatnet_owner;

CREATE FUNCTION radius.purge_conservation(p_lot integer DEFAULT 50000)
RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = radius, app, pg_temp
AS $$
DECLARE
  v_lot      integer := greatest(1, least(coalesce(p_lot, 50000), 500000));
  v_sessions bigint;
  v_quar     bigint;
  v_anom     bigint;
  v_corps    bigint;
  v_audit    bigint;
BEGIN
  -- Sessions fermées de plus de 12 mois : MAC et IP effacées, compteurs gardés.
  UPDATE radius.session s SET calling_station = NULL, framed_ip = NULL
   WHERE (s.id, s.started_at) IN (
           SELECT x.id, x.started_at FROM radius.session x
            WHERE x.started_at < now() - interval '12 months' AND x.arrete_le IS NOT NULL
              AND (x.calling_station IS NOT NULL OR x.framed_ip IS NOT NULL)
            ORDER BY x.started_at LIMIT v_lot);
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  DELETE FROM radius.acct_quarantaine q
   WHERE q.id IN (SELECT y.id FROM radius.acct_quarantaine y WHERE y.recu_le < now() - interval '12 months'
                   ORDER BY y.recu_le LIMIT v_lot);
  GET DIAGNOSTICS v_quar = ROW_COUNT;
  DELETE FROM radius.acct_anomalie a
   WHERE a.id IN (SELECT y.id FROM radius.acct_anomalie y WHERE y.recu_le < now() - interval '12 months'
                   ORDER BY y.recu_le LIMIT v_lot);
  GET DIAGNOSTICS v_anom = ROW_COUNT;

  -- Corps bruts des webhooks de plus de 6 mois : vidés (la colonne est NOT NULL : octets vides).
  UPDATE app.payment_event e SET corps = ''::bytea
   WHERE e.id IN (SELECT y.id FROM app.payment_event y WHERE y.recu_le < now() - interval '6 months'
                   AND length(y.corps) > 0 ORDER BY y.recu_le LIMIT v_lot);
  GET DIAGNOSTICS v_corps = ROW_COUNT;

  -- Journal d'audit de plus de 5 ans.
  DELETE FROM app.audit_log l
   WHERE l.id IN (SELECT y.id FROM app.audit_log y WHERE y.le < now() - interval '5 years'
                   ORDER BY y.le LIMIT v_lot);
  GET DIAGNOSTICS v_audit = ROW_COUNT;

  IF v_sessions + v_quar + v_anom + v_corps + v_audit > 0 THEN
    INSERT INTO app.audit_log (acteur, action, objet, details)
    VALUES (session_user, 'purge_conservation', 'conservation',
            jsonb_build_object('sessions_anonymisees', v_sessions, 'quarantaine_supprimee', v_quar,
                               'anomalies_supprimees', v_anom, 'corps_webhook_vides', v_corps,
                               'audit_supprime', v_audit, 'lot', v_lot));
  END IF;
  RETURN v_sessions + v_quar + v_anom + v_corps + v_audit;
END;
$$;

REVOKE ALL ON FUNCTION radius.purge_conservation(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION radius.purge_conservation(integer) TO wk_maint;

RESET ROLE;
