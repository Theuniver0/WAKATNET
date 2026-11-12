-- WAKATNET — migration 0026 : une vente en ligne est datée par sa CONFIRMATION (phase 4, ticket 05).
-- Ticket : .scratch/phase-4-exploitation/issues/05-argent-releves.md ; relecture argent de la phase 4 (I4).
--
-- Défaut corrigé : relevé, synthèse et vue du super-admin dataient une vente par `payment.maj_le`,
-- que `paiement_retrouver` (0021) et toute transition remettent à l'heure courante. Une vente
-- confirmée le 31/01 à 23 h 50, retrouvée le 01/02, quittait le relevé de janvier (où reste sa
-- commission) pour celui de février : un relevé déjà remis changeait après coup.
-- `confirme_le` est posé UNE fois, par déclencheur, au passage à SUCCEEDED, et ne bouge plus.

SET ROLE wakatnet_owner;

ALTER TABLE app.payment ADD COLUMN confirme_le timestamptz;
-- Reprise : pour les paiements déjà confirmés, maj_le est la meilleure date connue.
UPDATE app.payment SET confirme_le = maj_le WHERE statut = 'SUCCEEDED';
ALTER TABLE app.payment ADD CONSTRAINT payment_confirme_le_si_succes CHECK (statut <> 'SUCCEEDED' OR confirme_le IS NOT NULL);
CREATE INDEX payment_tenant_confirme_le ON app.payment (tenant_id, confirme_le) WHERE confirme_le IS NOT NULL;

CREATE FUNCTION app._paiement_confirme_le()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.confirme_le := OLD.confirme_le;                 -- jamais réécrite après coup
  ELSE
    NEW.confirme_le := NULL;
  END IF;
  IF NEW.statut = 'SUCCEEDED' AND NEW.confirme_le IS NULL THEN
    NEW.confirme_le := now();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app._paiement_confirme_le() FROM PUBLIC;
CREATE TRIGGER paiement_confirme_le BEFORE INSERT OR UPDATE ON app.payment
  FOR EACH ROW EXECUTE FUNCTION app._paiement_confirme_le();

-- Mêmes signatures (droits conservés) ; seule la date de la vente change.
CREATE OR REPLACE FUNCTION app.releve(p_debut timestamptz, p_fin timestamptz)
RETURNS TABLE (le timestamptz, nature text, objet text, debit_xof bigint, credit_xof bigint,
               vente_xof bigint, numero_masque text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, ledger, pg_temp
AS $$
  SELECT x.cree_le, x.nature, x.objet, e.debit, e.credit, NULL::bigint, NULL::text
    FROM ledger.transaction x JOIN ledger.ecriture e ON e.transaction_id = x.id
    JOIN ledger.compte c ON c.id = e.compte_id
   WHERE c.code = 'proprietaire:' || app.tenant_courant() || ':credits'
     AND x.cree_le >= p_debut AND x.cree_le < p_fin
  UNION ALL
  SELECT p.confirme_le, 'vente_en_ligne', 'paiement:' || p.id, 0, 0, p.montant, p.numero_masque
    FROM app.payment p
   WHERE p.tenant_id = app.tenant_courant() AND p.statut = 'SUCCEEDED'
     AND p.confirme_le >= p_debut AND p.confirme_le < p_fin
  ORDER BY 1, 3
$$;

CREATE OR REPLACE FUNCTION app.synthese_argent(p_debut timestamptz, p_fin timestamptz)
RETURNS TABLE (ventes_en_ligne bigint, ventes_en_ligne_xof bigint, tickets_papier_actives bigint,
               tickets_papier_xof bigint, commissions_xof bigint, frais_papier_xof bigint, recharges_xof bigint,
               solde_credits_xof bigint, plafond_decouvert_xof bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, ledger, pg_temp
AS $$
  WITH t AS (SELECT app.tenant_courant() AS id),
  mvt AS (
    SELECT x.nature, sum(e.debit) AS d, sum(e.credit) AS c
      FROM ledger.transaction x JOIN ledger.ecriture e ON e.transaction_id = x.id
      JOIN ledger.compte k ON k.id = e.compte_id, t
     WHERE k.code = 'proprietaire:' || t.id || ':credits' AND x.cree_le >= p_debut AND x.cree_le < p_fin
     GROUP BY x.nature)
  SELECT
    (SELECT count(*) FROM app.payment p, t WHERE p.tenant_id = t.id AND p.statut = 'SUCCEEDED' AND p.confirme_le >= p_debut AND p.confirme_le < p_fin),
    (SELECT coalesce(sum(p.montant), 0) FROM app.payment p, t WHERE p.tenant_id = t.id AND p.statut = 'SUCCEEDED' AND p.confirme_le >= p_debut AND p.confirme_le < p_fin)::bigint,
    (SELECT count(*) FROM app.voucher v, t WHERE v.tenant_id = t.id AND v.batch_id IS NOT NULL AND v.activated_at >= p_debut AND v.activated_at < p_fin),
    (SELECT coalesce(sum(v.f_prix_xof), 0) FROM app.voucher v, t WHERE v.tenant_id = t.id AND v.batch_id IS NOT NULL AND v.activated_at >= p_debut AND v.activated_at < p_fin)::bigint,
    coalesce((SELECT d - c FROM mvt WHERE nature = 'commission'), 0)::bigint,
    coalesce((SELECT d - c FROM mvt WHERE nature = 'frais_papier'), 0)::bigint,
    coalesce((SELECT c - d FROM mvt WHERE nature = 'recharge'), 0)::bigint,
    (SELECT app.credits_solde(t.id) FROM t),
    (SELECT tn.plafond_decouvert FROM app.tenant tn, t WHERE tn.id = t.id)
$$;

CREATE OR REPLACE FUNCTION app.admin_proprietaires(p_debut timestamptz, p_fin timestamptz)
RETURNS TABLE (tenant_id bigint, nom text, suspendu boolean, commission_bps integer, plafond_decouvert bigint,
               solde_credits_xof bigint, ventes_en_ligne_xof bigint, commissions_xof bigint, frais_papier_xof bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, ledger, pg_temp
AS $$
  SELECT t.id, t.nom, t.suspendu, t.commission_bps, t.plafond_decouvert, app.credits_solde(t.id),
         (SELECT coalesce(sum(p.montant), 0) FROM app.payment p
           WHERE p.tenant_id = t.id AND p.statut = 'SUCCEEDED' AND p.confirme_le >= p_debut AND p.confirme_le < p_fin)::bigint,
         (SELECT coalesce(sum(e.debit - e.credit), 0) FROM ledger.transaction x JOIN ledger.ecriture e ON e.transaction_id = x.id
            JOIN ledger.compte k ON k.id = e.compte_id
           WHERE k.code = 'proprietaire:' || t.id || ':credits' AND x.nature = 'commission'
             AND x.cree_le >= p_debut AND x.cree_le < p_fin)::bigint,
         (SELECT coalesce(sum(e.debit - e.credit), 0) FROM ledger.transaction x JOIN ledger.ecriture e ON e.transaction_id = x.id
            JOIN ledger.compte k ON k.id = e.compte_id
           WHERE k.code = 'proprietaire:' || t.id || ':credits' AND x.nature = 'frais_papier'
             AND x.cree_le >= p_debut AND x.cree_le < p_fin)::bigint
    FROM app.tenant t ORDER BY t.id
$$;

RESET ROLE;
