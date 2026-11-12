-- WAKATNET — migration 0017 : import des tickets Mikhmon (phase 2, ticket 07).
-- Ticket : .scratch/phase-2-multi-proprietaires/issues/07-import-mikhmon.md
-- Contrat : ADR 0012 §10 ; SPEC §6.3.

SET ROLE wakatnet_owner;

-- Origine du ticket : la forme du code en dépend. Les tickets importés sont DÉJÀ imprimés :
-- leurs symboles ambigus (0, O, 1, I, L) sont admis ; les tickets de la plateforme gardent
-- l'alphabet de 31 symboles (ADR 0006 §15). Codes stockés en majuscules dans les deux cas
-- (authorize compare upper(User-Name) ; login.html met la saisie en majuscules avant CHAP).
ALTER TABLE app.voucher ADD COLUMN origine text NOT NULL DEFAULT 'wakatnet' CHECK (origine IN ('wakatnet', 'import'));
ALTER TABLE app.voucher DROP CONSTRAINT voucher_code_check;
ALTER TABLE app.voucher ADD CONSTRAINT voucher_code_forme CHECK (
  (origine = 'wakatnet' AND code ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8,16}$')
  OR (origine = 'import' AND code ~ '^[0-9A-Z]{4,32}$'));

-- Importe un LOT de tickets pour le propriétaire du contexte RLS (app.tenant_courant()), en un
-- seul appel : un export de 20 000 lignes ne doit pas dépendre du délai d'une transaction
-- interactive côté API (revue Standards). SECURITY DEFINER (la copie figée lit le forfait et
-- écrit le ticket) : le propriétaire est donc vérifié ICI, explicitement, jamais pris en paramètre.
-- Une ligne par entrée, dans l'ordre (rang à partir de 1) :
--   'importe' | 'doublon' (code déjà présent chez ce propriétaire) | 'forfait_inconnu' | 'code_invalide'
CREATE FUNCTION app.voucher_importer(p_plans bigint[], p_codes text[])
RETURNS TABLE (rang integer, statut text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_tenant bigint := app.tenant_courant();
  p        app.plan%ROWTYPE;
  v_code   text;
  i        integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'import sans propriétaire (contexte RLS absent)';
  END IF;
  IF coalesce(array_length(p_plans, 1), 0) <> coalesce(array_length(p_codes, 1), 0)
     OR coalesce(array_length(p_codes, 1), 0) > 20000 THEN
    RAISE EXCEPTION 'lot invalide (tableaux de tailles différentes, ou plus de 20 000 lignes)';
  END IF;
  FOR i IN 1 .. coalesce(array_length(p_codes, 1), 0) LOOP
    rang := i;
    v_code := upper(coalesce(p_codes[i], ''));
    IF v_code !~ '^[0-9A-Z]{4,32}$' THEN
      statut := 'code_invalide'; RETURN NEXT; CONTINUE;
    END IF;
    IF p.id IS DISTINCT FROM p_plans[i] THEN
      SELECT * INTO p FROM app.plan WHERE id = p_plans[i] AND tenant_id = v_tenant;
      IF NOT FOUND THEN
        p := NULL;
        statut := 'forfait_inconnu'; RETURN NEXT; CONTINUE;
      END IF;
    END IF;
    INSERT INTO app.voucher (tenant_id, plan_id, code, origine, f_prix_xof, f_uptime_limit_s, f_validity_s,
                             f_data_limit_bytes, f_rate_limit, f_devices, f_bind_mac, f_scope, f_site_id)
    VALUES (v_tenant, p.id, v_code, 'import', p.prix_xof, p.uptime_limit_s, p.validity_s,
            p.data_limit_bytes, p.rate_limit, p.devices, p.bind_mac, p.scope, p.site_id)
    ON CONFLICT (tenant_id, code) DO NOTHING;
    statut := CASE WHEN FOUND THEN 'importe' ELSE 'doublon' END;
    RETURN NEXT;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION app.voucher_importer(bigint[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.voucher_importer(bigint[], text[]) TO wk_api;

-- Moindre privilège (revue Standards) : aucune route ne lit les forfaits ni les tickets ; les
-- codes de ticket valent accès. L'import passe par la fonction ci-dessus.
REVOKE SELECT ON app.plan, app.voucher FROM wk_api;

RESET ROLE;
