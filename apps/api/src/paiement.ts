// WAKATNET — service de paiement : création, webhooks, rapprochement (SPEC §7.2, ADR 0013 §1, §2).
// Tickets : .scratch/phase-3-portail-paiement/issues/03-paiements-mock.md, 04-confirmation-credits.md
//
// A5 : SEUL verify() (appel de serveur à serveur) fait passer un paiement à SUCCEEDED. Le webhook
// n'est qu'un déclencheur ; le navigateur, jamais. Toute transition passe par
// app.paiement_transition (ligne verrouillée, idempotente), qui crée ticket et commission dans la
// même transaction SQL (A7).
import { randomBytes } from "node:crypto";
import {
  FournisseurIndisponible, PaiementRefuse, SignatureInvalide, masquerNumero, normaliserNumero, versXof,
  type FournisseurPaiement, type LivreurWebhook, type Operateur,
} from "../../../packages/payments/src/index.ts";
import type { Base } from "./base.ts";
import { chiffrer, dechiffrer, hmacNumero } from "./chiffrement.ts";
import { creerFournisseur, type ClesMarchand } from "./fournisseurs.ts";

export const DELAI_CHARGE_MS = 15_000;
/** verify() aussi est borné : un fournisseur muet ne doit jamais bloquer la tâche périodique (revue). */
export const DELAI_VERIFY_MS = 10_000;

export type Cles = { marchands: Buffer; hmac: Buffer };

type LigneCompte = { fournisseur: string; cles: Buffer; webhook_id: string };

export class ServicePaiement {
  /** Livraison des webhooks du MockProvider (en interne, vers la route publique). */
  livreur: ((fournisseur: string, webhookId: string) => LivreurWebhook) | null = null;

  private readonly base: Base;
  private readonly cles: Cles;

  constructor(base: Base, cles: Cles) {
    this.base = base;
    this.cles = cles;
  }

  // ---------------------------------------------------------------- compte marchand
  chiffrerCles(tenantId: bigint, cles: ClesMarchand): Buffer {
    return chiffrer(this.cles.marchands, Buffer.from(JSON.stringify(cles)), `tenant:${tenantId}`);
  }

  private fournisseurDe(tenantId: bigint, l: { fournisseur: string; cles: Buffer; webhook_id?: string }): FournisseurPaiement {
    const cles = JSON.parse(dechiffrer(this.cles.marchands, l.cles, `tenant:${tenantId}`).toString("utf8")) as ClesMarchand;
    const livrer = this.livreur && l.webhook_id ? this.livreur(l.fournisseur, l.webhook_id) : null;
    return creerFournisseur(l.fournisseur, cles, livrer);
  }

  async fournisseurDuProprietaire(tenantId: bigint): Promise<FournisseurPaiement | null> {
    const [l] = await this.base.$queryRaw<LigneCompte[]>`
      SELECT fournisseur, cles, webhook_id FROM app.compte_marchand_du_proprietaire(${tenantId})`;
    return l ? this.fournisseurDe(tenantId, l) : null;
  }

  // ---------------------------------------------------------------- création (portail)
  async creer(e: {
    sitePublic: string; planId: bigint; operateur: Operateur; numero: string; otp?: string;
    jetonAppareil: Buffer; soumission: string;
  }): Promise<
    | { statut: "cree" | "deja"; reference: string; statutPaiement: string; message?: string }
    | { statut: "site_inconnu" | "forfait_inconnu" | "vente_suspendue" | "sans_compte_marchand" | "numero_invalide" | "trop_de_demandes" }
  > {
    const numero = normaliserNumero(e.numero);
    if (numero === null) return { statut: "numero_invalide" };
    const reference = `wk_${randomBytes(16).toString("base64url")}`;
    const [r] = await this.base.$queryRaw<{ statut: string; reference: string | null; montant: bigint | null;
                                            tenant_id: bigint | null; statut_paiement: string | null }[]>`
      SELECT statut, reference, montant, tenant_id, statut_paiement
        FROM app.paiement_creer(${e.sitePublic}, ${e.planId}, ${e.operateur}, ${numero}, ${hmacNumero(this.cles.hmac, numero)},
                                ${masquerNumero(numero)}, ${e.jetonAppareil}, ${e.soumission}, ${reference})`;
    if (r.statut !== "cree" && r.statut !== "deja") return { statut: r.statut as "site_inconnu" };
    if (r.statut === "deja") return { statut: "deja", reference: r.reference!, statutPaiement: r.statut_paiement! };

    const fournisseur = await this.fournisseurDuProprietaire(r.tenant_id!);
    if (fournisseur === null) return { statut: "sans_compte_marchand" };
    try {
      const montant = Number(r.montant!);
      if (!Number.isSafeInteger(montant) || montant <= 0) throw new Error("montant du paiement hors des entiers sûrs (A1)");
      const res = await avecDelai(fournisseur.charge({
        reference: r.reference!, montant, devise: "XOF", operateur: e.operateur, numero, otp: e.otp,
      }), DELAI_CHARGE_MS);
      const s = await this.transition(r.reference!, "PENDING", res.referenceFournisseur, null, null, "charge");
      return { statut: "cree", reference: r.reference!, statutPaiement: s };
    } catch (err) {
      if (err instanceof PaiementRefuse) {
        const s = await this.transition(r.reference!, "FAILED", null, null, null, "charge");
        return { statut: "cree", reference: r.reference!, statutPaiement: s, message: "paiement refusé par l'opérateur" };
      }
      if (err instanceof FournisseurIndisponible || err instanceof DelaiDepasse) {
        // P8 : le paiement reste CREATED ; le rapprochement le reprendra ou l'expirera.
        return { statut: "cree", reference: r.reference!, statutPaiement: "CREATED",
                 message: "le service de paiement ne répond pas ; réessayez dans quelques minutes" };
      }
      throw err;
    }
  }

  private async transition(reference: string, vers: string, refF: string | null, montant: bigint | null,
                           devise: string | null, origine: string): Promise<string> {
    const [t] = await this.base.$queryRaw<{ s: string }[]>`
      SELECT app.paiement_transition(${reference}, ${vers}, ${refF}, ${montant}::bigint, ${devise}, ${origine}) AS s`;
    return t.s;
  }

  // ---------------------------------------------------------------- rapprochement (verify fait foi)
  /** Interroge le fournisseur et applique son verdict. Rend le statut résultant. */
  async rapprocher(reference: string, tenantId: bigint, fournisseur?: FournisseurPaiement, origine = "verify"): Promise<string> {
    const f = fournisseur ?? await this.fournisseurDuProprietaire(tenantId);
    if (f === null) return "sans_compte_marchand";
    const etat = await avecDelai(f.verify(reference), DELAI_VERIFY_MS);
    if (etat.reference !== reference) throw new Error("verify : référence inattendue");
    if (etat.statut === "SUCCEEDED") {
      // A8 : montant du fournisseur normalisé en XOF entier ; illisible → MISMATCH (montant -1).
      let montant: bigint;
      try { montant = BigInt(versXof(etat.montant)); } catch { montant = -1n; }
      return this.transition(reference, "SUCCEEDED", etat.referenceFournisseur ?? null, montant, etat.devise, origine);
    }
    if (etat.statut === "FAILED") return this.transition(reference, "FAILED", etat.referenceFournisseur ?? null, null, null, origine);
    return this.transition(reference, "PENDING", etat.referenceFournisseur ?? null, null, null, origine);
  }

  // ---------------------------------------------------------------- webhook (route publique)
  async webhook(fournisseurId: string, webhookId: string, enTetes: Record<string, string | string[] | undefined>,
                corps: Buffer): Promise<{ code: 200 | 400 | 401 | 404; corps: object }> {
    const [compte] = await this.base.$queryRaw<{ tenant_id: bigint; cles: Buffer }[]>`
      SELECT tenant_id, cles FROM app.compte_marchand_par_webhook(${fournisseurId}, ${webhookId})`;
    if (!compte) return { code: 404, corps: { erreur: "inconnu" } };
    const f = this.fournisseurDe(compte.tenant_id, { fournisseur: fournisseurId, cles: compte.cles, webhook_id: webhookId });
    let evt;
    try {
      evt = f.parseWebhook(enTetes, corps);
    } catch (e) {
      if (e instanceof SignatureInvalide) return { code: 401, corps: { erreur: "signature invalide" } };   // P5 : aucun effet
      throw e;
    }
    // Valeurs du fournisseur bornées avant toute écriture : une valeur hors contrainte ne doit pas
    // devenir une erreur 500 (revue).
    if (evt.idEvenement.length < 1 || evt.idEvenement.length > 200 || !/^wk_[A-Za-z0-9_-]{22}$/.test(evt.reference)) {
      return { code: 400, corps: { erreur: "événement invalide" } };
    }
    await this.base.$queryRaw`SELECT app.paiement_evenement(${fournisseurId}, ${evt.idEvenement}, ${compte.tenant_id},
                                                            ${evt.reference}, ${corps})`;
    const [p] = await this.base.$queryRaw<{ statut: string }[]>`
      SELECT statut FROM app.paiement_du_proprietaire(${evt.reference}, ${compte.tenant_id})`;
    if (!p) return { code: 200, corps: { ok: true, ignore: "paiement inconnu de ce compte" } };
    const statut = await this.rapprocher(evt.reference, compte.tenant_id, f, "webhook");
    return { code: 200, corps: { ok: true, statut } };
  }
}

class DelaiDepasse extends Error {}

function avecDelai<T>(p: Promise<T>, ms: number): Promise<T> {
  let minuterie: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(minuterie)),
    new Promise<never>((_, rejeter) => { minuterie = setTimeout(() => rejeter(new DelaiDepasse("délai du fournisseur dépassé")), ms); }),
  ]);
}
