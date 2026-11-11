-- WAKATNET — migration 0008 : post_auth et auth_log, appareils simultanés, bind_mac, sessions
-- fantômes, Accounting-On/Off (phase 1, ticket 06).
-- Ticket : .scratch/phase-1-coeur-radius/issues/06-sessions.md
-- Décision de Yacouba du 11/11/2026 : post_auth et auth_log avancés du ticket 07 au ticket 06.
-- Contrats : ADR 0006 §1, §4 (trop_d_appareils, en dernier), §8, §9, §10, §17 ; ADR 0008 §2.

-- Rôle des tâches planifiées (ADR 0006 §1, §17) : n'exécute que close_ghost_sessions (et la
-- purge au ticket 07). Mot de passe posé par migrer.sh (WAKATNET_PG_MAINT_PASSWORD).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wk_maint') THEN
    CREATE ROLE wk_maint LOGIN;
  END IF;
END $$;

SET ROLE wakatnet_owner;

-- MAC normalisée : 12 chiffres hexadécimaux en majuscules, sinon '' (illisible ou absente).
CREATE FUNCTION radius._mac(p text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = radius, pg_temp
AS $$
  SELECT CASE WHEN length(x) = 12 THEN x ELSE '' END
    FROM (SELECT upper(regexp_replace(coalesce(p, ''), '[^0-9A-Fa-f]', '', 'g')) AS x) t;
$$;

-- Journal des tentatives (ADR 0006 §10) : Accept et Reject. JAMAIS le code du ticket.
-- voucher_id seulement si le code existe pour le propriétaire du routeur (T6 : NULL).
CREATE TABLE radius.auth_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  router_id   bigint REFERENCES app.router (id),
  tenant_id   bigint REFERENCES app.tenant (id),
  mac         text NOT NULL,
  resultat    text NOT NULL CHECK (resultat IN ('Accept', 'Reject')),
  cause       text,
  voucher_id  bigint REFERENCES app.voucher (id)
);
CREATE INDEX auth_log_accept_par_ticket ON radius.auth_log (voucher_id, at) WHERE resultat = 'Accept';
-- Anti-devinette (ticket 07) : échecs par routeur et par MAC sur une fenêtre.
CREATE INDEX auth_log_routeur_mac_at ON radius.auth_log (router_id, mac, at);

-- Avancement du lecteur detail (ADR 0006 §9, §17 ; revue du ticket 06). Le spool est rejoué
-- dans l'ordre de réception, donc tout enregistrement reçu avant l'AVANCEMENT est traité :
--   avancement = le plus tardif de
--     * dernier_recu  : réception du dernier enregistrement traité (écrit par _acct, acct_on_off) ;
--     * spool_vide_le : instant, relevé AVANT de regarder, où le spool a été vu vide
--                       (écrit par le timer wakatnet-fantomes via marquer_spool_vide).
-- Retard courant = maintenant − avancement : il grandit aussi quand le lecteur est bloqué.
-- Le repère ne recule jamais et ne dépasse jamais l'heure de la base (instant de réception
-- invalide ou futur : jamais pris pour un avancement).
CREATE TABLE radius.lecteur_battement (
  une           boolean PRIMARY KEY DEFAULT true CHECK (une),
  dernier_recu  timestamptz NOT NULL,
  traite_le     timestamptz NOT NULL,
  spool_vide_le timestamptz NOT NULL
);
INSERT INTO radius.lecteur_battement (dernier_recu, traite_le, spool_vide_le) VALUES (now(), now(), now());

CREATE FUNCTION radius._avancement_lecteur()
RETURNS timestamptz
LANGUAGE sql STABLE
SET search_path = radius, pg_temp
AS $$
  SELECT greatest(b.dernier_recu, b.spool_vide_le) FROM radius.lecteur_battement b;
$$;

-- Session encore vivante (revue du ticket 06) : ouverte, ou fermée d'office (Fantome) mais qui
-- a reparlé depuis, et récemment. Elle compte comme appareil et peut être inscrite « à couper ».
CREATE FUNCTION radius._vivante(p_arrete timestamptz, p_cause text, p_dernier timestamptz,
                                p_interim integer, p_now timestamptz)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = radius, pg_temp
AS $$
  SELECT p_arrete IS NULL
      OR (p_cause = 'Fantome' AND p_dernier > p_arrete
          AND p_dernier >= p_now - 3 * p_interim * interval '1 second');
$$;

-- Appelée par le timer quand il voit le spool vide ; p_epoch = instant relevé AVANT la vérification.
CREATE FUNCTION radius.marquer_spool_vide(p_epoch text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = radius, pg_temp
AS $$
BEGIN
  IF p_epoch IS NULL OR p_epoch !~ '^[0-9]{1,11}$' THEN
    RETURN 'invalide';
  END IF;
  UPDATE radius.lecteur_battement
     SET spool_vide_le = greatest(spool_vide_le, least(to_timestamp(p_epoch::bigint), now()));
  RETURN 'ok';
END;
$$;

-- post_auth (ADR 0006 §1, §10) : appelée par FreeRADIUS en post-auth, Accept comme Reject.
-- Son échec est sans effet sur la réponse (configuration du site wakatnet). Renvoie 'ok'
-- (rlm_sql_map exige une ligne). p_src en texte : une valeur invalide ne lève rien.
CREATE FUNCTION radius.post_auth(p_user text, p_src text, p_calling text, p_result text, p_cause text)
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
  -- bind_mac : posée au premier Accept (ADR 0006 §9).
  IF p_result = 'Accept' AND v_ticket.f_bind_mac AND v_ticket.mac_liee IS NULL AND v_mac <> '' THEN
    UPDATE app.voucher v SET mac_liee = v_mac WHERE v.id = v_ticket.id AND v.mac_liee IS NULL;
  END IF;
  RETURN 'ok';
END;
$$;

-- Sessions fantômes (ADR 0006 §8) : fermées sans Interim depuis 3 intervalles mémorisés,
-- mesurés par rapport à l'AVANCEMENT du lecteur, et non à l'heure courante : un Interim encore
-- dans le spool a été reçu après l'avancement, donc ne peut pas faire fermer sa session
-- (revue du ticket 06 ; remplace la condition « spool vide » du §17, qui affamait la fermeture).
-- Arrêt daté du dernier événement : le temps consommé jusqu'au dernier Interim est conservé.
CREATE FUNCTION radius.close_ghost_sessions()
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = radius, pg_temp
AS $$
  WITH fermees AS (
    UPDATE radius.session s SET arrete_le = s.dernier_evenement_le, cause_fin = 'Fantome'
     WHERE s.arrete_le IS NULL
       AND s.dernier_evenement_le < radius._avancement_lecteur() - 3 * s.interim_s * interval '1 second'
    RETURNING 1)
  SELECT count(*)::integer FROM fermees;
$$;

-- Accounting-On / Off (ADR 0006 §1, §8) : ferme les sessions ouvertes de l'époque courante
-- démarrées au plus tard à la réception, puis incrémente l'époque. Un On déjà traité (même
-- instant de réception ou plus ancien) est sans effet : rejouer le spool ne ferme jamais les
-- sessions ouvertes depuis.
CREATE FUNCTION radius.acct_on_off(p_src text, p_received_epoch text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = radius, pg_temp
AS $$
DECLARE
  v_routeur app.router%ROWTYPE;
  v_recu    timestamptz;
BEGIN
  IF p_src IS NOT NULL AND pg_input_is_valid(p_src, 'inet') THEN
    -- FOR NO KEY UPDATE : sérialise les On d'un routeur sans bloquer les clés étrangères
    -- (auth_log, session) qui prennent FOR KEY SHARE sur ce routeur (revue du ticket 06).
    SELECT * INTO v_routeur FROM app.router r WHERE r.overlay_ip = p_src::inet FOR NO KEY UPDATE;
  END IF;
  IF v_routeur.id IS NULL OR p_received_epoch IS NULL OR p_received_epoch !~ '^[0-9]{1,11}$' THEN
    INSERT INTO radius.acct_quarantaine (fonction, motif, donnees)
    VALUES ('acct_on_off', CASE WHEN v_routeur.id IS NULL THEN 'routeur_inconnu' ELSE 'donnee_invalide' END,
            jsonb_build_object('p_src', p_src, 'p_received_epoch', p_received_epoch));
    RETURN 'quarantaine';
  END IF;
  v_recu := to_timestamp(p_received_epoch::bigint);
  UPDATE radius.lecteur_battement SET dernier_recu = greatest(dernier_recu, least(v_recu, now())), traite_le = now();
  IF v_routeur.dernier_acct_on_le IS NOT NULL AND v_recu <= v_routeur.dernier_acct_on_le THEN
    RETURN 'ok';
  END IF;
  UPDATE radius.session s SET arrete_le = greatest(s.dernier_evenement_le, s.started_at), cause_fin = 'Accounting-On'
   WHERE s.router_id = v_routeur.id AND s.router_epoch = v_routeur.epoch
     AND s.arrete_le IS NULL AND s.started_at <= v_recu;
  UPDATE app.router r SET epoch = r.epoch + 1, dernier_acct_on_le = v_recu WHERE r.id = v_routeur.id;
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

CREATE OR REPLACE FUNCTION radius._acct(p_type text, p_src text, p_session_id text, p_user text, p_calling text,
                             p_framed_ip text, p_in_oct text, p_in_giga text, p_out_oct text,
                             p_out_giga text, p_session_time text, p_cause text, p_received_epoch text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = radius, pg_temp
AS $$
DECLARE
  c_max32     constant bigint := 4294967295;
  -- Gigawords bornés pour que giga × 2^32 + octets tienne dans un bigint :
  -- 2147483647 × 2^32 + 4294967295 = 2^63 − 1 (au-delà : 'donnee_invalide', jamais une exception).
  c_max_giga  constant bigint := 2147483647;
  v_fonction  text := 'acct_' || p_type;
  v_motif     text;
  v_routeur   app.router%ROWTYPE;
  v_ticket    app.voucher%ROWTYPE;
  v_sid       text := p_session_id;
  v_user      text := upper(coalesce(p_user, ''));
  v_recu      timestamptz;
  v_framed    inet;
  v_in        bigint;
  v_out       bigint;
  v_duree     bigint;
  v_montants  bigint;
  v_descend   bigint;
  v_session   bigint;
  v_debut     timestamptz;
  v_temps     numeric;   -- numeric : une somme de bigint peut dépasser 2^63 − 1 (revue du ticket 05)
  v_octets    numeric;
  v_motif_cut text;
BEGIN
  -- Chaque étape pose le motif de quarantaine qu'elle produirait, puis sort si invalide.
  <<regles>>
  BEGIN
    -- Routeur : identifié par son IP source (§5.1), actif ou non : la consommation d'une
    -- session ouverte avant une désactivation reste comptée.
    v_motif := 'routeur_inconnu';
    EXIT regles WHEN p_src IS NULL OR NOT pg_input_is_valid(p_src, 'inet');
    SELECT * INTO v_routeur FROM app.router r WHERE r.overlay_ip = p_src::inet;
    EXIT regles WHEN NOT FOUND;

    v_motif := 'session_invalide';
    EXIT regles WHEN v_sid IS NULL OR length(v_sid) NOT BETWEEN 1 AND 64;
    v_motif := 'utilisateur_invalide';
    EXIT regles WHEN length(v_user) NOT BETWEEN 1 AND 64;

    v_motif := 'donnee_invalide';
    -- Compteurs : giga × 2^32 + octets, pour chaque sens (ADR 0006 §8).
    v_in    := radius._acct_entier(p_in_giga, c_max_giga) * (c_max32 + 1) + radius._acct_entier(p_in_oct, c_max32);
    v_out   := radius._acct_entier(p_out_giga, c_max_giga) * (c_max32 + 1) + radius._acct_entier(p_out_oct, c_max32);
    v_duree := radius._acct_entier(p_session_time, c_max32);
    EXIT regles WHEN v_in IS NULL OR v_out IS NULL OR v_duree IS NULL;
    EXIT regles WHEN p_received_epoch IS NULL OR p_received_epoch !~ '^[0-9]{1,11}$';
    v_recu := to_timestamp(p_received_epoch::bigint);
    IF coalesce(p_framed_ip, '') <> '' THEN
      EXIT regles WHEN NOT pg_input_is_valid(p_framed_ip, 'inet');
      v_framed := p_framed_ip::inet;
    END IF;

    -- Ticket : clé (propriétaire du routeur, code), jamais le code seul (ADR 0006 §3).
    v_motif := 'ticket_inconnu';
    SELECT * INTO v_ticket FROM app.voucher v WHERE v.tenant_id = v_routeur.tenant_id AND v.code = v_user;
    EXIT regles WHEN NOT FOUND;

    v_motif := NULL;
  END;

  -- Battement du lecteur (ADR 0006 §9) : retard = traitement − réception du dernier enregistrement.
  IF v_recu IS NOT NULL THEN
    UPDATE radius.lecteur_battement SET dernier_recu = greatest(dernier_recu, least(v_recu, now())), traite_le = now();
  END IF;

  IF v_motif IS NOT NULL THEN
    INSERT INTO radius.acct_quarantaine (fonction, motif, donnees)
    VALUES (v_fonction, v_motif, jsonb_build_object(
      'p_src', p_src, 'p_session_id', p_session_id, 'p_user', p_user, 'p_calling', p_calling,
      'p_framed_ip', p_framed_ip, 'p_in_oct', p_in_oct, 'p_in_giga', p_in_giga, 'p_out_oct', p_out_oct,
      'p_out_giga', p_out_giga, 'p_session_time', p_session_time, 'p_cause', p_cause,
      'p_received_epoch', p_received_epoch));
    RETURN 'quarantaine';
  END IF;

  -- Sens des octets (C2).
  IF (SELECT p.valeur FROM radius.parametre p WHERE p.cle = 'acct_input_octets_sens') = 'descendant' THEN
    v_montants := v_out; v_descend := v_in;
  ELSE
    v_montants := v_in;  v_descend := v_out;
  END IF;

  -- Une seule ouverture par clé, même si deux rejeux arrivaient en même temps.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    v_routeur.id || '/' || v_routeur.epoch || '/' || v_sid || '/' || v_user, 0));
  SELECT k.session_id, k.session_started_at INTO v_session, v_debut
    FROM radius.acct_cle k
   WHERE k.router_id = v_routeur.id AND k.router_epoch = v_routeur.epoch
     AND k.acct_session_id = v_sid AND k.username = v_user;
  IF NOT FOUND THEN
    -- Start, ou premier événement reçu d'une session dont le Start est perdu.
    INSERT INTO radius.session (started_at, router_id, router_epoch, acct_session_id, tenant_id, voucher_id,
                                calling_station, framed_ip, interim_s, dernier_evenement_le)
    VALUES (v_recu, v_routeur.id, v_routeur.epoch, v_sid, v_routeur.tenant_id, v_ticket.id,
            left(p_calling, 64), v_framed,
            coalesce((SELECT p.valeur::integer FROM radius.parametre p WHERE p.cle = 'acct_interim_interval_s'), 120),
            v_recu)
    RETURNING id, started_at INTO v_session, v_debut;
    INSERT INTO radius.acct_cle (router_id, router_epoch, acct_session_id, username, session_id, session_started_at)
    VALUES (v_routeur.id, v_routeur.epoch, v_sid, v_user, v_session, v_debut);
    -- Même identifiant déjà vu pour un AUTRE ticket sur ce routeur et cette époque :
    -- session distincte (clé avec username), mais anomalie signalée (ADR 0006 §8, LABO-18).
    IF EXISTS (SELECT 1 FROM radius.acct_cle k
                WHERE k.router_id = v_routeur.id AND k.router_epoch = v_routeur.epoch
                  AND k.acct_session_id = v_sid AND k.username <> v_user) THEN
      INSERT INTO radius.acct_anomalie (motif, session_id, session_started_at, donnees)
      VALUES ('session_reutilisee', v_session, v_debut,
              jsonb_build_object('router_id', v_routeur.id, 'router_epoch', v_routeur.epoch, 'acct_session_id', v_sid));
    END IF;
  END IF;

  -- Compteurs : maximum cumulé, jamais une addition (rejeu, désordre, doublons).
  -- Une session arrêtée n'est jamais rouverte ; le premier Stop fixe l'arrêt et sa cause.
  UPDATE radius.session s SET
    octets_montants      = greatest(s.octets_montants, v_montants),
    octets_descendants   = greatest(s.octets_descendants, v_descend),
    duree_s              = greatest(s.duree_s, v_duree),
    dernier_evenement_le = greatest(s.dernier_evenement_le, v_recu),
    -- Un vrai Stop après une fermeture d'office (Fantome) corrige l'arrêt et sa cause ; il ne
    -- rouvre rien (revue du ticket 06).
    arrete_le            = CASE WHEN p_type = 'stop' AND s.cause_fin = 'Fantome' THEN v_recu
                                WHEN p_type = 'stop' THEN coalesce(s.arrete_le, v_recu) ELSE s.arrete_le END,
    cause_fin            = CASE WHEN p_type = 'stop' AND (s.arrete_le IS NULL OR s.cause_fin = 'Fantome')
                                THEN nullif(left(p_cause, 64), '')
                                ELSE s.cause_fin END
   WHERE s.id = v_session AND s.started_at = v_debut;

  -- Épuisement (ticket 05, ADR 0006 §6) : temps ou volume du ticket atteint, toutes sessions
  -- confondues. Les sessions encore OUVERTES du ticket sont inscrites « à couper » ; le
  -- Disconnect est émis au ticket 09. Posé une seule fois (instant et motif conservés).
  SELECT coalesce(sum(s.duree_s::numeric), 0), coalesce(sum(s.octets_montants::numeric + s.octets_descendants), 0)
    INTO v_temps, v_octets
    FROM radius.session s WHERE s.voucher_id = v_ticket.id;
  v_motif_cut := CASE
    WHEN v_ticket.f_data_limit_bytes IS NOT NULL AND v_octets >= v_ticket.f_data_limit_bytes THEN 'volume_epuise'
    WHEN v_ticket.f_uptime_limit_s IS NOT NULL AND v_temps >= v_ticket.f_uptime_limit_s THEN 'temps_epuise'
  END;
  IF v_motif_cut IS NOT NULL THEN
    UPDATE radius.session s SET a_couper_le = v_recu, motif_coupure = v_motif_cut
     WHERE s.voucher_id = v_ticket.id AND s.a_couper_le IS NULL
       AND radius._vivante(s.arrete_le, s.cause_fin, s.dernier_evenement_le, s.interim_s, v_recu);
  END IF;

  -- bind_mac (ADR 0006 §9) : posée aussi par l'accounting si post_auth n'a pas pu l'écrire.
  IF v_ticket.f_bind_mac AND v_ticket.mac_liee IS NULL AND radius._mac(p_calling) <> '' THEN
    UPDATE app.voucher v SET mac_liee = radius._mac(p_calling) WHERE v.id = v_ticket.id AND v.mac_liee IS NULL;
  END IF;

  -- Activation : au premier événement TRAITÉ du ticket (normalement le Start), à l'instant
  -- de RÉCEPTION de cet événement. Posée une seule fois ; l'événement comptable aussi.
  -- Start perdu : l'activation vaut la réception du premier Interim ou Stop, donc en retard
  -- d'au plus un intervalle d'Interim (ou de la session entière sans Interim), au bénéfice
  -- du client (ADR 0006, amendement du ticket 04).
  UPDATE app.voucher v SET activated_at = v_recu WHERE v.id = v_ticket.id AND v.activated_at IS NULL;
  IF FOUND THEN
    INSERT INTO radius.activation (voucher_id, tenant_id, active_le, session_id, session_started_at)
    VALUES (v_ticket.id, v_ticket.tenant_id, v_recu, v_session, v_debut)
    ON CONFLICT (voucher_id) DO NOTHING;
  END IF;

  RETURN 'ok';
END;
$$;

RESET ROLE;

REVOKE ALL ON FUNCTION radius._mac(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION radius.post_auth(text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION radius.close_ghost_sessions() FROM PUBLIC;
REVOKE ALL ON FUNCTION radius._avancement_lecteur() FROM PUBLIC;
REVOKE ALL ON FUNCTION radius._vivante(timestamptz, text, timestamptz, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION radius.marquer_spool_vide(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION radius.acct_on_off(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION radius.post_auth(text, text, text, text, text) TO wk_radius;
GRANT EXECUTE ON FUNCTION radius.acct_on_off(text, text) TO wk_acct;
GRANT USAGE ON SCHEMA radius TO wk_maint;
GRANT EXECUTE ON FUNCTION radius.close_ghost_sessions() TO wk_maint;
GRANT EXECUTE ON FUNCTION radius.marquer_spool_vide(text) TO wk_maint;
ALTER ROLE wk_maint SET statement_timeout = '30s';
