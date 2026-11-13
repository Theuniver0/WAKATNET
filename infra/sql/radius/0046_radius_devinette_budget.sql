-- WAKATNET — migration 0046 : budget horaire anti-devinette (scan de sécurité du 13/11/2026, F3 ; décision de Yacouba).
-- L'alerte « echecs_routeur » (0009, 0044) ne tombe qu'à 100 échecs par minute : un attaquant qui reste dessous, en
-- changeant de MAC, devinait un ticket importé de 4 à 6 chiffres en quelques heures. Désormais :
--   - post_auth marque chaque échec « forme faible » ou non (jamais la saisie, migration 0010) ;
--   - un routeur est RESTREINT pendant une alerte, ou au-delà de devinette_faibles_par_heure échecs de forme faible en
--     devinette_faibles_fenetre_s secondes ; il refuse alors les codes de forme faible (trop_de_tentatives) et traite
--     un ticket importé trouvé comme inconnu (préfixes Mikhmon de forme forte) ; les codes de la plateforme restent
--     servis ; une alerte « budget_routeur » le signale.
-- IDEMPOTENTE : test_devinette_attaque_sql rejoue 0012 puis les migrations qui redéfinissent ses fonctions (post_auth).
-- Ordre des verrous : auth_log PUIS alerte, comme post_auth (seconde relecture : pas d'interblocage). Index : 0047.
SET ROLE wakatnet_owner;

ALTER TABLE radius.auth_log ADD COLUMN IF NOT EXISTS forme_faible boolean NOT NULL DEFAULT false;
ALTER TABLE radius.alerte DROP CONSTRAINT IF EXISTS alerte_type_check;
ALTER TABLE radius.alerte ADD CONSTRAINT alerte_type_check
  CHECK (type IN ('blocage_mac', 'echecs_routeur', 'coupure_abandonnee', 'coupure_refusee', 'budget_routeur'));

INSERT INTO radius.parametre (cle, valeur) VALUES
  ('devinette_faibles_par_heure', '30'),     -- échecs de forme faible d'un routeur…
  ('devinette_faibles_fenetre_s', '3600')    -- … sur une heure glissante : routeur restreint
ON CONFLICT (cle) DO NOTHING;

-- Forme faible : pas la forme d'un code de la plateforme (0017), ou tout en chiffres. Ne dépend QUE de la saisie.
CREATE OR REPLACE FUNCTION radius._forme_faible(p_code text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_code !~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8,16}$' OR p_code ~ '^[0-9]+$'
$$;

-- Routeur restreint : alerte « echecs_routeur » récente, ou budget d'échecs de forme faible épuisé (au moins 1 :
-- un paramètre à 0 ne restreint pas tout). Comptes bornés (LIMIT) : le coût ne croît pas avec le volume.
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
$$;
REVOKE ALL ON FUNCTION radius._forme_faible(text), radius._routeur_restreint(bigint, timestamptz) FROM PUBLIC;

-- authorize : corps de 0044, la restriction remplaçant le seul test d'alerte. Même signature et mêmes droits.
CREATE OR REPLACE FUNCTION radius._authorize_at(p_user text, p_src text, p_calling text, p_called text, p_now timestamptz)
RETURNS TABLE (cleartext_password text, decision text, reply_message text,
               session_timeout bigint, rate_limit text, port_limit integer, interim integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = radius, pg_temp
AS $$
DECLARE
  v_ip               inet;
  v_routeur          app.router%ROWTYPE;
  v_ticket           app.voucher%ROWTYPE;
  v_suspendu         boolean;
  v_code             text := upper(coalesce(p_user, ''));
  v_now              numeric := extract(epoch FROM p_now);
  v_reste_validite   numeric;
  v_reste_expiration numeric;
  v_timeout          numeric;
  v_cause            text;
  v_temps            numeric;   -- numeric : une somme de bigint peut dépasser 2^63 − 1
  v_octets           numeric;
  v_mac              text := radius._mac(p_calling);
  v_fenetre          numeric;
  v_autres           integer;
  v_fin_rafale       timestamptz;
  v_restreint        boolean;
BEGIN
  BEGIN
    v_ip := p_src::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  -- Chaque étape pose la cause qu'elle produirait, puis sort du bloc si la condition
  -- de refus est remplie. Une condition indéterminée (NULL) ne vaut jamais acceptation.
  <<regles>>
  BEGIN
    -- Instant de référence inutilisable : seul un appel direct de la fonction interne
    -- (rôle de test) peut le produire, l'enveloppe passant now(). Jamais d'Accept sans repère.
    v_cause := 'expire';
    EXIT regles WHEN p_now IS NULL OR NOT isfinite(p_now);

    v_cause := 'ticket_inconnu';
    -- Routeur : déduit de l'IP source uniquement (§5.1) ; le propriétaire et le site en découlent.
    SELECT * INTO v_routeur FROM app.router r WHERE r.overlay_ip = v_ip AND r.actif;
    EXIT regles WHEN NOT FOUND;

    -- Anti-devinette (ticket 07, ADR 0006 §11), EN TÊTE, avant la recherche du ticket :
    -- une MAC qui a cumulé N échecs « ticket_inconnu » en F secondes sur ce routeur est bloquée
    -- B secondes après la fin de cette rafale. Les refus trop_de_tentatives ne comptent pas.
    -- MAC illisible : pas de blocage par MAC (l'alerte par routeur reste).
    v_cause := 'trop_de_tentatives';
    IF v_mac <> '' THEN
      SELECT max(x.at) INTO v_fin_rafale FROM (
        SELECT a.at, count(*) OVER (ORDER BY a.at RANGE BETWEEN
                 radius._param_entier('devinette_fenetre_s', 60) * interval '1 second' PRECEDING AND CURRENT ROW) AS n
          FROM radius.auth_log a
         WHERE a.router_id = v_routeur.id AND a.mac = v_mac
           AND a.resultat = 'Reject' AND a.cause = 'ticket_inconnu'
           AND a.at >= p_now - (radius._param_entier('devinette_blocage_s', 300)
                                + radius._param_entier('devinette_fenetre_s', 60)) * interval '1 second'
           AND a.at <= p_now
      ) x WHERE x.n >= radius._param_entier('devinette_echecs_par_mac', 10);
      EXIT regles WHEN v_fin_rafale IS NOT NULL
                   AND v_fin_rafale >= p_now - radius._param_entier('devinette_blocage_s', 300) * interval '1 second';
    END IF;

    -- Scan de sécurité du 13/11/2026 (F3, migration 0044) : la MAC est choisie par le client ; en changeant de MAC, il
    -- échappait au blocage ci-dessus. Routeur RESTREINT (alerte « echecs_routeur » récente, ou budget horaire d'échecs
    -- de forme faible épuisé) : les codes de forme faible sont refusés quelle que soit la MAC. Les codes de la
    -- plateforme restent servis. Prix assumé (ADR 0011, addendum) : un client qui échoue exprès peut retenir les tickets
    -- importés du routeur.
    v_cause := 'trop_de_tentatives';
    -- Évaluée pour TOUTE saisie, avant la recherche du ticket : la durée de la réponse ne dépend pas de l'existence d'un
    -- ticket importé (seconde relecture). Coût borné : EXISTS sur l'alerte, compte limité sur un index partiel (0047).
    v_restreint := radius._routeur_restreint(v_routeur.id, p_now);
    EXIT regles WHEN v_restreint AND radius._forme_faible(v_code);

    v_cause := 'ticket_inconnu';
    -- Ticket : clé (propriétaire, code), jamais le code seul (ADR 0006 §3, T6).
    SELECT * INTO v_ticket FROM app.voucher v WHERE v.tenant_id = v_routeur.tenant_id AND v.code = v_code;
    EXIT regles WHEN NOT FOUND;
    -- Ticket IMPORTÉ de forme forte (préfixe Mikhmon : « WAK » + 5 caractères) sur un routeur restreint : même réponse
    -- qu'un code inconnu. Décidé APRÈS la recherche, mais la réponse ne distingue rien : aucun oracle.
    EXIT regles WHEN v_restreint AND v_ticket.origine = 'import';

    -- Suspension ADMINISTRATIVE seulement (ADR 0006 §4) : rien d'autre du propriétaire n'est lu.
    v_cause := 'proprietaire_suspendu';
    SELECT t.suspendu INTO v_suspendu FROM app.tenant t WHERE t.id = v_routeur.tenant_id;
    EXIT regles WHEN v_suspendu IS NOT FALSE;

    -- Portée figée sur le ticket : tout le propriétaire, ou un site précis.
    v_cause := 'mauvais_site';
    EXIT regles WHEN NOT coalesce(
      v_ticket.f_scope = 'tenant'
      OR (v_ticket.f_scope = 'site' AND v_ticket.f_site_id = v_routeur.site_id), false);

    v_cause := 'expire';
    IF v_ticket.f_validity_s IS NOT NULL AND v_ticket.activated_at IS NOT NULL THEN
      -- Borné par la validité du forfait : une activation datée dans le futur (horloge du
      -- nœud reculée, donnée corrompue) ne donne jamais plus que ce qui a été vendu.
      v_reste_validite := least(v_ticket.f_validity_s::numeric,
                                extract(epoch FROM v_ticket.activated_at) + v_ticket.f_validity_s - v_now);
      EXIT regles WHEN floor(v_reste_validite) < 1;
    END IF;
    IF v_ticket.expires_at IS NOT NULL THEN
      v_reste_expiration := extract(epoch FROM v_ticket.expires_at) - v_now;
      EXIT regles WHEN floor(v_reste_expiration) < 1;
    END IF;

    -- Consommation du ticket (ticket 05) : SOMME de toutes ses sessions, ouvertes ou arrêtées,
    -- tous routeurs et tous appareils confondus (décision de Yacouba du 11/11/2026).
    -- Une session ouverte compte jusqu'à son dernier Interim reçu.
    v_cause := 'epuise';
    SELECT coalesce(sum(s.duree_s::numeric), 0), coalesce(sum(s.octets_montants::numeric + s.octets_descendants), 0)
      INTO v_temps, v_octets
      FROM radius.session s WHERE s.voucher_id = v_ticket.id;
    EXIT regles WHEN v_ticket.f_uptime_limit_s IS NOT NULL AND v_temps >= v_ticket.f_uptime_limit_s;
    -- Volume total (les deux sens) : contrôle côté serveur, jamais envoyé au routeur (ADR 0006 §5, §6).
    EXIT regles WHEN v_ticket.f_data_limit_bytes IS NOT NULL AND v_octets >= v_ticket.f_data_limit_bytes;

    -- least() ignore les NULL : seules les dimensions présentes comptent.
    v_timeout := least(
      v_ticket.f_uptime_limit_s::numeric - v_temps,
      CASE WHEN v_ticket.activated_at IS NULL THEN v_ticket.f_validity_s::numeric ELSE v_reste_validite END,
      v_reste_expiration);
    EXIT regles WHEN v_timeout IS NULL OR v_timeout = 'Infinity'::numeric OR floor(v_timeout) < 1;

    -- Appareils (ticket 06, ADR 0006 §9), en dernier dans l'ordre de l'§4.
    v_cause := 'trop_d_appareils';
    -- bind_mac : le ticket est lié au premier appareil accepté. La MAC n'est jamais la seule clé.
    EXIT regles WHEN v_ticket.f_bind_mac AND v_ticket.mac_liee IS NOT NULL AND v_ticket.mac_liee <> v_mac;
    -- Appareils DISTINCTS (MAC normalisées), autres que celui qui se présente :
    --   sessions ouvertes du ticket
    --   + Accept récents sans Start correspondant, sur 60 s prolongées du retard du lecteur detail
    --     (battement, plafonné à 15 min).
    -- Une MAC vide (Calling-Station-Id absent ou illisible) n'est pas comptée : RouterOS l'envoie toujours.
    -- Retard COURANT = maintenant − avancement du lecteur : grandit aussi quand il est bloqué.
    v_fenetre := 60 + least(900, greatest(0, coalesce(extract(epoch FROM p_now - radius._avancement_lecteur()), 0)));
    SELECT count(DISTINCT x.mac) INTO v_autres FROM (
      SELECT radius._mac(s.calling_station) AS mac
        FROM radius.session s
       WHERE s.voucher_id = v_ticket.id
         AND radius._vivante(s.arrete_le, s.cause_fin, s.dernier_evenement_le, s.interim_s, p_now)
      UNION ALL
      SELECT a.mac FROM radius.auth_log a
       WHERE a.voucher_id = v_ticket.id AND a.resultat = 'Accept'
         AND a.at >= p_now - v_fenetre * interval '1 second'
         AND NOT EXISTS (SELECT 1 FROM radius.session s
                          WHERE s.voucher_id = a.voucher_id AND radius._mac(s.calling_station) = a.mac
                            AND s.started_at >= a.at - interval '5 seconds')
    ) x WHERE x.mac <> '' AND x.mac <> v_mac;
    EXIT regles WHEN v_autres >= v_ticket.f_devices;

    v_cause := NULL;
  END;

  IF v_cause IS NOT NULL THEN
    -- Un refus ne porte jamais d'attribut d'Accept (ADR 0006 §2).
    RETURN QUERY SELECT NULL::text, 'Reject'::text, v_cause,
                        NULL::bigint, NULL::text, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    v_ticket.code,
    'Accept'::text,
    NULL::text,
    least(floor(v_timeout), 2147483647)::bigint,
    v_ticket.f_rate_limit,
    v_ticket.f_devices,
    -- CHECK de radius.parametre : la conversion ne peut pas échouer.
    coalesce((SELECT p.valeur::integer FROM radius.parametre p WHERE p.cle = 'acct_interim_interval_s'), 120);
END;
$$;

-- post_auth : corps de 0027, plus la colonne forme_faible et l'alerte budget_routeur. Même signature et mêmes droits.
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

  -- bind_mac : posée au premier Accept (ADR 0006 §9).
  IF p_result = 'Accept' AND v_ticket.f_bind_mac AND v_ticket.mac_liee IS NULL AND v_mac <> '' THEN
    UPDATE app.voucher v SET mac_liee = v_mac WHERE v.id = v_ticket.id AND v.mac_liee IS NULL;
  END IF;
  RETURN 'ok';
END;
$$;

RESET ROLE;
