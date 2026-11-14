-- WAKATNET — migration 0044 : anti-devinette par routeur pour les codes de forme faible (scan de sécurité du 13/11/2026, F3).
-- Le blocage de 0009 compte les échecs par (routeur, MAC) ; la MAC (Calling-Station-Id) est celle du client, qui la
-- change à volonté. Le seuil par routeur ne faisait qu'alerter. Les tickets importés de Mikhmon peuvent avoir 4 à 7
-- caractères (0017) : devinés en moins d'une minute par un client qui change de MAC. Désormais, pendant une attaque
-- (alerte « echecs_routeur » récente), les codes qui n'ont pas la forme d'un code de la plateforme, ou tout en chiffres,
-- sont refusés sur ce routeur. Contrat de
-- l'ADR 0006 §11 précisé (ADR 0011, addendum du 13/11/2026). Même signature et mêmes droits que 0009.
SET ROLE wakatnet_owner;

-- Recherche de l'alerte d'un routeur, appelée à chaque authorize d'un code de forme faible.
CREATE INDEX alerte_routeur_type_at ON radius.alerte (router_id, type, at);

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

    -- Scan de sécurité du 13/11/2026 (F3, migration 0044) : la MAC est choisie par le client ; en changeant de MAC, il
    -- échappait au blocage ci-dessus. Routeur SOUS ATTAQUE (alerte « echecs_routeur » des B dernières secondes, posée par
    -- post_auth au-delà de devinette_echecs_par_routeur échecs en F secondes) : les codes de FORME FAIBLE sont refusés,
    -- quelle que soit la MAC. Forme faible = tout ce qui n'a pas la forme d'un code de la plateforme (0017 :
    -- 8 à 16 caractères sur 31 symboles), plus les codes tout en chiffres (un ticket Mikhmon de 8 chiffres 2-9 a la forme
    -- d'un code de la plateforme). La décision ne dépend QUE de la saisie : refuser selon l'origine du ticket trouvé
    -- dirait à l'attaquant qu'il existe. Les codes de la plateforme restent servis ; les tickets importés, eux, peuvent
    -- être retenus par un client qui entretient l'alerte (assumé : ADR 0011, addendum).
    v_cause := 'trop_de_tentatives';
    IF v_code !~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8,16}$' OR v_code ~ '^[0-9]+$' THEN
      EXIT regles WHEN EXISTS (
        SELECT 1 FROM radius.alerte l
         WHERE l.type = 'echecs_routeur' AND l.router_id = v_routeur.id
           AND l.at >= p_now - radius._param_entier('devinette_blocage_s', 300) * interval '1 second'
           AND l.at <= p_now);
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
