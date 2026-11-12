// WAKATNET — fabrique des fournisseurs de paiement, un par compte marchand (mode A, ADR 0013 §1).
// « mock » : développement et tests seulement, refusé en production. « pawapay » : ADR 0020. Son environnement
// « production » (argent réel) n'est accepté qu'une fois G-ARGENT franchie, par WAKATNET_ARGENT_REEL=1, que Yacouba
// pose lui-même (SPEC §12).
import { MockProvider, PawapayProvider, type FournisseurPaiement, type LivreurWebhook } from "../../../packages/payments/src/index.ts";

export const FOURNISSEURS = ["mock", "pawapay"] as const;
export type IdFournisseur = (typeof FOURNISSEURS)[number];

export class FournisseurInconnu extends Error {}

/** Clés du compte marchand, telles que saisies par le propriétaire (puis chiffrées). */
export type ClesMarchand = Record<string, string>;

const mockPermis = () => process.env.WAKATNET_MOCK === "1" && process.env.NODE_ENV !== "production";

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
  if (fournisseur === "pawapay") {
    const { jeton, environnement } = c;
    if (typeof jeton !== "string" || !/^[A-Za-z0-9._-]{20,4096}$/.test(jeton)) throw new FournisseurInconnu("clés : jeton d'API pawaPay attendu");
    if (environnement !== "sandbox" && environnement !== "production") throw new FournisseurInconnu("clés : environnement « sandbox » ou « production »");
    if (environnement === "production" && process.env.WAKATNET_ARGENT_REEL !== "1") {
      throw new FournisseurInconnu("argent réel non ouvert : G-ARGENT n'est pas franchie (seul le bac à sable est accepté)");
    }
    // Relecture (ADR 0020) : en production, un compte de bac à sable délivrerait de vrais tickets à quiconque saisit un
    // numéro de test public de pawaPay. Le bac à sable sert sur une plateforme d'essai, jamais sur la vraie.
    if (environnement === "sandbox" && process.env.NODE_ENV === "production") {
      throw new FournisseurInconnu("bac à sable interdit sur la plateforme de production (ses numéros de test délivreraient des tickets)");
    }
    return { jeton, environnement };
  }
  throw new FournisseurInconnu(`fournisseur inconnu : ${fournisseur}`);
}

/** URL de base de pawaPay remplacée pour les tests : faux serveur local seulement ; refusée en production et pour un
 *  compte d'argent réel (le vrai jeton n'irait jamais vers une autre adresse). */
function urlPawapayDeTest(environnement: string): string | undefined {
  const u = process.env.WAKATNET_PAWAPAY_URL;
  if (!u) return undefined;
  if (process.env.NODE_ENV === "production" || environnement === "production" || !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(u)) {
    throw new FournisseurInconnu("WAKATNET_PAWAPAY_URL : faux serveur local de test seulement");
  }
  return u;
}

export function creerFournisseur(fournisseur: string, cles: ClesMarchand, livrer: LivreurWebhook | null): FournisseurPaiement {
  if (fournisseur === "mock") return new MockProvider(cles.secret_webhook, livrer);
  if (fournisseur === "pawapay") {
    if (cles.environnement === "production" && process.env.WAKATNET_ARGENT_REEL !== "1") {
      throw new FournisseurInconnu("argent réel non ouvert (G-ARGENT)");
    }
    if (cles.environnement !== "production" && process.env.NODE_ENV === "production") {
      throw new FournisseurInconnu("bac à sable interdit sur la plateforme de production");
    }
    const urlBase = urlPawapayDeTest(cles.environnement);
    return new PawapayProvider({ jeton: cles.jeton, environnement: cles.environnement === "production" ? "production" : "sandbox" },
                               urlBase ? { urlBase } : {});
  }
  throw new FournisseurInconnu(`fournisseur inconnu : ${fournisseur}`);
}
