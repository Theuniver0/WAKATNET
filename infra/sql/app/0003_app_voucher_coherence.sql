-- WAKATNET — migration 0003 : cohérence de la copie figée du forfait (phase 1, ticket 03).
-- Ticket : .scratch/phase-1-coeur-radius/issues/03-refus-codes.md
--
-- La copie figée sur le ticket (§5.3) reçoit les mêmes contraintes que le forfait
-- (migration 0001, app.plan) : une limite est strictement positive, et une durée
-- est toujours bornée (ADR 0006 §5 : jamais d'Accept sans Session-Timeout).
-- radius._authorize_at reste robuste si ces contraintes manquent (refus codé, migration 0004).

SET ROLE wakatnet_owner;

ALTER TABLE app.voucher
  ADD CONSTRAINT voucher_f_uptime_positif   CHECK (f_uptime_limit_s > 0),
  ADD CONSTRAINT voucher_f_validite_positive CHECK (f_validity_s > 0),
  ADD CONSTRAINT voucher_f_volume_positif   CHECK (f_data_limit_bytes > 0),
  ADD CONSTRAINT voucher_f_duree_bornee     CHECK (f_uptime_limit_s IS NOT NULL OR f_validity_s IS NOT NULL);

RESET ROLE;
