-- WAKATNET — migration 0005 : accounting découplé (phase 1, ticket 04).
-- Ticket : .scratch/phase-1-coeur-radius/issues/04-accounting-decouple.md
-- Contrats : ADR 0006 §1 (signatures), §7 (horloges), §8 (idempotence, compteurs,
-- activation), §12 (lecteur detail) ; ADR 0008 §2 (clé (id, started_at), acct_cle).
--
-- Appelées par le lecteur detail (serveur virtuel rejeu_accounting, rôle wk_acct),
-- jamais pendant l'authentification (règle 2, C3).
--   * Tous les paramètres sont du texte, analysés ici : une donnée invalide part en
--     quarantaine et la fonction renvoie 'quarantaine' au lieu de lever une exception,
--     qui bloquerait le lecteur sans fin. Aucune sous-transaction : validation par motifs.
--   * Seule une indisponibilité de la base (ou une base en lecture seule, nœud B) fait
--     échouer l'appel : FreeRADIUS ne répond pas au lecteur, qui réessaie (detail.c l. 76).
--   * Instant de l'événement = réception par le nœud (Packet-Original-Timestamp, époque en
--     secondes), jamais l'heure du rejeu ni l'Event-Timestamp du routeur (C4).

SET ROLE wakatnet_owner;

-- Sens des octets (C2) : Acct-Input-Octets compte ce que le routeur REÇOIT sur le port du
-- client (RFC 2866 §5.3), donc le trafic MONTANT du client. Valeur par défaut NON VÉRIFIÉE
-- sur RouterOS : à confirmer sur CHR (piste B, ticket 04).
ALTER TABLE radius.parametre ADD CONSTRAINT parametre_sens_octets
  CHECK (cle <> 'acct_input_octets_sens' OR valeur IN ('montant', 'descendant'));
INSERT INTO radius.parametre (cle, valeur) VALUES ('acct_input_octets_sens', 'montant');

-- Sessions. Clé (id, started_at) : compatible avec le partitionnement mensuel futur
-- (ADR 0008 §2). started_at = réception du PREMIER événement traité de la session.
CREATE TABLE radius.session (
  id                   bigint GENERATED ALWAYS AS IDENTITY,
  started_at           timestamptz NOT NULL,
  router_id            bigint NOT NULL REFERENCES app.router (id),
  router_epoch         bigint NOT NULL,
  acct_session_id      text   NOT NULL,
  tenant_id            bigint NOT NULL REFERENCES app.tenant (id),
  voucher_id           bigint NOT NULL REFERENCES app.voucher (id),
  calling_station      text,
  framed_ip            inet,
  octets_montants      bigint NOT NULL DEFAULT 0 CHECK (octets_montants >= 0),
  octets_descendants   bigint NOT NULL DEFAULT 0 CHECK (octets_descendants >= 0),
  duree_s              bigint NOT NULL DEFAULT 0 CHECK (duree_s >= 0),
  -- Intervalle d'Interim mémorisé à l'ouverture (sessions fantômes, ticket 06).
  interim_s            integer NOT NULL CHECK (interim_s > 0),
  dernier_evenement_le timestamptz NOT NULL,
  arrete_le            timestamptz,
  cause_fin            text,
  PRIMARY KEY (id, started_at)
);
CREATE INDEX session_ouvertes_par_ticket ON radius.session (voucher_id) WHERE arrete_le IS NULL;

-- Idempotence (ADR 0006 §8, ADR 0008 §2) : table NON partitionnée. username = code en
-- majuscules (les codes sont stockés en majuscules, ADR 0006 §15).
CREATE TABLE radius.acct_cle (
  router_id          bigint NOT NULL,
  router_epoch       bigint NOT NULL,
  acct_session_id    text   NOT NULL,
  username           text   NOT NULL,
  session_id         bigint NOT NULL,
  session_started_at timestamptz NOT NULL,
  PRIMARY KEY (router_id, router_epoch, acct_session_id, username),
  FOREIGN KEY (session_id, session_started_at) REFERENCES radius.session (id, started_at) ON DELETE CASCADE
);

-- Enregistrements refusés : conservés tels que reçus, pour analyse ; la file continue.
CREATE TABLE radius.acct_quarantaine (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recu_le  timestamptz NOT NULL DEFAULT now(),
  fonction text NOT NULL,
  motif    text NOT NULL,
  donnees  jsonb NOT NULL
);

-- Anomalies sans refus (ADR 0006 §8) : l'enregistrement est traité, mais signalé.
-- 'session_reutilisee' : même (routeur, époque, Acct-Session-Id) pour un autre ticket (LABO-18).
CREATE TABLE radius.acct_anomalie (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recu_le            timestamptz NOT NULL DEFAULT now(),
  motif              text NOT NULL,
  session_id         bigint NOT NULL,
  session_started_at timestamptz NOT NULL,
  donnees            jsonb NOT NULL
);

-- Événement d'activation, idempotent (un par ticket), lu en phase 3 par le grand livre
-- pour le frais papier (ADR 0002). Aucune clé étrangère vers session : la purge des
-- sessions ne doit pas toucher à un fait comptable.
CREATE TABLE radius.activation (
  voucher_id         bigint PRIMARY KEY REFERENCES app.voucher (id),
  tenant_id          bigint NOT NULL REFERENCES app.tenant (id),
  active_le          timestamptz NOT NULL,
  session_id         bigint NOT NULL,
  session_started_at timestamptz NOT NULL,
  inscrit_le         timestamptz NOT NULL DEFAULT now()
);

-- Entier RADIUS reçu en texte : '' ou NULL = absent = 0 ; sinon chiffres seulement, borné.
-- NULL = invalide (jamais d'exception).
CREATE FUNCTION radius._acct_entier(p text, p_max bigint)
RETURNS bigint
LANGUAGE sql IMMUTABLE
SET search_path = radius, pg_temp
AS $$
  SELECT CASE
           WHEN p IS NULL OR p = '' THEN 0
           WHEN p ~ '^[0-9]{1,10}$' AND p::bigint <= p_max THEN p::bigint
           ELSE NULL
         END;
$$;

CREATE FUNCTION radius._acct(p_type text, p_src text, p_session_id text, p_user text, p_calling text,
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

-- Points d'entrée du lecteur detail (ADR 0006 §1) : signatures publiques, toutes en texte.
CREATE FUNCTION radius.acct_start(p_src text, p_session_id text, p_user text, p_calling text, p_framed_ip text,
                                  p_in_oct text, p_in_giga text, p_out_oct text, p_out_giga text,
                                  p_session_time text, p_cause text, p_received_epoch text)
RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = radius, pg_temp
AS $$ SELECT radius._acct('start', p_src, p_session_id, p_user, p_calling, p_framed_ip, p_in_oct, p_in_giga,
                          p_out_oct, p_out_giga, p_session_time, p_cause, p_received_epoch) $$;

CREATE FUNCTION radius.acct_interim(p_src text, p_session_id text, p_user text, p_calling text, p_framed_ip text,
                                    p_in_oct text, p_in_giga text, p_out_oct text, p_out_giga text,
                                    p_session_time text, p_cause text, p_received_epoch text)
RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = radius, pg_temp
AS $$ SELECT radius._acct('interim', p_src, p_session_id, p_user, p_calling, p_framed_ip, p_in_oct, p_in_giga,
                          p_out_oct, p_out_giga, p_session_time, p_cause, p_received_epoch) $$;

CREATE FUNCTION radius.acct_stop(p_src text, p_session_id text, p_user text, p_calling text, p_framed_ip text,
                                 p_in_oct text, p_in_giga text, p_out_oct text, p_out_giga text,
                                 p_session_time text, p_cause text, p_received_epoch text)
RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = radius, pg_temp
AS $$ SELECT radius._acct('stop', p_src, p_session_id, p_user, p_calling, p_framed_ip, p_in_oct, p_in_giga,
                          p_out_oct, p_out_giga, p_session_time, p_cause, p_received_epoch) $$;

RESET ROLE;

-- Droits exacts (ADR 0006 §1, ADR 0008 §3 bis) : wk_acct n'exécute que les trois points
-- d'entrée ; il n'a aucun droit sur les tables, ni sur un futur schéma ledger.
REVOKE ALL ON FUNCTION radius._acct_entier(text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION radius._acct(text, text, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION radius.acct_start(text, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION radius.acct_interim(text, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION radius.acct_stop(text, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION radius.acct_start(text, text, text, text, text, text, text, text, text, text, text, text) TO wk_acct;
GRANT EXECUTE ON FUNCTION radius.acct_interim(text, text, text, text, text, text, text, text, text, text, text, text) TO wk_acct;
GRANT EXECUTE ON FUNCTION radius.acct_stop(text, text, text, text, text, text, text, text, text, text, text, text) TO wk_acct;

-- Borne d'une écriture d'accounting : hors chemin critique, plus large que wk_radius (500 ms).
ALTER ROLE wk_acct SET statement_timeout = '5s';
