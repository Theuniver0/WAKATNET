// WAKATNET — MockProvider scriptable (SPEC §7.3) : P1 à P9 sans agrégateur réel.
// Ticket : .scratch/phase-3-portail-paiement/issues/03-paiements-mock.md
//
// Le scénario se lit dans les deux DERNIERS chiffres du numéro du payeur, pour que les tests
// de bout en bout (navigateur) le choisissent sans canal de contrôle :
//   00  succès ; webhook livré après la réponse de charge()          (cas normal)
//   01  refus du paiement                                              (FAILED)
//   02  succès, webhook JAMAIS livré : seul le rapprochement le voit   (P3)
//   03  succès, même webhook livré 5 fois                              (P1)
//   04  succès, webhook livré AVANT la réponse de charge()             (P2)
//   05  succès d'un montant différent (+5 F)                           (P4)
//   06  fournisseur en panne : charge() lève FournisseurIndisponible   (P8)
//   07  reste PENDING jusqu'à confirmer() (succès tardif, après expiration : P7)
//   08  verify() ne répond jamais (fournisseur muet : la tâche périodique ne doit pas s'y bloquer)
//   09  succès d'un montant ILLISIBLE (décimal) : A8, MISMATCH
//   autres : comme 00.
// Exige WAKATNET_MOCK=1 (et jamais NODE_ENV=production).
// Les webhooks sont signés HMAC-SHA-256 du corps brut avec le secret du compte marchand
// (en-tête x-mock-signature). INTERDIT en production.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  FournisseurIndisponible, PaiementRefuse, SignatureInvalide,
  type Capacites, type DemandePaiement, type EtatPaiement, type EvenementWebhook, type FournisseurPaiement, type ResultatPaiement,
} from "./fournisseur.ts";

export type LivreurWebhook = (enTetes: Record<string, string>, corps: Buffer) => Promise<void>;

type Enregistrement = { demande: DemandePaiement; refF: string; statut: EtatPaiement["statut"]; montant: number };

/** État partagé par toutes les instances d'un même secret (un compte marchand = un secret). */
const PAIEMENTS = new Map<string, Enregistrement>();

export class MockProvider implements FournisseurPaiement {
  readonly id = "mock";

  private readonly secret: string;
  private readonly livrer: LivreurWebhook | null;

  constructor(secret: string, livrer: LivreurWebhook | null) {
    this.secret = secret;
    this.livrer = livrer;
    // Autorisation EXPLICITE (relecture argent, M4) : un oubli de NODE_ENV ne suffit pas à l'activer.
    if (process.env.NODE_ENV === "production" || process.env.WAKATNET_MOCK !== "1") {
      throw new Error("MockProvider interdit : réservé aux tests (WAKATNET_MOCK=1, hors production)");
    }
    if (secret.length < 16) throw new Error("secret du MockProvider : 16 caractères au moins");
  }

  capacites(): Capacites {
    return { operateurs: ["orange_bf", "moov_bf"], flux: ["ussd_otp", "push"], reversement: false, montantMin: 1 };
  }

  private cle(reference: string) { return `${this.secret}:${reference}`; }

  static scenario(numero: string): string { return numero.slice(-2); }

  async charge(d: DemandePaiement): Promise<ResultatPaiement> {
    const existant = PAIEMENTS.get(this.cle(d.reference));
    if (existant) return { referenceFournisseur: existant.refF, statut: existant.statut };   // idempotent
    const sc = MockProvider.scenario(d.numero);
    if (sc === "06") throw new FournisseurIndisponible("mock : fournisseur en panne (scénario 06)");
    if (sc === "01") {
      PAIEMENTS.set(this.cle(d.reference), { demande: d, refF: `MOCK-${randomUUID()}`, statut: "FAILED", montant: d.montant });
      throw new PaiementRefuse("mock : paiement refusé (scénario 01)");
    }
    const e: Enregistrement = { demande: d, refF: `MOCK${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`,
                                statut: sc === "07" ? "PENDING" : "SUCCEEDED", montant: sc === "05" ? d.montant + 5 : d.montant };
    PAIEMENTS.set(this.cle(d.reference), e);
    if (sc === "04") await this.envoyer(d.reference, 1);              // P2 : avant la réponse
    else if (sc === "03") setImmediate(() => void this.envoyer(d.reference, 5));
    else if (sc !== "02" && sc !== "07" && sc !== "08") setImmediate(() => void this.envoyer(d.reference, 1));
    return { referenceFournisseur: e.refF, statut: "PENDING" };
  }

  /** Scénario 07 : le fournisseur confirme plus tard (après l'expiration côté portail). */
  confirmer(reference: string): void {
    const e = PAIEMENTS.get(this.cle(reference));
    if (!e) throw new Error("mock : paiement inconnu");
    e.statut = "SUCCEEDED";
  }

  async verify(reference: string): Promise<EtatPaiement> {
    const e = PAIEMENTS.get(this.cle(reference));
    if (!e) return { reference, statut: "PENDING", montant: 0, devise: "XOF" };
    const sc = MockProvider.scenario(e.demande.numero);
    if (sc === "08") return new Promise<EtatPaiement>(() => {});   // muet, pour toujours
    if (sc === "09") return { reference, referenceFournisseur: e.refF, statut: "SUCCEEDED", montant: e.montant + 0.5, devise: "XOF" };
    return { reference, referenceFournisseur: e.refF, statut: e.statut, montant: e.montant, devise: "XOF" };
  }

  signer(corps: Buffer): string { return createHmac("sha256", this.secret).update(corps).digest("hex"); }

  /** Corps d'un webhook pour cette référence (exposé pour les tests de signature). */
  corps(reference: string, idEvenement = `evt_${randomUUID()}`): Buffer {
    return Buffer.from(JSON.stringify({ id: idEvenement, reference }));
  }

  private async envoyer(reference: string, fois: number): Promise<void> {
    if (!this.livrer) return;
    const corps = this.corps(reference);
    for (let i = 0; i < fois; i++) {
      await this.livrer({ "content-type": "application/json", "x-mock-signature": this.signer(corps) }, corps);
    }
  }

  parseWebhook(enTetes: Record<string, string | string[] | undefined>, corps: Buffer): EvenementWebhook {
    const recue = enTetes["x-mock-signature"];
    const attendue = Buffer.from(this.signer(corps), "hex");
    const fournie = typeof recue === "string" && /^[0-9a-f]{64}$/.test(recue) ? Buffer.from(recue, "hex") : Buffer.alloc(0);
    if (fournie.length !== attendue.length || !timingSafeEqual(fournie, attendue)) throw new SignatureInvalide("signature invalide");
    let x: unknown;
    try { x = JSON.parse(corps.toString("utf8")); } catch { throw new SignatureInvalide("corps illisible"); }
    const o = x as { id?: unknown; reference?: unknown };
    if (typeof o.id !== "string" || typeof o.reference !== "string") throw new SignatureInvalide("événement incomplet");
    return { idEvenement: o.id, reference: o.reference };
  }
}
