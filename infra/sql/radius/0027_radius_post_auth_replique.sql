-- WAKATNET — migration 0027 : post_auth muet sur une réplique (phase 5, ticket 02 ; T13).
-- Ticket : .scratch/phase-5-haute-disponibilite/issues/02-t13-replique.md ; ADR 0015 §2.
-- Corps identique à la migration 0012, sauf la garde de tête. La valeur rendue n'est lue par
-- personne (FreeRADIUS ignore la sortie de map_post_auth_*).

SET ROLE wakatnet_owner;

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
  -- Nœud B en réplique (T13, ADR 0015 §2) : rien n'est écrit, et rien n'échoue. Sans cette
  -- garde, chaque authentification lèverait 25006, ignorée par FreeRADIUS (fail = 1) mais
  -- journalisée par PostgreSQL. Journal des tentatives et compteurs anti-devinette ne sont
  -- donc pas tenus sur B en mode dégradé (assumé, §10.2).
  IF pg_is_in_recovery() THEN
    RETURN 'replique';
  END IF;
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

RESET ROLE;
