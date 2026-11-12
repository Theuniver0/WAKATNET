// WAKATNET — fabrique des fournisseurs de paiement, un par compte marchand (mode A, ADR 0013 §1).
// Le vrai adaptateur (ticket 08) attend les clés de bac à sable : seul « mock » existe, et il est
// refusé en production par le MockProvider lui-même.
import { MockProvider, type FournisseurPaiement, type LivreurWebhook } from "../../../packages/payments/src/index.ts";

export const FOURNISSEURS = ["mock"] as const;
export type IdFournisseur = (typeof FOURNISSEURS)[number];

export class FournisseurInconnu extends Error {}

/** Clés du compte marchand, telles que saisies par le propriétaire (puis chiffrées). */
export type ClesMarchand = Record<string, string>;

export function validerCles(fournisseur: string, cles: unknown): ClesMarchand {
  if (fournisseur !== "mock" || process.env.WAKATNET_MOCK !== "1" || process.env.NODE_ENV === "production") {
    throw new FournisseurInconnu(`fournisseur inconnu : ${fournisseur}`);
  }
  if (typeof cles !== "object" || cles === null) throw new FournisseurInconnu("clés : objet attendu");
  const secret = (cles as Record<string, unknown>).secret_webhook;
  if (typeof secret !== "string" || secret.length < 16 || secret.length > 256) {
    throw new FournisseurInconnu("clés : secret_webhook de 16 à 256 caractères");
  }
  return { secret_webhook: secret };
}

export function creerFournisseur(fournisseur: string, cles: ClesMarchand, livrer: LivreurWebhook | null): FournisseurPaiement {
  if (fournisseur === "mock") return new MockProvider(cles.secret_webhook, livrer);
  throw new FournisseurInconnu(`fournisseur inconnu : ${fournisseur}`);
}
