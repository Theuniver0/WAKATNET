-- WAKATNET — migration 0009 : anti-devinette, alertes, purge du journal (phase 1, ticket 07).
-- Ticket : .scratch/phase-1-coeur-radius/issues/07-anti-devinette.md
-- Contrats : ADR 0006 §4 (trop_de_tentatives en tête), §10, §11 ; ADR 0005 (auth_log : 90 jours).
-- Remplace radius._authorize_at et radius.post_auth (0008), mêmes signatures et droits.

SET ROLE wakatnet_owner;

-- Seuils réglables (C2 : en SQL, pas en unlang).
ALTER TABLE radius.parametre ADD CONSTRAINT parametre_seuils_entiers
  CHECK (cle NOT LIKE 'devinette\_%' OR valeur ~ '^[1-9][0-9]{0,5}$');
INSERT INTO radius.parametre (cle, valeur) VALUES
  ('devinette_echecs_par_mac', '10'),       -- échecs « ticket_inconnu » d'une MAC sur un routeur…
  ('devinette_fenetre_s', '60'),            -- … en 60 s …
  ('devinette_blocage_s', '300'),           -- … donnent un blocage de 5 min (trop_de_tentatives)
  ('devinette_echecs_par_routeur', '100');  -- 100 échecs d'un routeur en 60 s : alerte seule

-- Paramètre entier, avec une valeur par défaut si absent (le CHECK garantit la conversion).
CREATE FUNCTION radius._param_entier(p_cle text, p_defaut integer)
RETURNS integer
LANGUAGE sql STABLE
SET search_path = radius, pg_temp
AS $$
  SELECT coalesce((SELECT p.valeur::integer FROM radius.parametre p WHERE p.cle = p_cle), p_defaut);
$$;

-- Alertes pour le futur worker (supervision, §10.3). Jamais de code de ticket.
CREATE TABLE radius.alerte (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  type       text NOT NULL CHECK (type IN ('blocage_mac', 'echecs_routeur')),
  router_id  bigint REFERENCES app.router (id),
  tenant_id  bigint REFERENCES app.tenant (id),
  mac        text,
  traitee_le timestamptz
);
CREATE INDEX alerte_a_traiter ON radius.alerte (at) WHERE traitee_le IS NULL;
-- Échecs comptés par l'anti-devinette (revue du ticket 07 : l'index filtre aussi la cause).
CREATE INDEX auth_log_echecs_mac ON radius.auth_log (router_id, mac, at)
  WHERE resultat = 'Reject' AND cause = 'ticket_inconnu';
CREATE INDEX auth_log_echecs_routeur ON radius.auth_log (router_id, at)
  WHERE resultat = 'Reject' AND cause = 'ticket_inconnu';
-- Purge par instant (revue du ticket 07) : sans cet index, chaque purge lirait toute la table.
CREATE INDEX auth_log_at ON radius.auth_log (at);

-- Purge du journal à 90 jours (ADR 0005), rôle wk_maint. PAR LOTS (revue du ticket 07) : chaque
-- appel supprime au plus p_lot lignes, par l'index sur at, et tient sous le statement_timeout
-- de wk_maint (30 s) ; le script rappelle la fonction tant qu'un lot est plein, donc un retard
-- se rattrape. Idempotente. Chaque appel est journalisé dans app.audit_log, avec le rôle
-- réellement connecté (session_user). Purge aussi les alertes de plus de 90 jours (elles portent la MAC).
CREATE FUNCTION radius.purge_auth_log(p_lot integer DEFAULT 50000)
RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = radius, pg_temp
AS $$
DECLARE
  v_seuil timestamptz := now() - interval '90 days';
  v_n     bigint;
  v_al    bigint;
BEGIN
  DELETE FROM radius.auth_log a
   WHERE a.id IN (SELECT x.id FROM radius.auth_log x WHERE x.at < v_seuil
                  ORDER BY x.at LIMIT greatest(1, least(coalesce(p_lot, 50000), 500000)));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM radius.alerte l WHERE l.at < v_seuil;
  GET DIAGNOSTICS v_al = ROW_COUNT;
  INSERT INTO app.audit_log (acteur, action, objet, details)
  VALUES (session_user, 'purge_auth_log', 'radius.auth_log',
          jsonb_build_object('supprimees', v_n, 'alertes_supprimees', v_al, 'avant', v_seuil, 'lot', p_lot));
  RETURN v_n;
END;
$$;

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
    IF v_mac <> ''
       AND (SELECT count(*) FROM radius.auth_log a
             WHERE a.router_id = v_routeur.id AND a.mac = v_mac AND a.resultat = 'Reject'
               AND a.cause = 'ticket_inconnu'
               AND a.at >= now() - radius._param_entier('devinette_fenetre_s', 60) * interval '1 second')
           >= radius._param_entier('devinette_echecs_par_mac', 10)
       AND NOT EXISTS (SELECT 1 FROM radius.alerte l
                        WHERE l.type = 'blocage_mac' AND l.router_id = v_routeur.id AND l.mac = v_mac
                          AND l.at >= now() - radius._param_entier('devinette_blocage_s', 300) * interval '1 second') THEN
      INSERT INTO radius.alerte (type, router_id, tenant_id, mac) VALUES ('blocage_mac', v_routeur.id, v_routeur.tenant_id, v_mac);
    END IF;
    IF (SELECT count(*) FROM radius.auth_log a
         WHERE a.router_id = v_routeur.id AND a.resultat = 'Reject' AND a.cause = 'ticket_inconnu'
           AND a.at >= now() - radius._param_entier('devinette_fenetre_s', 60) * interval '1 second')
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

    v_cause := 'ticket_inconnu';
    -- Ticket : clé (propriétaire, code), jamais le code seul (ADR 0006 §3, T6).
    SELECT * INTO v_ticket FROM app.voucher v WHERE v.tenant_id = v_routeur.tenant_id AND v.code = v_code;
    EXIT regles WHEN NOT FOUND;

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

RESET ROLE;

REVOKE ALL ON FUNCTION radius._param_entier(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION radius.purge_auth_log(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION radius.purge_auth_log(integer) TO wk_maint;
