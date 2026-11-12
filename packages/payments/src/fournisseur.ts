// WAKATNET — interface des fournisseurs de paiement (SPEC §7.3, ADR 0013 §1).
// Ticket : .scratch/phase-3-portail-paiement/issues/03-paiements-mock.md
//
// verify() FAIT FOI pour tous les adaptateurs ; un webhook n'est qu'un déclencheur, dont la
// signature est vérifiée (PAYMENT_PROVIDERS.md §6). Montants : entiers XOF (A1, A8).

export type Operateur = "orange_bf" | "moov_bf";
export type Flux = "ussd_otp" | "push" | "redirect";
export type StatutFournisseur = "PENDING" | "SUCCEEDED" | "FAILED";

export interface Capacites {
  operateurs: Operateur[];
  flux: Flux[];
  reversement: boolean;
  /** XOF, entier ; lu dynamiquement quand l'API du fournisseur l'expose. */
  montantMin: number;
}

export interface DemandePaiement {
  /** Notre référence : charge() est idempotent sur elle. */
  reference: string;
  montant: number;
  devise: "XOF";
  operateur: Operateur;
  /** Numéro du payeur, 8 chiffres (Burkina Faso). */
  numero: string;
  /** Code reçu par le payeur (flux ussd_otp). */
  otp?: string;
}

export interface ResultatPaiement {
  referenceFournisseur: string;
  statut: StatutFournisseur;
}

export interface EtatPaiement {
  reference: string;
  referenceFournisseur?: string;
  statut: StatutFournisseur;
  montant: number;
  devise: string;
}

export interface EvenementWebhook {
  /** Identifiant unique de l'événement chez le fournisseur (P1 : doublons). */
  idEvenement: string;
  /** Notre référence de paiement. */
  reference: string;
}

export interface FournisseurPaiement {
  readonly id: string;
  capacites(): Capacites;
  charge(demande: DemandePaiement): Promise<ResultatPaiement>;
  verify(reference: string): Promise<EtatPaiement>;
  /** Vérifie la signature et lève SignatureInvalide sinon. */
  parseWebhook(enTetes: Record<string, string | string[] | undefined>, corpsBrut: Buffer): EvenementWebhook;
}

export class SignatureInvalide extends Error {}
/** Le fournisseur ne répond pas, ou répond une erreur de son côté (P8). */
export class FournisseurIndisponible extends Error {}
/** Demande refusée par le fournisseur (numéro, OTP, solde du payeur…). */
export class PaiementRefuse extends Error {}

/** A8 : montant du fournisseur → XOF entier. Refuse décimales, négatifs et formes ambiguës. */
export function versXof(v: unknown): number {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^(0|[1-9][0-9]{0,14})$/.test(v)) return Number(v);
  throw new TypeError(`montant XOF invalide : ${JSON.stringify(v)}`);
}

/** Numéro burkinabè : 8 chiffres, avec ou sans indicatif 226 ou +226, espaces tolérés. */
export function normaliserNumero(v: string): string | null {
  const n = v.replace(/[\s.-]/g, "").replace(/^(\+|00)?226/, "");
  return /^[0-9]{8}$/.test(n) ? n : null;
}

/** Forme masquée (ADR 0005 §2) : « 70 •• •• 12 ». */
export function masquerNumero(n: string): string {
  return `${n.slice(0, 2)} •• •• ${n.slice(6)}`;
}
