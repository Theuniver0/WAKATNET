-- WAKATNET — migration 0033 : quota d'enrôlement et vérification de l'adresse e-mail (revue de sécurité M4).
-- Ticket : docs/REVUE_SECURITE.md (M4) ; docs/adr/0017-quota-et-verification.md.
--
-- Un enrôlement consomme une adresse de l'overlay, jamais réemployée, et s'obtient sans routeur (une clé tirée au
-- hasard suffit). Désormais :
--   - quota par propriétaire (10 par défaut) : routeurs enrôlés, RÉVOQUÉS COMPRIS, plus jetons ouverts ;
--   - créer une commande d'enrôlement exige une adresse e-mail vérifiée (lien, ou validation du super-admin) ;
--   - mesure overlay_utilise pour l'alerte overlay_plein (sante.ts).

SET ROLE wakatnet_owner;

ALTER TABLE app.tenant ADD COLUMN quota_routeurs integer NOT NULL DEFAULT 10 CHECK (quota_routeurs BETWEEN 0 AND 10000);
ALTER TABLE app.utilisateur ADD COLUMN email_verifie_le timestamptz;
-- Comptes existants (ADR 0017 §5) : réputés vérifiés, sauf un propriétaire qui n'a encore aucun routeur (relecture
-- C3 : un compte ouvert par un tiers avant la migration ne reçoit pas son quota sans contrôle).
UPDATE app.utilisateur u SET email_verifie_le = u.cree_le
 WHERE u.email_verifie_le IS NULL
   AND (u.role <> 'proprietaire' OR EXISTS (SELECT 1 FROM app.router r WHERE r.tenant_id = u.tenant_id));

-- Liens de vérification : empreinte (SHA-256) du jeton seulement ; 24 h ; usage unique.
CREATE TABLE app.verification_email (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  utilisateur_id bigint NOT NULL REFERENCES app.utilisateur (id) ON DELETE CASCADE,
  empreinte      bytea  NOT NULL UNIQUE CHECK (length(empreinte) = 32),
  cree_le        timestamptz NOT NULL DEFAULT now(),
  expire_le      timestamptz NOT NULL,
  consomme_le    timestamptz
);
CREATE INDEX verification_email_utilisateur ON app.verification_email (utilisateur_id, cree_le);
ALTER TABLE app.verification_email ENABLE ROW LEVEL SECURITY;    -- aucune politique : fonctions seulement
-- Liens envoyés par compte, en tout (la purge des liens à 7 jours ne remet pas ce compte à zéro).
CREATE TABLE app.utilisateur_liens (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  utilisateur_id bigint NOT NULL REFERENCES app.utilisateur (id) ON DELETE CASCADE,
  le             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX utilisateur_liens_utilisateur ON app.utilisateur_liens (utilisateur_id);
ALTER TABLE app.utilisateur_liens ENABLE ROW LEVEL SECURITY;     -- aucune politique : fonctions seulement

-- L'utilisateur de cette session a-t-il une adresse vérifiée ? (GET /v1/moi)
CREATE FUNCTION app.session_email_verifie(p_empreinte bytea)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  SELECT u.email_verifie_le IS NOT NULL
    FROM app.session_utilisateur s JOIN app.utilisateur u ON u.id = s.utilisateur_id
   WHERE s.empreinte = p_empreinte AND s.expire_le > now() AND s.limite_le > now() AND u.actif
$$;

-- Nouveau lien pour un PROPRIÉTAIRE non vérifié. Rend son adresse, ou NULL : déjà vérifié, inconnu, 3 liens dans
-- l'heure, ou 5 liens en tout (relecture C2 : pas d'envoi sans fin à l'adresse d'un tiers inscrite par un autre).
-- Verrou par utilisateur : des demandes parallèles ne dépassent pas les limites.
CREATE FUNCTION app.verification_creer(p_utilisateur bigint, p_empreinte bytea)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_email text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('wakatnet_verification:' || p_utilisateur));
  SELECT u.email INTO v_email FROM app.utilisateur u
   WHERE u.id = p_utilisateur AND u.role = 'proprietaire' AND u.actif AND u.email_verifie_le IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM app.verification_email v WHERE v.utilisateur_id = p_utilisateur
        AND v.cree_le > now() - interval '1 hour') >= 3
     OR (SELECT count(*) FROM app.utilisateur_liens n WHERE n.utilisateur_id = p_utilisateur) >= 5 THEN
    RETURN NULL;
  END IF;
  INSERT INTO app.verification_email (utilisateur_id, empreinte, expire_le) VALUES (p_utilisateur, p_empreinte, now() + interval '24 hours');
  INSERT INTO app.utilisateur_liens (utilisateur_id) VALUES (p_utilisateur);
  DELETE FROM app.verification_email WHERE cree_le < now() - interval '7 days';
  RETURN v_email;
END;
$$;

-- Lien suivi : vérifie l'adresse. true si le jeton était valable (non consommé, non expiré, compte actif).
CREATE FUNCTION app.verification_consommer(p_empreinte bytea)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v app.verification_email%ROWTYPE;
  v_tenant bigint;
BEGIN
  SELECT * INTO v FROM app.verification_email e
   WHERE e.empreinte = p_empreinte AND e.consomme_le IS NULL AND e.expire_le > now() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE app.verification_email SET consomme_le = now() WHERE id = v.id;
  DELETE FROM app.verification_email WHERE cree_le < now() - interval '7 days';     -- relecture C6
  UPDATE app.utilisateur SET email_verifie_le = coalesce(email_verifie_le, now())
   WHERE id = v.utilisateur_id AND actif RETURNING tenant_id INTO v_tenant;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO app.audit_log (tenant_id, acteur, action, objet)
  VALUES (v_tenant, 'utilisateur:' || v.utilisateur_id, 'email_verifie', 'utilisateur:' || v.utilisateur_id);
  RETURN true;
END;
$$;

-- Avant de créer une commande d'enrôlement (dans la même transaction, contexte RLS posé) :
--   'ok', 'non_verifie' (adresse de l'utilisateur non vérifiée), 'quota' (routeurs enrôlés + jetons ouverts).
-- Le verrou par propriétaire tient jusqu'à la fin de la transaction, donc jusqu'à l'insertion du jeton.
CREATE FUNCTION app.enrolement_autorise(p_utilisateur bigint)
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
  RETURN 'ok';
END;
$$;

-- Super-admin (après rôle ET TOTP vérifiés par l'API) : quota, et validation de l'adresse du propriétaire.
CREATE FUNCTION app.admin_acces(p_tenant bigint, p_quota integer, p_valider_email boolean, p_admin bigint)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.tenant WHERE id = p_tenant) THEN RETURN false; END IF;
  IF p_quota IS NOT NULL THEN
    UPDATE app.tenant SET quota_routeurs = p_quota WHERE id = p_tenant;
  END IF;
  IF p_valider_email THEN
    UPDATE app.utilisateur SET email_verifie_le = now()
     WHERE tenant_id = p_tenant AND role = 'proprietaire' AND email_verifie_le IS NULL;
  END IF;
  INSERT INTO app.audit_log (tenant_id, acteur, action, objet, details)
  VALUES (p_tenant, 'utilisateur:' || p_admin, 'admin_acces', 'tenant:' || p_tenant,
          jsonb_build_object('quota_routeurs', p_quota, 'email_valide', coalesce(p_valider_email, false)));
  RETURN true;
END;
$$;

-- Liste du super-admin : quota, routeurs enrôlés (révoqués compris), adresse vérifiée.
DROP FUNCTION app.admin_proprietaires(timestamptz, timestamptz);
CREATE FUNCTION app.admin_proprietaires(p_debut timestamptz, p_fin timestamptz)
RETURNS TABLE (tenant_id bigint, nom text, suspendu boolean, commission_bps integer, plafond_decouvert bigint,
               solde_credits_xof bigint, ventes_en_ligne_xof bigint, commissions_xof bigint, frais_papier_xof bigint,
               quota_routeurs integer, routeurs_enroles bigint, email_verifie boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, ledger, pg_temp
AS $$
  SELECT t.id, t.nom, t.suspendu, t.commission_bps, t.plafond_decouvert, app.credits_solde(t.id),
         (SELECT coalesce(sum(p.montant), 0) FROM app.payment p
           WHERE p.tenant_id = t.id AND p.statut = 'SUCCEEDED' AND p.confirme_le >= p_debut AND p.confirme_le < p_fin)::bigint,
         (SELECT coalesce(sum(e.debit - e.credit), 0) FROM ledger.transaction x JOIN ledger.ecriture e ON e.transaction_id = x.id
            JOIN ledger.compte k ON k.id = e.compte_id
           WHERE k.code = 'proprietaire:' || t.id || ':credits' AND x.nature = 'commission'
             AND x.cree_le >= p_debut AND x.cree_le < p_fin)::bigint,
         (SELECT coalesce(sum(e.debit - e.credit), 0) FROM ledger.transaction x JOIN ledger.ecriture e ON e.transaction_id = x.id
            JOIN ledger.compte k ON k.id = e.compte_id
           WHERE k.code = 'proprietaire:' || t.id || ':credits' AND x.nature = 'frais_papier'
             AND x.cree_le >= p_debut AND x.cree_le < p_fin)::bigint,
         t.quota_routeurs,
         (SELECT count(*) FROM app.router r WHERE r.tenant_id = t.id),
         EXISTS (SELECT 1 FROM app.utilisateur u WHERE u.tenant_id = t.id AND u.role = 'proprietaire' AND u.email_verifie_le IS NOT NULL)
    FROM app.tenant t ORDER BY t.id
$$;

-- Supervision : mesure overlay_utilise (alerte overlay_plein, sante.ts).
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

REVOKE ALL ON FUNCTION app.session_email_verifie(bytea), app.verification_creer(bigint, bytea), app.verification_consommer(bytea),
  app.enrolement_autorise(bigint), app.admin_acces(bigint, integer, boolean, bigint),
  app.admin_proprietaires(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.session_email_verifie(bytea), app.verification_creer(bigint, bytea), app.verification_consommer(bytea),
  app.enrolement_autorise(bigint), app.admin_acces(bigint, integer, boolean, bigint),
  app.admin_proprietaires(timestamptz, timestamptz) TO wk_api;

RESET ROLE;
