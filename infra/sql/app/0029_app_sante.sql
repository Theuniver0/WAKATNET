-- WAKATNET — migration 0029 : mesures de santé du nœud (phase 5, ticket 05).
-- Ticket : .scratch/phase-5-haute-disponibilite/issues/05-supervision.md ; ADR 0015 §6 ; SPEC §10.3.
-- Rôle wk_sante (collecteur sante.ts) : LOGIN, n'exécute QUE app.sante(), ne lit aucune table.
-- app.sante() ne rend que des COMPTES et des durées : ni code de ticket, ni MAC, ni numéro, ni nom.
-- Mot de passe : WAKATNET_PG_SANTE_PASSWORD (migrer.sh). Lisible aussi sur une réplique (lecture seule).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wk_sante') THEN
    CREATE ROLE wk_sante LOGIN;
  END IF;
END $$;
-- Colonnes d'état de pg_stat_replication et pg_stat_wal_receiver : réservées à pg_read_all_stats.
-- Donné au PROPRIÉTAIRE des fonctions (rôle sans connexion), pour la seule fonction app.sante().
GRANT pg_read_all_stats TO wakatnet_owner;
GRANT USAGE ON SCHEMA app TO wk_sante;

SET ROLE wakatnet_owner;

CREATE FUNCTION app.sante()
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
REVOKE ALL ON FUNCTION app.sante() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.sante() TO wk_sante;

RESET ROLE;
