-- WAKATNET — migration 0006 : temps, validité et volume restants ; épuisement (phase 1, ticket 05).
-- Ticket : .scratch/phase-1-coeur-radius/issues/05-compteurs.md
-- Contrats : ADR 0006 §4 (epuise), §5 (Session-Timeout), §6 (volume côté serveur) ; ADR 0007.
-- Décisions de Yacouba du 11/11/2026 :
--   * temps consommé = SOMME des sessions du ticket (tous appareils, tous routeurs) ;
--   * forfaits à sens séparés reportés : seul le volume total existe (ADR 0006 §5).
--
-- Remplace radius._authorize_at (0004) et radius._acct (0005), mêmes signatures :
-- propriétaire, droits, SECURITY DEFINER et search_path conservés. Seuls changent :
--   * _authorize_at : « epuise » si temps consommé >= uptime ou volume >= data_limit ;
--     Session-Timeout = plancher(min(uptime − temps consommé, validité restante, expiration restante)) ;
--   * _acct : inscrit « à couper » les sessions ouvertes du ticket dès que le temps ou le
--     volume est atteint (Disconnect au ticket 09).
-- Dépassement du volume : borné seulement si le forfait a un débit et si les Interim arrivent ;
-- voir ADR 0006, amendement du ticket 05. La consommation est la somme des sessions : aucune
-- session d'un ticket encore utilisable ne doit être purgée.

SET ROLE wakatnet_owner;

ALTER TABLE radius.session
  ADD COLUMN a_couper_le   timestamptz,
  ADD COLUMN motif_coupure text CHECK (motif_coupure IN ('volume_epuise', 'temps_epuise')),
  ADD CONSTRAINT session_coupure_coherente CHECK ((a_couper_le IS NULL) = (motif_coupure IS NULL));
-- Consommation d'un ticket, lue à chaque Access-Request : toutes ses sessions (quelques-unes
-- par ticket). Sans INCLUDE : les compteurs, modifiés à chaque Interim, ne sont dans aucun
-- index, ce qui garde les mises à jour HOT possibles (revue du ticket 05).
CREATE INDEX session_par_ticket ON radius.session (voucher_id);
-- Sessions à couper (lues par le déclencheur du ticket 09).
CREATE INDEX session_a_couper ON radius.session (a_couper_le) WHERE a_couper_le IS NOT NULL AND arrete_le IS NULL;

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
    arrete_le            = CASE WHEN p_type = 'stop' THEN coalesce(s.arrete_le, v_recu) ELSE s.arrete_le END,
    cause_fin            = CASE WHEN p_type = 'stop' AND s.arrete_le IS NULL THEN nullif(left(p_cause, 64), '')
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
     WHERE s.voucher_id = v_ticket.id AND s.arrete_le IS NULL AND s.a_couper_le IS NULL;
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
