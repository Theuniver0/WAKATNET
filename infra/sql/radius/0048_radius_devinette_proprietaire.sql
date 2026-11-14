-- WAKATNET — migration 0048 : budget anti-devinette PAR PROPRIÉTAIRE (scan de sécurité du 13/11/2026, F3 ; troisième
-- relecture). Le budget de 0046 est par routeur : un propriétaire à N routeurs, dont les tickets valent sur tous (portée
-- « tenant »), offrait 30 × N essais par heure. Désormais, au-delà de devinette_faibles_par_proprietaire échecs de forme
-- faible sur l'ensemble de ses routeurs dans la même fenêtre, TOUS ses routeurs sont restreints (mêmes effets qu'en
-- 0046), et une alerte « budget_proprietaire » le signale. Prix : un client qui échoue exprès 60 fois en une heure retient
-- les tickets importés de tout le propriétaire ; les codes de la plateforme restent servis.
-- IDEMPOTENTE (rejouée par test_devinette_attaque_sql avec 0012, 0027 et 0046). Index : 0049.
SET ROLE wakatnet_owner;

ALTER TABLE radius.alerte DROP CONSTRAINT IF EXISTS alerte_type_check;
ALTER TABLE radius.alerte ADD CONSTRAINT alerte_type_check
  CHECK (type IN ('blocage_mac', 'echecs_routeur', 'coupure_abandonnee', 'coupure_refusee', 'budget_routeur',
                  'budget_proprietaire'));

INSERT INTO radius.parametre (cle, valeur) VALUES
  ('devinette_faibles_par_proprietaire', '60')   -- échecs de forme faible de tous les routeurs d'un propriétaire, par fenêtre
ON CONFLICT (cle) DO NOTHING;

CREATE OR REPLACE FUNCTION radius._routeur_restreint(p_routeur bigint, p_now timestamptz)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = radius, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM radius.alerte l
                  WHERE l.type = 'echecs_routeur' AND l.router_id = p_routeur
                    AND l.at >= p_now - radius._param_entier('devinette_blocage_s', 300) * interval '1 second'
                    AND l.at <= p_now)
      OR (SELECT count(*) FROM (SELECT 1 FROM radius.auth_log a
           WHERE a.router_id = p_routeur AND a.forme_faible AND a.resultat = 'Reject' AND a.cause = 'ticket_inconnu'
             AND a.at >= p_now - radius._param_entier('devinette_faibles_fenetre_s', 3600) * interval '1 second'
             AND a.at <= p_now
           LIMIT greatest(radius._param_entier('devinette_faibles_par_heure', 30), 1)) x)
         >= greatest(radius._param_entier('devinette_faibles_par_heure', 30), 1)
      OR (SELECT count(*) FROM (SELECT 1 FROM radius.auth_log a
           WHERE a.tenant_id = (SELECT r.tenant_id FROM app.router r WHERE r.id = p_routeur)
             AND a.forme_faible AND a.resultat = 'Reject' AND a.cause = 'ticket_inconnu'
             AND a.at >= p_now - radius._param_entier('devinette_faibles_fenetre_s', 3600) * interval '1 second'
             AND a.at <= p_now
           LIMIT greatest(radius._param_entier('devinette_faibles_par_proprietaire', 60), 1)) x)
         >= greatest(radius._param_entier('devinette_faibles_par_proprietaire', 60), 1)
$$;
REVOKE ALL ON FUNCTION radius._routeur_restreint(bigint, timestamptz) FROM PUBLIC;

-- post_auth : corps de 0046, plus l'alerte budget_proprietaire. Même signature et mêmes droits.
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
  -- Migration 0044 : forme faible de la saisie (budget horaire anti-devinette), jamais la saisie elle-même (0010).
  INSERT INTO radius.auth_log (router_id, tenant_id, mac, resultat, cause, voucher_id, forme_faible)
  VALUES (v_routeur.id, v_routeur.tenant_id, v_mac,
          CASE WHEN p_result = 'Accept' THEN 'Accept' ELSE 'Reject' END,
          nullif(left(p_cause, 64), ''), v_ticket.id, radius._forme_faible(upper(coalesce(p_user, ''))));
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

  -- Migration 0046 : budget horaire d'échecs de forme faible épuisé → une alerte « budget_routeur » par fenêtre (le
  -- routeur est restreint : ses tickets importés sont refusés ; l'exploitant doit le savoir sans attendre les plaintes).
  IF p_result <> 'Accept' AND p_cause = 'ticket_inconnu' AND v_routeur.id IS NOT NULL
     AND radius._forme_faible(upper(coalesce(p_user, '')))
     AND NOT EXISTS (SELECT 1 FROM radius.alerte l
                      WHERE l.type = 'budget_routeur' AND l.router_id = v_routeur.id
                        AND l.at >= now() - radius._param_entier('devinette_faibles_fenetre_s', 3600) * interval '1 second')
     AND (SELECT count(*) FROM (SELECT 1 FROM radius.auth_log a
           WHERE a.router_id = v_routeur.id AND a.forme_faible AND a.resultat = 'Reject' AND a.cause = 'ticket_inconnu'
             AND a.at >= now() - radius._param_entier('devinette_faibles_fenetre_s', 3600) * interval '1 second'
           LIMIT greatest(radius._param_entier('devinette_faibles_par_heure', 30), 1)) x)
         >= greatest(radius._param_entier('devinette_faibles_par_heure', 30), 1) THEN
    INSERT INTO radius.alerte (type, router_id, tenant_id) VALUES ('budget_routeur', v_routeur.id, v_routeur.tenant_id);
  END IF;
  -- Migration 0048 : même chose à l'échelle du PROPRIÉTAIRE (tous ses routeurs) : une alerte budget_proprietaire. Ses N
  -- routeurs écrivent en parallèle : un verrou consultatif par propriétaire évite deux alertes pour un même seuil.
  IF p_result <> 'Accept' AND p_cause = 'ticket_inconnu' AND v_routeur.id IS NOT NULL
     AND radius._forme_faible(upper(coalesce(p_user, ''))) THEN
    PERFORM pg_advisory_xact_lock(hashtext('budget_proprietaire'), v_routeur.tenant_id::integer);
  END IF;
  IF p_result <> 'Accept' AND p_cause = 'ticket_inconnu' AND v_routeur.id IS NOT NULL
     AND radius._forme_faible(upper(coalesce(p_user, '')))
     AND NOT EXISTS (SELECT 1 FROM radius.alerte l
                      WHERE l.type = 'budget_proprietaire' AND l.tenant_id = v_routeur.tenant_id
                        AND l.at >= now() - radius._param_entier('devinette_faibles_fenetre_s', 3600) * interval '1 second')
     AND (SELECT count(*) FROM (SELECT 1 FROM radius.auth_log a
           WHERE a.tenant_id = v_routeur.tenant_id AND a.forme_faible AND a.resultat = 'Reject' AND a.cause = 'ticket_inconnu'
             AND a.at >= now() - radius._param_entier('devinette_faibles_fenetre_s', 3600) * interval '1 second'
           LIMIT greatest(radius._param_entier('devinette_faibles_par_proprietaire', 60), 1)) x)
         >= greatest(radius._param_entier('devinette_faibles_par_proprietaire', 60), 1) THEN
    INSERT INTO radius.alerte (type, router_id, tenant_id) VALUES ('budget_proprietaire', NULL, v_routeur.tenant_id);
  END IF;

  -- bind_mac : posée au premier Accept (ADR 0006 §9).
  IF p_result = 'Accept' AND v_ticket.f_bind_mac AND v_ticket.mac_liee IS NULL AND v_mac <> '' THEN
    UPDATE app.voucher v SET mac_liee = v_mac WHERE v.id = v_ticket.id AND v.mac_liee IS NULL;
  END IF;
  RETURN 'ok';
END;
$$;

RESET ROLE;
