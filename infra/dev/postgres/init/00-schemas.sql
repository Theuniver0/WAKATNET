-- WAKATNET — initialisation de la base de DÉVELOPPEMENT (phase 0).
-- Exécuté par l'image postgres une seule fois, à la création du volume pgdata.
--
-- Crée uniquement les trois schémas du SPEC §4 ; aucune table métier ici.
--   app    : tables applicatives (Prisma, phases suivantes)
--   radius : fonctions SQL de décision d'accès (phase 1, infra/sql/radius/)
--   ledger : grand livre (phase 3)
-- Rôles dédiés, droits et Row Level Security arrivent avec leurs tickets.

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS radius;
CREATE SCHEMA IF NOT EXISTS ledger;

COMMENT ON SCHEMA app    IS 'WAKATNET : tables applicatives (Prisma)';
COMMENT ON SCHEMA radius IS 'WAKATNET : fonctions SQL de décision d''accès RADIUS';
COMMENT ON SCHEMA ledger IS 'WAKATNET : grand livre';
