-- WAKATNET — migration 0038 : rôle dédié de l'outil de rapprochement, en lecture seule (audit de sécurité de l'outil,
-- constat 4 : PILOTE.md le faisait lancer en superutilisateur postgres). Références : docs/PILOTE.md §4 ; SPEC §12
-- (phase 6) ; CONTRIBUTING A2, C7, S1 ; apps/api/src/rapprochement.ts.
--
-- wk_rapprochement : LOGIN, et RIEN d'autre que deux fonctions de lecture qui rendent exactement ce que lisaient les deux
-- requêtes de l'outil (app.payment ; app.tenant, app.audit_log, ledger.transaction, ledger.ecriture, ledger.compte et
-- ledger.commission). Pourquoi des fonctions plutôt que des SELECT directs : aucun rôle de connexion n'a de droit sur le
-- schéma ledger (ADR 0013 §11 ; apps/api/tests/ledger.test.ts) ; le rôle n'a ainsi aucun droit sur une table, ni
-- BYPASSRLS, ni politique RLS à lui (les fonctions du propriétaire ne sont pas soumises à la RLS, comme app.sante()).
-- Transactions en lecture seule par défaut, en plus du BEGIN … READ ONLY de l'outil.
-- Mot de passe : WAKATNET_PG_RAPPROCHEMENT_PASSWORD (migrer.sh), jamais dans le dépôt.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wk_rapprochement') THEN
    CREATE ROLE wk_rapprochement LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
ALTER ROLE wk_rapprochement SET default_transaction_read_only = on;
-- Lancé à la main sur le primaire : une requête qui s'éternise ne doit pas retenir son instantané (REPEATABLE READ).
ALTER ROLE wk_rapprochement SET statement_timeout = '60s';
ALTER ROLE wk_rapprochement SET idle_in_transaction_session_timeout = '60s';
GRANT USAGE ON SCHEMA app TO wk_rapprochement;

SET ROLE wakatnet_owner;

-- Première requête de l'outil : paiements du propriétaire confirmés dans [J − 2, J + 3[, ou portant une référence du relevé.
-- Bornes du jour en UTC (heure du Burkina), quel que soit le fuseau de la session.
CREATE FUNCTION app.rapprochement_paiements(p_tenant bigint, p_jour date, p_refs text[])
RETURNS TABLE (reference text, reference_fournisseur text, montant bigint, statut text, confirme_le timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET timezone = 'UTC'
AS $$
  SELECT p.reference, p.reference_fournisseur, p.montant, p.statut, p.confirme_le
    FROM app.payment p
   WHERE p.tenant_id = p_tenant
     AND (p.confirme_le >= p_jour - 2 AND p.confirme_le < p_jour + 3
          OR p.reference = ANY (p_refs) OR p.reference_fournisseur = ANY (p_refs))
$$;

-- Seconde requête : pour chaque paiement réussi confirmé le jour J, ses commissions au grand livre (nombre, somme des
-- débits au compte du propriétaire, taux), la valeur figée au journal d'audit de la confirmation, et la commission
-- attendue au taux et au plancher en vigueur.
CREATE FUNCTION app.rapprochement_commissions(p_tenant bigint, p_jour date)
RETURNS TABLE (reference text, nombre integer, ecriture bigint, figee bigint, taux integer, taux_en_vigueur integer, attendue bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET timezone = 'UTC'
AS $$
  SELECT p.reference,
         (SELECT count(*)::integer FROM ledger.transaction x WHERE x.objet = 'paiement:' || p.id AND x.nature = 'commission'),
         (SELECT sum(e.debit)::bigint FROM ledger.transaction x JOIN ledger.ecriture e ON e.transaction_id = x.id
            JOIN ledger.compte k ON k.id = e.compte_id AND k.code = 'proprietaire:' || p.tenant_id || ':credits'
           WHERE x.objet = 'paiement:' || p.id AND x.nature = 'commission'),
         (SELECT max((a.details->>'commission')::bigint) FROM app.audit_log a
           WHERE a.objet = 'paiement:' || p.id AND a.action IN ('paiement_confirme', 'paiement_succes_apres_expiration')),
         (SELECT max(x.taux_bps) FROM ledger.transaction x WHERE x.objet = 'paiement:' || p.id AND x.nature = 'commission'),
         t.commission_bps,
         ledger.commission(p.montant, t.commission_bps, t.commission_min)
    FROM app.payment p JOIN app.tenant t ON t.id = p.tenant_id
   WHERE p.tenant_id = p_tenant AND p.statut = 'SUCCEEDED' AND p.confirme_le >= p_jour AND p.confirme_le < p_jour + 1
$$;

REVOKE ALL ON FUNCTION app.rapprochement_paiements(bigint, date, text[]), app.rapprochement_commissions(bigint, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rapprochement_paiements(bigint, date, text[]), app.rapprochement_commissions(bigint, date) TO wk_rapprochement;

RESET ROLE;
