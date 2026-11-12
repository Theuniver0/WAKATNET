// WAKATNET — reversements du mode B (verrouillé, ADR 0001) : règle P10 (ADR 0014 §9).
// Ticket : .scratch/phase-4-exploitation/issues/07-mode-b-p10.md
//
//   1. Avant tout appel au fournisseur, le reversement passe en EN_DOUTE (écrit et validé).
//   2. Une coupure laisse EN_DOUTE : un tour ultérieur (120 s au moins, plancher posé en base)
//      demande verifyPayout() AVANT tout renvoi.
//   3. verifyPayout() « réussi » ou « échoué » : verdict enregistré, RIEN n'est renvoyé.
//      « inconnu » : le fournisseur n'a jamais reçu l'ordre ; seul cas de renvoi, par
//      comparaison-échange sur `envois` (5 au plus, puis décision humaine).
//   4. À l'expiration du délai, la requête est ANNULÉE (AbortSignal), pas seulement abandonnée.
// Aucune écriture comptable ici : le plan comptable du mode B attend le comptable (ADR 0014 §9).
// Aucun appelant tant que le mode B est verrouillé : rôle dédié et plafond par opération (SPEC §8.3)
// sont des préalables à sa levée.
import { FournisseurIndisponible, PaiementRefuse, type FournisseurPaiement } from "../../../packages/payments/src/index.ts";
import type { Base } from "./base.ts";

export const DELAI_REVERSEMENT_MS = 15_000;

/** Appel borné : à l'expiration, le signal annule la requête et la promesse est rejetée. */
async function borne<T>(appel: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const c = new AbortController();
  let m: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([appel(c.signal),
      new Promise<never>((_, ko) => { m = setTimeout(() => { c.abort(); ko(new FournisseurIndisponible("délai dépassé")); }, ms); })]);
  } finally {
    clearTimeout(m);
  }
}

export type Reversement = { reference: string; montant: bigint; statut: string; envois: number };

/** Un pas de traitement d'un reversement ; rend son statut après ce pas. */
export async function traiterReversement(base: Base, f: FournisseurPaiement, r: Reversement, destination: string,
  delaiMs = DELAI_REVERSEMENT_MS): Promise<string> {
  if (!f.payout || !f.verifyPayout) throw new Error(`fournisseur ${f.id} : pas de reversement`);
  const verdict = async (statut: string, refF: string | null) => {
    const [x] = await base.$queryRaw<{ s: string }[]>`SELECT app.reversement_verdict(${r.reference}, ${statut}, ${refF}) AS s`;
    return x.s;
  };
  const envoyer = async (): Promise<string> => {
    try {
      const res = await borne((signal) => f.payout!({ reference: r.reference, montant: Number(r.montant), devise: "XOF", destination, signal }), delaiMs);
      if (res.statut === "SUCCEEDED" || res.statut === "FAILED") return verdict(res.statut, res.referenceFournisseur);
      if (res.statut === "PENDING") return verdict("SENT", res.referenceFournisseur);
      return "EN_DOUTE";                                                 // « inconnu » à l'envoi : on ne sait pas
    } catch (e) {
      if (e instanceof FournisseurIndisponible) return "EN_DOUTE";      // réponse perdue : on ne sait pas
      if (e instanceof PaiementRefuse) return verdict("FAILED", null);  // reçu et refusé : rien n'est payé
      throw e;
    }
  };

  if (r.statut === "CREATED") {
    const [{ ok }] = await base.$queryRaw<{ ok: boolean }[]>`SELECT app.reversement_avant_envoi(${r.reference}) AS ok`;
    return ok ? envoyer() : "EN_DOUTE";
  }
  // EN_DOUTE ou SENT : verifyPayout() d'abord, TOUJOURS (P10).
  const v = await borne((signal) => f.verifyPayout!(r.reference, signal), delaiMs);
  if (v.statut === "SUCCEEDED" || v.statut === "FAILED") return verdict(v.statut, v.referenceFournisseur ?? null);
  if (v.statut === "INCONNU" && r.statut === "EN_DOUTE") {
    const [{ ok }] = await base.$queryRaw<{ ok: boolean }[]>`SELECT app.reversement_renvoi_permis(${r.reference}, ${r.envois}::int) AS ok`;
    return ok ? envoyer() : r.statut;
  }
  // PENDING, ou SENT et « inconnu » (incohérence du fournisseur) : on attend, sans renvoyer.
  return r.statut;
}

/** Un tour sur les reversements à traiter. Une erreur sur l'un n'arrête pas les suivants : elle
 *  est rendue avec lui, et il reste dans son état (sûr pour l'argent). */
export async function tourReversements(base: Base, f: FournisseurPaiement, destination: (tenant: bigint) => Promise<string>,
  ageMinS = 120, delaiMs = DELAI_REVERSEMENT_MS): Promise<Record<string, { statut: string; erreur?: string }>> {
  const lot = await base.$queryRaw<(Reversement & { tenant_id: bigint })[]>`
    SELECT reference, tenant_id, montant, statut, envois FROM app.reversements_a_traiter(100, ${ageMinS}::int)`;
  const res: Record<string, { statut: string; erreur?: string }> = {};
  for (const r of lot) {
    try {
      res[r.reference] = { statut: await traiterReversement(base, f, r, await destination(r.tenant_id), delaiMs) };
    } catch (e) {
      res[r.reference] = { statut: r.statut, erreur: (e as Error).message };
    }
  }
  return res;
}
