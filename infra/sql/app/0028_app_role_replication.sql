-- WAKATNET — migration 0028 : rôles de réplication et de retour en réplique (phase 5, tickets 02 et 03).
-- Ticket : .scratch/phase-5-haute-disponibilite/issues/02-t13-replique.md ; ADR 0015 §1.
-- REPLICATION et LOGIN seulement : aucun droit sur un schéma, une table ou une fonction.
-- Mot de passe posé par migrer.sh (WAKATNET_PG_REPLICATION_PASSWORD), sur le primaire seul ;
-- la réplique hérite du rôle par la réplication. Le slot (`noeud_b`) et la ligne de pg_hba.conf
-- sont propres au nœud : posés par le déploiement (Ansible), pas par une migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wk_replication') THEN
    CREATE ROLE wk_replication LOGIN REPLICATION;
  END IF;
END $$;
-- Pas de REVOKE CONNECT ici : CONNECT est accordé à PUBLIC (test_t08), un retrait pour ce seul
-- rôle serait sans effet. C'est pg_hba.conf (déploiement) qui ne lui ouvre QUE la réplication.

-- Retour de l'ancien primaire en réplique (ADR 0015 §3) : pg_rewind lit les fichiers du nouveau
-- primaire par une connexion ordinaire. Plutôt qu'un superutilisateur ouvert sur le lien entre
-- nœuds, un rôle qui n'a QUE les quatre fonctions exigées par la documentation de pg_rewind
-- (PostgreSQL 16, « pg_rewind », section Notes). Mot de passe : WAKATNET_PG_REWIND_PASSWORD.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wk_rewind') THEN
    CREATE ROLE wk_rewind LOGIN;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_ls_dir(text, boolean, boolean) TO wk_rewind;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_stat_file(text, boolean) TO wk_rewind;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_binary_file(text) TO wk_rewind;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_binary_file(text, bigint, bigint, boolean) TO wk_rewind;
