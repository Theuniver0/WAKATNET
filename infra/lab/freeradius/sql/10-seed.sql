-- Données de labo (valeurs évidemment factices).
\set ON_ERROR_STOP on
SET ROLE wk_owner;
INSERT INTO app.routers (overlay_ip, shortname, radius_secret, active) VALUES
    ('10.213.1.10', 'labo-r1', 'secret-labo-01', true),
    ('10.213.1.20', 'labo-r2', 'secret-labo-02', true),
    ('10.213.1.30', 'labo-r3-inactif', 'secret-labo-03', false);
INSERT INTO app.tickets_lab (code, password_clear, session_timeout, rate_limit) VALUES
    ('TICKETLAB1', 'mdp-ticket-labo', 3600, '512k/2M');
INSERT INTO ledger.entries (amount_xof, label) VALUES (500, 'vente labo');
RESET ROLE;
