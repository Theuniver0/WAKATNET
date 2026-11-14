// WAKATNET — fabrique des fournisseurs de paiement, un par compte marchand (mode A, ADR 0013 §1).
// « mock » : développement et tests seulement, refusé en production. « moneyfusion » : ADR 0024, seul agrégateur réel
// (pawaPay et CinetPay retirés le 14/11/2026, décision de Yacouba). MoneyFusion n'a PAS de bac à sable documenté : un
// compte MoneyFusion encaisse de l'argent réel. Il n'est donc accepté qu'une fois G-ARGENT franchie, par
// WAKATNET_ARGENT_REEL=1, que Yacouba pose lui-même (SPEC §12) ; les tests passent par un faux serveur local.
import { FORME_LIEN_API, MockProvider, MoneyfusionProvider, type FournisseurPaiement, type LivreurWebhook } from "../../../packages/payments/src/index.ts";

export const FOURNISSEURS = ["mock", "moneyfusion"] as const;
export type IdFournisseur = (typeof FOURNISSEURS)[number];

export class FournisseurInconnu extends Error {}

/** Clés du compte marchand, telles que saisies par le propriétaire (puis chiffrées). */
export type ClesMarchand = Record<string, string>;

const mockPermis = () => process.env.WAKATNET_MOCK === "1" && process.env.NODE_ENV !== "production";

/** Faux serveur MoneyFusion des tests (WAKATNET_MONEYFUSION_URL) : adresse locale seulement, jamais en production. */
function urlMoneyfusionDeTest(): string | undefined {
  const u = process.env.WAKATNET_MONEYFUSION_URL;
  if (!u) return undefined;
  if (process.env.NODE_ENV === "production" || !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(u)) {
    throw new FournisseurInconnu("WAKATNET_MONEYFUSION_URL : faux serveur local de test seulement");
  }
  return u;
}

/** Lien API accepté : celui du faux serveur en test ; sinon un vrai lien MoneyFusion, et seulement après G-ARGENT. */
function lienApiValide(lien: unknown): string {
  const test = urlMoneyfusionDeTest();
  if (typeof lien !== "string" || lien.length > 600) throw new FournisseurInconnu("clés : lien API MoneyFusion attendu");
  if (test !== undefined) {
    if (!lien.startsWith(`${test}/`)) throw new FournisseurInconnu("clés : lien API du faux serveur de test attendu");
    return lien;
  }
  if (!FORME_LIEN_API.test(lien)) throw new FournisseurInconnu("clés : lien API MoneyFusion attendu (https://…moneyfusion.net/…)");
  if (process.env.WAKATNET_ARGENT_REEL !== "1") {
    throw new FournisseurInconnu("argent réel non ouvert : G-ARGENT n'est pas franchie (MoneyFusion n'a pas de bac à sable)");
  }
  return lien;
}

export function validerCles(fournisseur: string, cles: unknown): ClesMarchand {
  if (typeof cles !== "object" || cles === null) throw new FournisseurInconnu("clés : objet attendu");
  const c = cles as Record<string, unknown>;
  if (fournisseur === "mock" && mockPermis()) {
    const secret = c.secret_webhook;
    if (typeof secret !== "string" || secret.length < 16 || secret.length > 256) {
      throw new FournisseurInconnu("clés : secret_webhook de 16 à 256 caractères");
    }
    return { secret_webhook: secret };
  }
  if (fournisseur === "moneyfusion") return { lien_api: lienApiValide(c.lien_api) };
  throw new FournisseurInconnu(`fournisseur inconnu : ${fournisseur}`);
}

/** `urls.webhook` : adresse publique du webhook de ce compte marchand, transmise à chaque paiement (MoneyFusion). */
export function creerFournisseur(fournisseur: string, cles: ClesMarchand, livrer: LivreurWebhook | null,
                                 urls: { webhook?: string } = {}): FournisseurPaiement {
  if (fournisseur === "mock") return new MockProvider(cles.secret_webhook, livrer);
  if (fournisseur === "moneyfusion") {
    const lien = lienApiValide(cles.lien_api);
    const test = urlMoneyfusionDeTest();
    return new MoneyfusionProvider({ lienApi: lien }, {
      ...(urls.webhook ? { urlWebhook: urls.webhook } : {}),
      ...(test ? { urlStatut: `${test}/paiementNotif/`, formeUrlPaiement: new RegExp(`^${test.replace(/[.]/g, "\\.")}/payment/[A-Za-z0-9_-]+$`) } : {}),
    });
  }
  throw new FournisseurInconnu(`fournisseur inconnu : ${fournisseur}`);
}
