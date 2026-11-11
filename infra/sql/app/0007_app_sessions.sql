-- WAKATNET — migration 0007 : liaison à un appareil et redémarrages du routeur (phase 1, ticket 06).
-- Ticket : .scratch/phase-1-coeur-radius/issues/06-sessions.md ; ADR 0006 §8, §9.

SET ROLE wakatnet_owner;

-- bind_mac : MAC du premier appareil accepté, normalisée (12 chiffres hexadécimaux en
-- majuscules). Posée par radius.post_auth au premier Accept, ou par l'accounting s'il manque.
ALTER TABLE app.voucher ADD COLUMN mac_liee text CHECK (mac_liee ~ '^[0-9A-F]{12}$');

-- Dernier Accounting-On/Off traité (instant de réception) : un On rejoué est sans effet.
ALTER TABLE app.router ADD COLUMN dernier_acct_on_le timestamptz;

RESET ROLE;
