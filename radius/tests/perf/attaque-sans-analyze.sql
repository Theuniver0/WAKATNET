\timing off
-- Coût d'authorize pour un VRAI client d'un routeur sous attaque par devinette (ticket 10).
-- Base de mesure seulement (perf.sh / donnees.sql) : échecs ticket_inconnu récents, MAC toutes
-- différentes (l'attaquant change de MAC), puis 20 appels d'un client légitime.
SELECT set_config('x.r', id::text, false), set_config('x.t', tenant_id::text, false)
  FROM app.router WHERE host(overlay_ip) = '10.213.100.7';
SELECT set_config('x.c', code, false) FROM app.voucher ORDER BY id LIMIT 1;
CREATE TEMP TABLE mesure (attaque int, ms numeric);
DO $$ DECLARE n int; t0 timestamptz; k int; BEGIN
  FOREACH n IN ARRAY ARRAY[0, 1000, 10000, 50000, 100000] LOOP
    INSERT INTO radius.auth_log (at, router_id, tenant_id, mac, resultat, cause)
    SELECT now() - random() * interval '5 minutes', current_setting('x.r')::bigint, current_setting('x.t')::bigint,
           '02FA' || lpad(to_hex(g), 8, '0'), 'Reject', 'ticket_inconnu'
      FROM generate_series(1, n - coalesce((SELECT max(attaque) FROM mesure), 0)) g
     WHERE n > 0;
    -- sans ANALYZE : statistiques de la base au repos, comme pendant une attaque réelle
    t0 := clock_timestamp();
    FOR k IN 1..20 LOOP
      PERFORM radius._authorize_at(current_setting('x.c'), '10.213.100.7', '02-AB-CD-EF-01-02', 'h', now());
    END LOOP;
    INSERT INTO mesure VALUES (n, round(extract(epoch FROM clock_timestamp() - t0) * 1000 / 20, 2));
  END LOOP; END $$;
SELECT attaque AS echecs_recents_sur_le_routeur, ms AS ms_par_authorize FROM mesure ORDER BY 1;
