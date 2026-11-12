-- WAKATNET — jeu de données de la mesure de performance (ticket 10). TEST SEULEMENT.
-- Ticket : .scratch/phase-1-coeur-radius/issues/10-performance.md
-- Lancé par perf.sh (superutilisateur, base de la pile de mesure, jamais une base réelle) :
--   psql -v routeurs=50 -v tickets=100000 -v sessions=1000 -v jours=90 -v par_jour=300 -f donnees.sql
-- Le secret commun des routeurs de mesure est lu dans l'environnement (\getenv), jamais écrit ici.
\set ON_ERROR_STOP 1
\getenv secret WAKATNET_SECRET_R1
SET log_statement = 'none';

BEGIN;
INSERT INTO app.tenant (nom) VALUES ('Propriétaire de mesure') RETURNING id AS tenant \gset
INSERT INTO app.site (tenant_id, nom) VALUES (:tenant, 'Site de mesure') RETURNING id AS site \gset
-- Routeurs : 10.213.100.1 à 10.213.(100 + n / 250).(n % 250 + 1).
INSERT INTO app.router (tenant_id, site_id, overlay_ip, shortname)
SELECT :tenant, :site, ('10.213.' || (100 + (n - 1) / 250) || '.' || ((n - 1) % 250 + 1))::inet, 'perf-' || n
  FROM generate_series(1, :routeurs) n;
INSERT INTO radius.router_secret (router_id, secret)
SELECT id, :'secret' FROM app.router WHERE tenant_id = :tenant;
-- Forfait d'une heure, un appareil, débit fixé : le cas le plus courant (§5.3).
INSERT INTO app.plan (tenant_id, nom, prix_xof, uptime_limit_s, rate_limit, devices)
VALUES (:tenant, 'Mesure 1 h', 100, 3600, '512k/2M', 1) RETURNING id AS plan \gset
COMMIT;

-- Tickets, par la fonction de production (tirage cryptographique, copie figée du forfait).
SELECT count(app.voucher_creer(:tenant, :plan)) AS tickets_crees FROM generate_series(1, :tickets);
SELECT min(id) AS premier_ticket FROM app.voucher WHERE tenant_id = :tenant \gset

-- Sessions ouvertes, réparties sur les routeurs, chacune sur un ticket distinct.
INSERT INTO radius.session (started_at, router_id, router_epoch, acct_session_id, tenant_id, voucher_id,
                            calling_station, interim_s, dernier_evenement_le, duree_s, octets_montants,
                            octets_descendants)
SELECT now() - interval '20 minutes', r.id, 0, 'perf-' || v.id, :tenant, v.id,
       '02-AA-00-' || lpad(to_hex(v.id % 65536), 4, '0'), 120, now() - interval '1 minute', 1200, 1000000, 5000000
  FROM (SELECT id, row_number() OVER (ORDER BY id) AS i FROM app.voucher WHERE tenant_id = :tenant
         ORDER BY id DESC LIMIT :sessions) v
  JOIN (SELECT id, row_number() OVER (ORDER BY id) - 1 AS j FROM app.router WHERE tenant_id = :tenant) r
    ON r.j = v.i % :routeurs;

-- auth_log : :jours jours au profil de :par_jour connexions par jour et par routeur ;
-- 90 % d'Accept sur un ticket, 10 % de Reject ticket_inconnu (MAC variées).
INSERT INTO radius.auth_log (at, router_id, tenant_id, mac, resultat, cause, voucher_id)
SELECT now() - random() * (:jours * interval '1 day'), r.id, :tenant,
       '02BB' || lpad(to_hex((random() * 4294967295)::bigint), 8, '0'),
       CASE WHEN k % 10 = 0 THEN 'Reject' ELSE 'Accept' END,
       CASE WHEN k % 10 = 0 THEN 'ticket_inconnu' END,
       CASE WHEN k % 10 = 0 THEN NULL
            ELSE :premier_ticket + (k % :tickets) END
  FROM app.router r, generate_series(1, :jours * :par_jour) k
 WHERE r.tenant_id = :tenant;

ANALYZE;
SELECT (SELECT count(*) FROM app.router WHERE tenant_id = :tenant) AS routeurs,
       (SELECT count(*) FROM app.voucher WHERE tenant_id = :tenant) AS tickets,
       (SELECT count(*) FROM radius.session WHERE tenant_id = :tenant AND arrete_le IS NULL) AS sessions_ouvertes,
       (SELECT count(*) FROM radius.auth_log) AS lignes_auth_log;
