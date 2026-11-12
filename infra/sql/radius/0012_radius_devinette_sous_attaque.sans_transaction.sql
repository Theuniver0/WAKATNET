-- WAKATNET — migration 0012 : anti-devinette sous attaque (suite de la mesure du ticket 10).
-- Ticket : .scratch/phase-1-coeur-radius/issues/10-performance.md ; radius/tests/perf/RAPPORT.md §7.
-- Contrats : ADR 0006 §4 et §11 (inchangés) ; décision : ADR 0011 ; application : ADR 0008.
--
-- Mesuré le 12/11/2026 : sous attaque (échecs récents nombreux sur un routeur, MAC toutes
-- différentes) et avec des statistiques non rafraîchies, la recherche des échecs d'UNE MAC
-- (trop_de_tentatives, dans _authorize_at) passait par l'index PAR ROUTEUR et filtrait la MAC :
-- 44 ms à 100 000 échecs récents. Correction STRUCTURELLE : l'index par routeur porte sur
-- (router_id + 0), qu'une condition « router_id = … » ne peut pas utiliser ; seul le compte
-- d'alerte par routeur de post_auth, écrit « router_id + 0 = … », s'en sert. Les deux comptes
-- d'alerte de post_auth sont bornés à leur seuil (LIMIT).
--
-- SANS TRANSACTION (suffixe .sans_transaction.sql, voir migrer.sh ; revue du 12/11/2026) :
-- CREATE INDEX CONCURRENTLY et DROP INDEX CONCURRENTLY ne bloquent ni les lectures (authorize)
-- ni les écritures (post_auth), même sur un auth_log de 90 jours. Une construction ordinaire
-- dans une transaction bloquait les INSERT de post_auth pendant toute sa durée, et un DROP INDEX
-- ordinaire, en attente derrière un lecteur long, aurait fait attendre tous les authorize.
-- migrer.sh pose lock_timeout et réessaie ; chaque étape est donc IDEMPOTENTE.
-- Remplace la version transactionnelle (0012_radius_devinette_sous_attaque.sql, appliquée
-- seulement à des piles de test jetables) : sur une base qui l'aurait appliquée, cette
-- migration crée l'index sous son nom définitif et supprime l'ancien.

SET ROLE wakatnet_owner;

-- Construction interrompue (lock_timeout, coupure) : l'index peut rester INVALIDE. On le
-- supprime avant de le reconstruire.
SELECT EXISTS (SELECT FROM pg_index i
                WHERE i.indexrelid = to_regclass('radius.auth_log_echecs_routeur_expr')
                  AND NOT i.indisvalid) AS index_invalide \gset
\if :index_invalide
DROP INDEX CONCURRENTLY radius.auth_log_echecs_routeur_expr;
\endif

CREATE INDEX CONCURRENTLY IF NOT EXISTS auth_log_echecs_routeur_expr
  ON radius.auth_log ((router_id + 0), at)
  WHERE resultat = 'Reject' AND cause = 'ticket_inconnu';

-- Même signature, même contrat et mêmes droits qu'en 0009 ; seuls les deux comptes changent.
CREATE OR REPLACE FUNCTION radius.post_auth(p_user text, p_src text, p_calling text, p_result text, p_cause text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = radius, pg_temp
AS $$
DECLARE
  v_routeur app.router%ROWTYPE;
  v_ticket  app.voucher%ROWTYPE;
  v_mac     text := radius._mac(p_calling);
BEGIN
  IF p_src IS NOT NULL AND pg_input_is_valid(p_src, 'inet') THEN
    SELECT * INTO v_routeur FROM app.router r WHERE r.overlay_ip = p_src::inet;
  END IF;
  IF v_routeur.id IS NOT NULL THEN
    SELECT * INTO v_ticket FROM app.voucher v
     WHERE v.tenant_id = v_routeur.tenant_id AND v.code = upper(coalesce(p_user, ''));
  END IF;
  INSERT INTO radius.auth_log (router_id, tenant_id, mac, resultat, cause, voucher_id)
  VALUES (v_routeur.id, v_routeur.tenant_id, v_mac,
          CASE WHEN p_result = 'Accept' THEN 'Accept' ELSE 'Reject' END,
          nullif(left(p_cause, 64), ''), v_ticket.id);
  -- Alertes (ticket 07, ADR 0006 §11), inscrites pour le futur worker, sans effet sur la réponse.
  -- Une seule alerte par sujet et par période, même sous une rafale.
  IF p_result <> 'Accept' AND p_cause = 'ticket_inconnu' AND v_routeur.id IS NOT NULL THEN
    -- Comptes bornés au seuil (LIMIT) : sous attaque, le coût ne croît plus avec le volume.
    IF v_mac <> ''
       AND (SELECT count(*) FROM (SELECT 1 FROM radius.auth_log a
             WHERE a.router_id = v_routeur.id AND a.mac = v_mac AND a.resultat = 'Reject'
               AND a.cause = 'ticket_inconnu'
               AND a.at >= now() - radius._param_entier('devinette_fenetre_s', 60) * interval '1 second'
             LIMIT radius._param_entier('devinette_echecs_par_mac', 10)) x)
           >= radius._param_entier('devinette_echecs_par_mac', 10)
       AND NOT EXISTS (SELECT 1 FROM radius.alerte l
                        WHERE l.type = 'blocage_mac' AND l.router_id = v_routeur.id AND l.mac = v_mac
                          AND l.at >= now() - radius._param_entier('devinette_blocage_s', 300) * interval '1 second') THEN
      INSERT INTO radius.alerte (type, router_id, tenant_id, mac) VALUES ('blocage_mac', v_routeur.id, v_routeur.tenant_id, v_mac);
    END IF;
    -- (router_id + 0) : seule forme servie par l'index par routeur (migration 0012).
    IF (SELECT count(*) FROM (SELECT 1 FROM radius.auth_log a
         WHERE a.router_id + 0 = v_routeur.id AND a.resultat = 'Reject' AND a.cause = 'ticket_inconnu'
           AND a.at >= now() - radius._param_entier('devinette_fenetre_s', 60) * interval '1 second'
         LIMIT radius._param_entier('devinette_echecs_par_routeur', 100)) x)
         >= radius._param_entier('devinette_echecs_par_routeur', 100)
       AND NOT EXISTS (SELECT 1 FROM radius.alerte l
                        WHERE l.type = 'echecs_routeur' AND l.router_id = v_routeur.id
                          AND l.at >= now() - radius._param_entier('devinette_fenetre_s', 60) * interval '1 second') THEN
      INSERT INTO radius.alerte (type, router_id, tenant_id) VALUES ('echecs_routeur', v_routeur.id, v_routeur.tenant_id);
    END IF;
  END IF;

  -- bind_mac : posée au premier Accept (ADR 0006 §9).
  IF p_result = 'Accept' AND v_ticket.f_bind_mac AND v_ticket.mac_liee IS NULL AND v_mac <> '' THEN
    UPDATE app.voucher v SET mac_liee = v_mac WHERE v.id = v_ticket.id AND v.mac_liee IS NULL;
  END IF;
  RETURN 'ok';
END;
$$;

-- L'ancien index (router_id, at), que la requête par MAC pouvait prendre.
DROP INDEX CONCURRENTLY IF EXISTS radius.auth_log_echecs_routeur;

RESET ROLE;
