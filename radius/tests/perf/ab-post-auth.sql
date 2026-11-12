-- Mesure A/B de radius.post_auth (ancien corps 0009, nouveau corps 0012), même base, même données.
-- Lancé par ab-post-auth.sh sur la pile de mesure (donnees.sql) ; superutilisateur ; TEST SEULEMENT.
\set ON_ERROR_STOP 1
SELECT code AS c FROM app.voucher v JOIN app.tenant t ON t.id = v.tenant_id WHERE t.nom = 'Propriétaire de mesure' ORDER BY v.id LIMIT 1 \gset
SELECT host(overlay_ip) AS ip FROM app.router ORDER BY id DESC LIMIT 1 \gset
SELECT set_config('x.c', :'c', false), set_config('x.ip', :'ip', false);
DO $$ DECLARE t0 timestamptz; k int; a numeric; r numeric; BEGIN
  t0 := clock_timestamp();
  FOR k IN 1..2000 LOOP
    PERFORM radius.post_auth(current_setting('x.c'), current_setting('x.ip'), '02-AB-00-00-00-01', 'Accept', '');
  END LOOP;
  a := extract(epoch FROM clock_timestamp() - t0) * 1000 / 2000;
  t0 := clock_timestamp();
  FOR k IN 1..2000 LOOP
    PERFORM radius.post_auth('ZZZZZZZZ', current_setting('x.ip'), '02-AC-' || lpad(to_hex(k), 4, '0') || '-00-01', 'Reject', 'ticket_inconnu');
  END LOOP;
  r := extract(epoch FROM clock_timestamp() - t0) * 1000 / 2000;
  RAISE NOTICE 'RESULTAT accept_ms=% reject_ms=%', round(a, 3), round(r, 3);
END $$;
DELETE FROM radius.auth_log WHERE mac LIKE '02AB%' OR mac LIKE '02AC%';
DELETE FROM radius.alerte WHERE at > now() - interval '1 hour';
