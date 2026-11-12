-- WAKATNET — migration 0034 : fournisseur d'e-mail branché, et les protections exigées par l'ADR 0017.
-- Ticket : docs/adr/0019-fournisseur-email.md ; docs/REVUE_SECURITE.md (M4, F9).
--
--   - inscription sans session, réponse identique que l'adresse existe ou non (F9), 5 par heure et par source ;
--   - connexion refusée à un propriétaire dont l'adresse n'est pas confirmée (même réponse qu'un mauvais mot de passe) ;
--   - renvoi du lien sans session, 5 par heure et par source ;
--   - quota de 2 routeurs pour un compte neuf ; 10 dès que le super-admin le valide ;
--   - comptes non validés : plafond global de 100 routeurs enrôlés par jour, arrêt au-delà de 90 % de l'overlay.
-- Relue par un second agent (règle 4) : avis compté à part (un tiers ne bloque plus un compte neuf), plafond global
-- de 200 e-mails par jour, adresse libérée après 7 jours sans confirmation, quota de 2 appliqué aux comptes
-- existants non validés, app.inscription retirée à wk_api, plafond compté en routeurs enrôlés.

SET ROLE wakatnet_owner;

ALTER TABLE app.tenant ALTER COLUMN quota_routeurs SET DEFAULT 2;
ALTER TABLE app.tenant ADD COLUMN valide_admin boolean NOT NULL DEFAULT false;
-- Comptes existants dont l'adresse est confirmée : réputés validés (ils ont été vus avant cette migration).
UPDATE app.tenant t SET valide_admin = true
 WHERE EXISTS (SELECT 1 FROM app.utilisateur u WHERE u.tenant_id = t.id AND u.role = 'proprietaire' AND u.email_verifie_le IS NOT NULL);
-- Les autres passent au quota d'un compte neuf (relecture : sinon un compte ouvert avant cette migration garderait 10).
UPDATE app.tenant SET quota_routeurs = least(quota_routeurs, 2) WHERE NOT valide_admin;

-- Avis « un compte existe déjà » : compté À PART des liens de confirmation (relecture : sinon 5 avis provoqués par un
-- tiers épuisaient les liens d'un compte neuf, bloqué pour toujours). 1 par jour et par compte.
CREATE TABLE app.avis_envoye (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  utilisateur_id bigint NOT NULL REFERENCES app.utilisateur (id) ON DELETE CASCADE,
  le             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX avis_envoye_utilisateur ON app.avis_envoye (utilisateur_id, le);
ALTER TABLE app.avis_envoye ENABLE ROW LEVEL SECURITY;           -- aucune politique : fonctions seulement

-- Plafond global d'e-mails : 200 par 24 h glissantes (le quota gratuit de Brevo est de 300 par jour ; un envoi en
-- masse vers des tiers s'arrête ici). Alerte de santé à 80 %.
CREATE TABLE app.courriel_envoye (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  le timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX courriel_envoye_le ON app.courriel_envoye (le);
ALTER TABLE app.courriel_envoye ENABLE ROW LEVEL SECURITY;       -- aucune politique : fonctions seulement

CREATE FUNCTION app.courriel_reserver()
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('wakatnet_courriel'));
  IF (SELECT count(*) FROM app.courriel_envoye WHERE le > now() - interval '24 hours') >= 200 THEN RETURN false; END IF;
  INSERT INTO app.courriel_envoye DEFAULT VALUES;
  DELETE FROM app.courriel_envoye WHERE le < now() - interval '2 days';
  RETURN true;
END;
$$;

-- Demandes publiques comptées par source (HMAC du jour, jamais l'IP) : inscriptions et renvois de lien.
CREATE TABLE app.source_demande (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nature text   NOT NULL CHECK (nature IN ('inscription', 'renvoi')),
  source text   NOT NULL,
  le     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX source_demande_source ON app.source_demande (nature, source, le);
CREATE INDEX source_demande_le ON app.source_demande (le);
ALTER TABLE app.source_demande ENABLE ROW LEVEL SECURITY;        -- aucune politique : fonctions seulement

-- true si la source a encore droit à une demande de cette nature (5 par heure), et la compte. Verrou par source.
CREATE FUNCTION app._source_admise(p_nature text, p_source text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE
SET search_path = app, pg_temp
AS $$
DECLARE
  v_source text := left(coalesce(nullif(p_source, ''), '?'), 64);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('wakatnet_source:' || p_nature || ':' || v_source));
  IF (SELECT count(*) FROM app.source_demande d WHERE d.nature = p_nature AND d.source = v_source
        AND d.le > now() - interval '1 hour') >= 5 THEN
    RETURN false;
  END IF;
  INSERT INTO app.source_demande (nature, source) VALUES (p_nature, v_source);
  DELETE FROM app.source_demande WHERE le < now() - interval '1 day';
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app._source_admise(text, text) FROM PUBLIC;

-- Inscription (ADR 0019) : 'cree' (compte neuf, utilisateur à qui envoyer le lien), 'existe' (adresse déjà inscrite :
-- utilisateur à qui envoyer un avis), 'trop' (5 inscriptions dans l'heure pour cette source). L'API répond pareil
-- pour 'cree' et 'existe'.
CREATE FUNCTION app.inscription_demander(p_nom_proprietaire text, p_email text, p_mot_de_passe text, p_source text)
RETURNS TABLE (statut text, utilisateur_id bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_u bigint;
  r record;
BEGIN
  IF NOT app._source_admise('inscription', p_source) THEN
    RETURN QUERY SELECT 'trop'::text, NULL::bigint; RETURN;
  END IF;
  -- Adresse libérée (relecture) : un propriétaire jamais confirmé au bout de 7 jours perd l'adresse, qui devient
  -- factice ; son compte est désactivé (rien n'est effacé : audit et clés étrangères intacts). 100 au plus par appel.
  UPDATE app.utilisateur u SET email = 'purge-' || u.id || '@wakatnet.invalid', actif = false
   WHERE u.id IN (SELECT x.id FROM app.utilisateur x WHERE x.role = 'proprietaire' AND x.email_verifie_le IS NULL
                     AND x.cree_le < now() - interval '7 days' AND x.email NOT LIKE '%@wakatnet.invalid' LIMIT 100);
  SELECT u.id INTO v_u FROM app.utilisateur u WHERE u.email = lower(left(p_email, 254));
  IF FOUND THEN
    RETURN QUERY SELECT 'existe'::text, v_u; RETURN;
  END IF;
  BEGIN
    SELECT * INTO r FROM app.inscription(p_nom_proprietaire, p_email, p_mot_de_passe);
  EXCEPTION WHEN unique_violation THEN                       -- course entre deux inscriptions identiques
    SELECT u.id INTO v_u FROM app.utilisateur u WHERE u.email = lower(left(p_email, 254));
    RETURN QUERY SELECT 'existe'::text, v_u; RETURN;
  END;
  IF r.statut <> 'cree' THEN
    SELECT u.id INTO v_u FROM app.utilisateur u WHERE u.email = lower(left(p_email, 254));
    RETURN QUERY SELECT 'existe'::text, v_u; RETURN;
  END IF;
  RETURN QUERY SELECT 'cree'::text, r.utilisateur_id;
END;
$$;

-- Avis « un compte existe déjà avec cette adresse » : 1 par jour et par compte, compté à part des liens.
CREATE FUNCTION app.avis_compte_existant(p_utilisateur bigint)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_email text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('wakatnet_verification:' || p_utilisateur));
  SELECT u.email INTO v_email FROM app.utilisateur u WHERE u.id = p_utilisateur AND u.actif;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM app.avis_envoye a WHERE a.utilisateur_id = p_utilisateur AND a.le > now() - interval '24 hours') THEN
    RETURN NULL;
  END IF;
  INSERT INTO app.avis_envoye (utilisateur_id) VALUES (p_utilisateur);
  DELETE FROM app.avis_envoye WHERE le < now() - interval '7 days';
  RETURN v_email;
END;
$$;

-- Renvoi du lien sans session : l'utilisateur propriétaire non confirmé de cette adresse, ou NULL (inconnu, déjà
-- confirmé, ou 5 renvois dans l'heure pour cette source). L'API répond pareil dans tous les cas.
CREATE FUNCTION app.renvoi_demander(p_email text, p_source text)
RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_u bigint;
BEGIN
  IF NOT app._source_admise('renvoi', p_source) THEN RETURN NULL; END IF;
  SELECT u.id INTO v_u FROM app.utilisateur u
   WHERE u.email = lower(left(p_email, 254)) AND u.role = 'proprietaire' AND u.actif AND u.email_verifie_le IS NULL;
  RETURN v_u;
END;
$$;

-- Connexion : un propriétaire dont l'adresse n'est pas confirmée est rendu « inactif » ici. L'API répond alors le
-- même 401 que pour un mauvais mot de passe (F9 : rien ne dit si l'adresse existe).
CREATE OR REPLACE FUNCTION app.connexion_lire(p_email text)
RETURNS TABLE (utilisateur_id bigint, mot_de_passe text, actif boolean, echecs_recents integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  SELECT u.id, u.mot_de_passe,
         u.actif AND NOT coalesce(t.suspendu, false) AND (u.role <> 'proprietaire' OR u.email_verifie_le IS NOT NULL),
         (SELECT count(*)::integer FROM app.connexion_echec e WHERE e.email = lower(p_email) AND e.le > now() - interval '15 minutes')
    FROM (SELECT lower(p_email) AS e) x
    LEFT JOIN app.utilisateur u ON u.email = x.e
    LEFT JOIN app.tenant t ON t.id = u.tenant_id
$$;

-- Enrôlement : 'ok', 'non_verifie', 'quota', ou 'plafond' (compte non validé : plafond global, overlay à 90 %).
CREATE OR REPLACE FUNCTION app.enrolement_autorise(p_utilisateur bigint)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_tenant bigint := app.tenant_courant();
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'enrolement_autorise : aucun propriétaire dans le contexte'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('wakatnet_quota:' || v_tenant));
  IF NOT EXISTS (SELECT 1 FROM app.utilisateur u WHERE u.id = p_utilisateur AND u.tenant_id = v_tenant
                   AND u.email_verifie_le IS NOT NULL) THEN
    RETURN 'non_verifie';
  END IF;
  IF (SELECT count(*) FROM app.router r WHERE r.tenant_id = v_tenant)
     + (SELECT count(*) FROM app.enrollment_token t WHERE t.tenant_id = v_tenant AND t.consomme_le IS NULL AND t.expire_le > now())
     >= (SELECT quota_routeurs FROM app.tenant WHERE id = v_tenant) THEN
    RETURN 'quota';
  END IF;
  -- ADR 0019 : un compte que le super-admin n'a pas validé est soumis au plafond global d'enrôlements par jour,
  -- et à l'arrêt au-delà de 90 % de l'overlay (64 516 adresses, révoquées comprises).
  IF NOT (SELECT valide_admin FROM app.tenant WHERE id = v_tenant) THEN
    PERFORM pg_advisory_xact_lock(hashtext('wakatnet_quota:global'));
    -- Routeurs réellement enrôlés (adresses prises), pas jetons créés (relecture : des jetons jamais consommés
    -- épuisaient le plafond de tous à bas prix).
    IF (SELECT count(*) FROM app.router r JOIN app.tenant n ON n.id = r.tenant_id
         WHERE NOT n.valide_admin AND r.enrole_le > now() - interval '24 hours') >= 100
       OR (SELECT count(*) FROM app.router WHERE overlay_ip << '10.213.0.0/16'::inet) >= 0.9 * 254 * 254 THEN
      RETURN 'plafond';
    END IF;
  END IF;
  RETURN 'ok';
END;
$$;

-- Super-admin : valider l'adresse, ou RELEVER le quota, vaut validation du compte ; valider l'adresse porte le quota à
-- 10 au moins (ADR 0019). Baisser le quota d'un compte suspect ne le valide pas (relecture).
CREATE OR REPLACE FUNCTION app.admin_acces(p_tenant bigint, p_quota integer, p_valider_email boolean, p_admin bigint)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.tenant WHERE id = p_tenant) THEN RETURN false; END IF;
  IF p_valider_email OR p_quota > (SELECT quota_routeurs FROM app.tenant WHERE id = p_tenant) THEN
    UPDATE app.tenant SET valide_admin = true WHERE id = p_tenant;
  END IF;
  IF p_valider_email THEN
    UPDATE app.utilisateur SET email_verifie_le = now()
     WHERE tenant_id = p_tenant AND role = 'proprietaire' AND email_verifie_le IS NULL;
    UPDATE app.tenant SET quota_routeurs = greatest(quota_routeurs, 10) WHERE id = p_tenant;
  END IF;
  IF p_quota IS NOT NULL THEN
    UPDATE app.tenant SET quota_routeurs = p_quota WHERE id = p_tenant;
  END IF;
  INSERT INTO app.audit_log (tenant_id, acteur, action, objet, details)
  VALUES (p_tenant, 'utilisateur:' || p_admin, 'admin_acces', 'tenant:' || p_tenant,
          jsonb_build_object('quota_routeurs', p_quota, 'email_valide', coalesce(p_valider_email, false)));
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION app.inscription_demander(text, text, text, text), app.avis_compte_existant(bigint),
  app.renvoi_demander(text, text), app.courriel_reserver() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.inscription_demander(text, text, text, text), app.avis_compte_existant(bigint),
  app.renvoi_demander(text, text), app.courriel_reserver() TO wk_api;
-- L'ancienne inscription (session ouverte, 409 sur une adresse prise) n'est plus appelable par l'API (relecture : une API
-- restée sur l'ancien code rouvrirait F9 pendant le déploiement). inscription_demander l'appelle en propriétaire.
REVOKE EXECUTE ON FUNCTION app.inscription(text, text, text) FROM wk_api;

-- Supervision : e-mails et enrôlements des comptes non validés.
CREATE OR REPLACE FUNCTION app.sante()
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, radius, pg_temp
AS $$
DECLARE
  v_recuperation boolean := pg_is_in_recovery();
  v_debut timestamptz;
  v_duree numeric;
BEGIN
  -- Sonde : le même chemin que la fumée (ADR 0009 §3), pour un routeur inconnu (refus codé, lecture seule).
  v_debut := clock_timestamp();
  PERFORM radius.authorize('SONDESANTE', '10.213.255.250', '', '');
  v_duree := round(extract(epoch FROM clock_timestamp() - v_debut) * 1000, 2);
  RETURN jsonb_build_object(
    'en_recuperation', CASE WHEN v_recuperation THEN 1 ELSE 0 END,
    'sonde_authorize_ms', v_duree,
    'routeurs_actifs', (SELECT count(*) FROM app.router WHERE actif),
    -- Migration 0033 (M4) : adresses de l'overlay prises, révoquées comprises (jamais réemployées), sur 64 516.
    'overlay_utilise', (SELECT count(*) FROM app.router WHERE overlay_ip << '10.213.0.0/16'::inet),
    -- Migration 0034 (ADR 0019) : e-mails des 24 dernières heures (plafond 200), routeurs enrôlés par des comptes non
    -- validés (plafond 100).
    'courriels_24h', (SELECT count(*) FROM app.courriel_envoye WHERE le > now() - interval '24 hours'),
    'enrolements_non_valides_24h', (SELECT count(*) FROM app.router r JOIN app.tenant n ON n.id = r.tenant_id
                                      WHERE NOT n.valide_admin AND r.enrole_le > now() - interval '24 hours'),
    -- Migration 0032 : routeurs actifs dont wg-agent a noté l'IP publique depuis moins de 10 min.
    'routeurs_ip_recente', (SELECT count(*) FROM app.router WHERE actif AND ip_vue_le > now() - interval '10 minutes'),
    'paiements_pending_15min', (SELECT count(*) FROM app.payment WHERE statut = 'PENDING' AND cree_le < now() - interval '15 minutes'),
    'paiements_mismatch', (SELECT count(*) FROM app.payment WHERE statut = 'MISMATCH'),
    'replicas_en_flux', (SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'),
    'recepteur_en_flux', (SELECT count(*) FROM pg_stat_wal_receiver WHERE status = 'streaming'),
    -- Retard : sur le primaire, replay_lag des répliques ; sur une réplique, 0 quand tout ce qui est
    -- reçu est rejoué (une nuit sans écriture n'est pas un retard), sinon l'âge du dernier rejeu.
    'replication_retard_s', CASE
      WHEN v_recuperation AND pg_last_wal_receive_lsn() IS NOT DISTINCT FROM pg_last_wal_replay_lsn() THEN 0
      WHEN v_recuperation THEN coalesce(round(extract(epoch FROM now() - pg_last_xact_replay_timestamp())), -1)
      ELSE coalesce((SELECT round(max(extract(epoch FROM replay_lag))) FROM pg_stat_replication), 0) END,
    'alertes_10min', coalesce((SELECT jsonb_object_agg(type, n) FROM (
        SELECT type, count(*) AS n FROM radius.alerte WHERE at > now() - interval '10 minutes' GROUP BY type) x), '{}'::jsonb),
    'auth_5min', coalesce((SELECT jsonb_object_agg(k, n) FROM (
        SELECT resultat || ':' || coalesce(cause, '') AS k, count(*) AS n
          FROM radius.auth_log WHERE at > now() - interval '5 minutes' GROUP BY 1) x), '{}'::jsonb));
END;
$$;

RESET ROLE;
