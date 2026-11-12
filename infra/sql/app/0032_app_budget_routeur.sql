-- WAKATNET — migration 0032 : budget de paiement propre à l'IP publique des routeurs du site (revue de sécurité M7).
-- Ticket : docs/REVUE_SECURITE.md (M7) ; ADR 0016 §2 ; ADR 0012 §1 (wg-agent).
--
-- 0031 laissait M7 ouvert : 4 sources épuisaient le plafond d'un site, qui bloquait aussi son hotspot. Or les
-- clients d'un hotspot sortent vers le portail par l'IP publique du routeur, celle d'où part son tunnel
-- WireGuard. wg-agent la relève (point de terminaison du pair, poignée de main de moins de 3 min) et la note
-- ici. Une demande qui vient de l'IP d'un routeur ACTIF du site, vue il y a moins de 10 min, a son propre
-- budget (30 par minute et par site), que les autres sources ne touchent pas. Les autres gardent les règles de 0031
-- (30 par minute et par source, 100 par minute et par site) : quand le routeur n'est pas reconnu (double WAN,
-- CGNAT non apparié, IPv6 côté clients, wg-agent arrêté), rien n'est plus faible qu'avant.
-- IPv4 : égalité ; IPv6 : même /64. L'IP d'un routeur est authentifiée par WireGuard : seul le détenteur de sa
-- clé privée la fait changer. Relue par un second agent (règle 4) ; ses constats sont repris ici.
-- RESTE (M7) : un voisin de NAT ou de CGNAT (même IP publique que le routeur) partage son budget, et peut le vider.
-- Donnée personnelle : l'IP du routeur (souvent celle d'un particulier) est effacée à la révocation, et après un
-- jour sans être revue (docs/CONFORMITE.md, T10).

SET ROLE wakatnet_owner;

ALTER TABLE app.router ADD COLUMN ip_publique inet, ADD COLUMN ip_vue_le timestamptz;
ALTER TABLE app.paiement_demande ADD COLUMN routeur boolean NOT NULL DEFAULT false;

-- Demande venue d'un routeur actif du site, vu récemment (fonction interne, appelée par paiement_creer).
CREATE FUNCTION app._depuis_routeur(p_site bigint, p_ip inet)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = app, pg_temp
AS $$
  SELECT p_ip IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.router r
     WHERE r.site_id = p_site AND r.actif AND r.ip_publique IS NOT NULL
       AND r.ip_vue_le > now() - interval '10 minutes'
       AND family(r.ip_publique) = family(p_ip)
       AND CASE WHEN family(p_ip) = 4 THEN host(r.ip_publique) = host(p_ip)
                ELSE network(set_masklen(r.ip_publique, 64)) = network(set_masklen(p_ip, 64)) END)
$$;
REVOKE ALL ON FUNCTION app._depuis_routeur(bigint, inet) FROM PUBLIC;

-- wg-agent note les IP publiques vues sur wg0 (clé publique, IP, dernière poignée de main). Sans effet sur une
-- réplique (lecture seule) : seul l'agent du primaire écrit. Une ligne n'est réécrite que si l'IP change ou au
-- plus toutes les 5 min (pas d'écriture à chaque tour de 30 s). Les poignées de main de plus de 3 min, ou datées
-- du futur, sont ignorées. Efface aussi l'IP des routeurs révoqués, et celle qui n'a pas été revue depuis un jour.
-- Rend le nombre de routeurs mis à jour. Élargit le rôle wk_wg, qui ne faisait que lire (ADR 0016 §2).
CREATE FUNCTION app.wg_points_noter(p_cles text[], p_ips inet[], p_vus timestamptz[])
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF pg_is_in_recovery() THEN RETURN 0; END IF;
  IF cardinality(p_cles) IS DISTINCT FROM cardinality(p_ips) OR cardinality(p_cles) IS DISTINCT FROM cardinality(p_vus)
     OR cardinality(p_cles) > 100000 THEN
    RAISE EXCEPTION 'wg_points_noter : tableaux de longueurs différentes ou trop longs';
  END IF;
  UPDATE app.router r SET ip_publique = host(x.ip)::inet, ip_vue_le = x.vu
    FROM unnest(p_cles, p_ips, p_vus) AS x(cle, ip, vu)
   WHERE r.wg_public_key = x.cle AND r.actif AND x.ip IS NOT NULL
     AND x.vu > now() - interval '3 minutes' AND x.vu <= now() + interval '1 minute'
     AND (r.ip_publique IS DISTINCT FROM host(x.ip)::inet OR r.ip_vue_le IS NULL OR r.ip_vue_le < x.vu - interval '5 minutes');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE app.router SET ip_publique = NULL, ip_vue_le = NULL
   WHERE ip_publique IS NOT NULL AND (NOT actif OR ip_vue_le < now() - interval '1 day');
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION app.wg_points_noter(text[], inet[], timestamptz[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.wg_points_noter(text[], inet[], timestamptz[]) TO wk_wg;

DROP FUNCTION app.paiement_creer(text, bigint, text, text, bytea, text, bytea, text, text, text);
CREATE FUNCTION app.paiement_creer(p_public_id text, p_plan bigint, p_operateur text, p_numero_clair text,
                                   p_numero_hmac bytea, p_numero_masque text, p_jeton bytea, p_soumission text,
                                   p_reference text, p_source text, p_ip inet DEFAULT NULL)
RETURNS TABLE (statut text, payment_id bigint, reference text, montant bigint, tenant_id bigint,
               fournisseur text, statut_paiement text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, ledger, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_site   app.site%ROWTYPE;
  v_plan   app.plan%ROWTYPE;
  v_vente  text;
  v_p      app.payment%ROWTYPE;
  v_source text := left(coalesce(nullif(p_source, ''), '?'), 64);
  v_routeur boolean;
BEGIN
  SELECT * INTO v_site FROM app.site s WHERE s.public_id = p_public_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'site_inconnu'::text, NULL::bigint, NULL::text, NULL::bigint, NULL::bigint, NULL::text, NULL::text; RETURN;
  END IF;
  -- P9 : même soumission → même paiement, sans rien recréer.
  SELECT * INTO v_p FROM app.payment p WHERE p.tenant_id = v_site.tenant_id AND p.soumission = p_soumission;
  IF FOUND THEN
    RETURN QUERY SELECT 'deja'::text, v_p.id, v_p.reference, v_p.montant, v_p.tenant_id, v_p.fournisseur, v_p.statut; RETURN;
  END IF;
  -- Limites de demandes (0022) ; garde du site par source (0031, M7) ; budget propre aux routeurs du site (0032).
  -- Le verrou du site sérialise les comptes de la garde.
  PERFORM pg_advisory_xact_lock(hashtext('paiement:' || v_site.id || ':' || encode(p_numero_hmac, 'hex')));
  PERFORM pg_advisory_xact_lock(hashtext('paiement:jeton:' || encode(p_jeton, 'hex')));
  PERFORM pg_advisory_xact_lock(hashtext('paiement:site:' || v_site.id));
  v_routeur := app._depuis_routeur(v_site.id, p_ip);
  IF (SELECT count(*) FROM app.payment p WHERE p.site_id = v_site.id AND p.numero_hmac = p_numero_hmac
         AND p.cree_le > now() - interval '10 minutes') >= 3
     OR (SELECT count(*) FROM app.payment p WHERE p.jeton_appareil = p_jeton AND p.cree_le > now() - interval '10 minutes') >= 5
     OR (v_routeur AND (SELECT count(*) FROM app.paiement_demande d WHERE d.site_id = v_site.id AND d.routeur
           AND d.le > now() - interval '1 minute') >= 30)
     OR (NOT v_routeur AND ((SELECT count(*) FROM app.paiement_demande d WHERE d.site_id = v_site.id AND NOT d.routeur
           AND d.source = v_source AND d.le > now() - interval '1 minute') >= 30
        OR (SELECT count(*) FROM app.paiement_demande d WHERE d.site_id = v_site.id AND NOT d.routeur
           AND d.le > now() - interval '1 minute') >= 100)) THEN
    RETURN QUERY SELECT 'trop_de_demandes'::text, NULL::bigint, NULL::text, NULL::bigint, NULL::bigint, NULL::text, NULL::text; RETURN;
  END IF;
  SELECT * INTO v_plan FROM app.plan p
   WHERE p.id = p_plan AND p.tenant_id = v_site.tenant_id AND p.prix_xof > 0 AND (p.scope = 'tenant' OR p.site_id = v_site.id);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'forfait_inconnu'::text, NULL::bigint, NULL::text, NULL::bigint, NULL::bigint, NULL::text, NULL::text; RETURN;
  END IF;
  v_vente := app._vente_en_ligne(v_site.tenant_id);
  IF v_vente <> 'ok' THEN
    RETURN QUERY SELECT v_vente, NULL::bigint, NULL::text, NULL::bigint, NULL::bigint, NULL::text, NULL::text; RETURN;
  END IF;
  INSERT INTO app.payment (tenant_id, site_id, plan_id, montant, operateur, fournisseur, reference, numero_clair,
                           numero_hmac, numero_masque, purge_numero_le, jeton_appareil, soumission, expire_le,
                           verifier_jusqu_au, prochaine_verif_le, detail)
  SELECT v_site.tenant_id, v_site.id, v_plan.id, v_plan.prix_xof, p_operateur, m.fournisseur, p_reference, p_numero_clair,
         p_numero_hmac, p_numero_masque, now() + interval '6 months', p_jeton, p_soumission, now() + interval '3 minutes',
         now() + interval '24 hours', now() + interval '2 minutes',
         -- Forfait FIGÉ à l'achat : le ticket créé à la confirmation (jusqu'à 24 h plus tard) donne
         -- exactement ce qui a été payé, même si le propriétaire modifie le forfait entre-temps.
         jsonb_build_object('forfait', to_jsonb(v_plan))
    FROM app.compte_marchand m WHERE m.tenant_id = v_site.tenant_id
  ON CONFLICT (tenant_id, soumission) DO NOTHING
  RETURNING * INTO v_p;
  IF v_p.id IS NULL THEN   -- course entre deux soumissions identiques : la première a gagné
    SELECT * INTO STRICT v_p FROM app.payment p WHERE p.tenant_id = v_site.tenant_id AND p.soumission = p_soumission;
    RETURN QUERY SELECT 'deja'::text, v_p.id, v_p.reference, v_p.montant, v_p.tenant_id, v_p.fournisseur, v_p.statut; RETURN;
  END IF;
  INSERT INTO app.paiement_demande (site_id, source, routeur) VALUES (v_site.id, v_source, v_routeur);
  DELETE FROM app.paiement_demande WHERE le < now() - interval '1 hour';
  RETURN QUERY SELECT 'cree'::text, v_p.id, v_p.reference, v_p.montant, v_p.tenant_id, v_p.fournisseur, v_p.statut;
END;
$$;

REVOKE ALL ON FUNCTION app.paiement_creer(text, bigint, text, text, bytea, text, bytea, text, text, text, inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.paiement_creer(text, bigint, text, text, bytea, text, bytea, text, text, text, inet) TO wk_api;

-- Supervision (relecture de 0032) : sans IP notée, le hotspot perd en silence son budget propre.
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
