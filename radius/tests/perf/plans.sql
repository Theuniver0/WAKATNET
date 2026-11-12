-- Plans d'exécution des instructions imbriquées de radius._authorize_at (ticket 10).
-- auto_explain, dans cette seule session de mesure ; un ticket valide et un code inconnu.
LOAD 'auto_explain';
SET client_min_messages = log;
SET auto_explain.log_min_duration = 0;
SET auto_explain.log_analyze = on;
SET auto_explain.log_buffers = on;
SET auto_explain.log_nested_statements = on;
SET auto_explain.log_format = text;
SELECT code AS code_mesure FROM app.voucher v JOIN app.tenant t ON t.id = v.tenant_id
 WHERE t.nom = 'Propriétaire de mesure' ORDER BY v.id DESC LIMIT 1 OFFSET 5000 \gset
SELECT host(overlay_ip) AS ip_mesure FROM app.router ORDER BY id DESC LIMIT 1 \gset
SELECT decision FROM radius._authorize_at(:'code_mesure', :'ip_mesure', '02-AB-CD-EF-01-02', 'h', now());
SELECT decision FROM radius._authorize_at('ZZZZZZZZ', :'ip_mesure', '02-AB-CD-EF-01-03', 'h', now());
SELECT radius.sessions_to_cut(100);
