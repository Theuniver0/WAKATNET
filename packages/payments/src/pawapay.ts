// WAKATNET — adaptateur pawaPay, API v2, dépôts au Burkina Faso (ADR 0020 ; SPEC §7.3, D2 ; ticket 3.08).
// Sources : https://docs.pawapay.io/v2/ (lues le 12/11/2026 : initiate-deposit, check-deposit-status, deposit-callback,
// signatures, public-keys, providers, test_numbers, failure_codes, what_to_know, deposits).
//
// Règles :
//   - verify() FAIT FOI ; un callback n'est qu'un déclencheur, dont la signature RFC 9421 est vérifiée (fail closed) ;
//   - depositId = UUID v4 dérivé de NOTRE référence (16 octets aléatoires) : charge() et verify() sont idempotents
//     sur la référence, et la référence voyage aussi dans clientReferenceId ;
//   - montants XOF entiers ; pawaPay rend « 100.00 » : normalisé ici, toute décimale non nulle devient un écart ;
//   - jamais de redirection suivie (le jeton la suivrait), corps d'erreur jamais journalisé ni rendu.
import { createHash, createPublicKey, timingSafeEqual, verify as verifierCrypto, type KeyObject } from "node:crypto";
import {
  CompteInvalide, FournisseurIndisponible, PaiementRefuse, SignatureInvalide,
  type Capacites, type DemandePaiement, type EtatPaiement, type EvenementWebhook, type FournisseurPaiement,
  type Operateur, type RequeteWebhook, type ResultatPaiement,
} from "./fournisseur.ts";

export type EnvironnementPawapay = "sandbox" | "production";
export type ClesPawapay = { jeton: string; environnement: EnvironnementPawapay };

export const URL_PAWAPAY: Record<EnvironnementPawapay, string> = {
  sandbox: "https://api.sandbox.pawapay.io",
  production: "https://api.pawapay.io",
};

const PROVIDER: Record<Operateur, string> = { orange_bf: "ORANGE_BFA", moov_bf: "MOOV_BFA" };
const DELAI_MS = 15_000;
/** Callbacks : une signature plus vieille qu'un jour, ou datée de plus de 5 min dans le futur, est refusée. Un rejeu
 *  dans la fenêtre est sans effet : le callback ne fait que déclencher verify(), et les événements sont dédoublonnés. */
const SIGNATURE_AGE_MAX_S = 86_400;
const SIGNATURE_AVANCE_MAX_S = 300;
/** Composants que la signature d'un callback DOIT couvrir : sans eux, un corps ou une cible pourraient être changés. */
const COMPOSANTS_EXIGES = ["@method", "@authority", "@path", "content-digest"];

/** depositId (UUID v4) dérivé de notre référence « wk_ » + 22 caractères base64url (16 octets aléatoires). Les bits de
 *  version et de variante sont imposés : 122 bits aléatoires restent, comme un UUID v4 ordinaire. */
export function depositIdDe(reference: string): string {
  if (!/^wk_[A-Za-z0-9_-]{22}$/.test(reference)) throw new TypeError("référence de paiement invalide");
  const o = Buffer.from(reference.slice(3), "base64url");
  if (o.length !== 16) throw new TypeError("référence de paiement invalide");
  o[6] = (o[6] & 0x0f) | 0x40;
  o[8] = (o[8] & 0x3f) | 0x80;
  const h = o.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Montant rendu par pawaPay → XOF entier. « 100 » et « 100.00 » valent 100 ; « 100.50 » ou une forme inattendue
 *  donnent -1, que le service traite comme un écart (MISMATCH), jamais comme un succès. */
export function montantPawapay(v: unknown): number {
  if (typeof v !== "string") return -1;
  const m = /^(0|[1-9][0-9]{0,14})(?:\.0+)?$/.exec(v);
  return m ? Number(m[1]) : -1;
}

// ------------------------------------------------------------------ signatures RFC 9421 (callbacks)

export type ClePublique = { id: string; key: string };

type Entete = string | string[] | undefined;
const entete = (h: Record<string, Entete>, nom: string): string | undefined => {
  const v = h[nom.toLowerCase()];
  return Array.isArray(v) ? v.join(", ") : v;
};

/** Vérifie la signature d'un callback (RFC 9421) et le Content-Digest du corps. Lève SignatureInvalide. */
export function verifierSignature(enTetes: Record<string, Entete>, corps: Buffer, requete: RequeteWebhook,
                                  cles: ClePublique[], maintenantS: number): void {
  // 1. Content-Digest : chaque condensat connu présent est recalculé ; au moins un.
  const digest = entete(enTetes, "content-digest");
  if (!digest) throw new SignatureInvalide("Content-Digest absent");
  let verifies = 0;
  for (const membre of digest.split(",")) {
    const m = /^\s*(sha-256|sha-512)=:([A-Za-z0-9+/]+={0,2}):\s*$/.exec(membre);
    if (!m) continue;
    const attendu = createHash(m[1] === "sha-256" ? "sha256" : "sha512").update(corps).digest();
    const recu = Buffer.from(m[2], "base64");
    if (recu.length !== attendu.length || !timingSafeEqual(recu, attendu)) throw new SignatureInvalide("Content-Digest faux");
    verifies++;
  }
  if (verifies === 0) throw new SignatureInvalide("Content-Digest sans algorithme reconnu");

  // 2. Signature-Input et Signature : une seule étiquette, la même dans les deux.
  const input = entete(enTetes, "signature-input"), sig = entete(enTetes, "signature");
  if (!input || !sig) throw new SignatureInvalide("callback non signé (activer « signed callbacks » chez pawaPay)");
  const mi = /^\s*([a-z][a-z0-9_.*-]*)=(\((?:"[^"\\]*"(?:\s+"[^"\\]*")*)?\)(?:;[a-z][a-z0-9_.*-]*=(?:"[^"\\]*"|-?[0-9]+))*)\s*$/.exec(input);
  if (!mi) throw new SignatureInvalide("Signature-Input illisible (une seule signature attendue)");
  const [, etiquette, parametresSignature] = mi;
  const ms = new RegExp(`^\\s*${etiquette.replace(/[.*]/g, "\\$&")}=:([A-Za-z0-9+/]+={0,2}):\\s*$`).exec(sig);
  if (!ms) throw new SignatureInvalide("Signature illisible ou d'une autre étiquette");
  const composants = [...parametresSignature.slice(0, parametresSignature.indexOf(")") + 1).matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  const params = new Map([...parametresSignature.slice(parametresSignature.indexOf(")") + 1).matchAll(/;([a-z][a-z0-9_.*-]*)=("([^"]*)"|-?[0-9]+)/g)]
    .map((x) => [x[1], x[3] ?? x[2]] as const));
  for (const c of COMPOSANTS_EXIGES) if (!composants.includes(c)) throw new SignatureInvalide(`composant non signé : ${c}`);
  if (params.get("alg") !== "ecdsa-p256-sha256") throw new SignatureInvalide("algorithme de signature non accepté");
  const cree = Number(params.get("created"));
  if (!Number.isSafeInteger(cree) || cree < maintenantS - SIGNATURE_AGE_MAX_S || cree > maintenantS + SIGNATURE_AVANCE_MAX_S) {
    throw new SignatureInvalide("signature hors de sa fenêtre de validité");
  }

  // 3. Base de signature (RFC 9421 §2.5) : composants dérivés de la requête reçue, en-têtes tels que reçus.
  const lignes: string[] = [];
  for (const c of composants) {
    let valeur: string | undefined;
    if (c === "@method") valeur = requete.methode.toUpperCase();
    else if (c === "@authority") valeur = requete.autorite.toLowerCase();
    else if (c === "@path") valeur = requete.chemin;
    else if (c.startsWith("@")) throw new SignatureInvalide(`composant dérivé non pris en charge : ${c}`);
    else valeur = entete(enTetes, c)?.trim();
    if (valeur === undefined) throw new SignatureInvalide(`en-tête signé absent : ${c}`);
    lignes.push(`"${c}": ${valeur}`);
  }
  lignes.push(`"@signature-params": ${parametresSignature}`);
  const base = Buffer.from(lignes.join("\n"), "utf8");

  // 4. ECDSA P-256 / SHA-256. pawaPay rend la signature en DER (exemple de la doc) ; la RFC prévoit r||s (64 octets) :
  // les deux sont acceptés. Clé désignée par keyid si elle est connue, sinon toute clé publique de pawaPay.
  const valeurSig = Buffer.from(ms[1], "base64");
  const keyid = params.get("keyid");
  const candidates = cles.some((k) => k.id === keyid) ? cles.filter((k) => k.id === keyid) : cles;
  for (const k of candidates) {
    let cle: KeyObject;
    try { cle = createPublicKey(k.key); } catch { continue; }
    if (cle.asymmetricKeyType !== "ec" || cle.asymmetricKeyDetails?.namedCurve !== "prime256v1") continue;
    const dsaEncoding = valeurSig.length === 64 ? "ieee-p1363" : "der";
    if (verifierCrypto("sha256", base, { key: cle, dsaEncoding }, valeurSig)) return;
  }
  throw new SignatureInvalide("signature invalide");
}

// ------------------------------------------------------------------ adaptateur

/** Clés publiques de pawaPay, en cache une heure par environnement et par jeton. Rotation : relecture seulement si le
 *  keyid du callback est inconnu, au plus une fois toutes les 5 min, une seule requête à la fois (relecture : sinon de
 *  faux callbacks feraient appeler pawaPay à volonté avec le jeton du propriétaire). */
const CACHE_CLES = new Map<string, { cles: ClePublique[]; jusqua: number; relu: number; enCours?: Promise<ClePublique[]> }>();
const RELECTURE_MIN_MS = 300_000;

export class PawapayProvider implements FournisseurPaiement {
  readonly id = "pawapay";
  private readonly jeton: string;
  private readonly urlBase: string;
  private readonly maintenant: () => number;

  constructor(cles: ClesPawapay, options: { urlBase?: string; maintenant?: () => number } = {}) {
    this.jeton = cles.jeton;
    this.urlBase = (options.urlBase ?? URL_PAWAPAY[cles.environnement]).replace(/\/+$/, "");
    this.maintenant = options.maintenant ?? Date.now;
  }

  capacites(): Capacites {
    // Minimum du Burkina non publié dans la doc : à lire dans GET /v2/active-conf avec le compte (ADR 0020).
    return { operateurs: ["orange_bf", "moov_bf"], flux: ["ussd_otp", "push"], reversement: false, montantMin: 100 };
  }

  private async appel(methode: "GET" | "POST", chemin: string, corps?: unknown): Promise<{ statut: number; json: unknown }> {
    let rep: Response;
    try {
      rep = await fetch(`${this.urlBase}${chemin}`, {
        method: methode,
        headers: { authorization: `Bearer ${this.jeton}`, accept: "application/json", ...(corps ? { "content-type": "application/json" } : {}) },
        ...(corps ? { body: JSON.stringify(corps) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(DELAI_MS),
      });
    } catch {
      throw new FournisseurIndisponible("pawaPay injoignable");
    }
    let json: unknown = null;
    try { json = await rep.json(); } catch { /* corps vide ou illisible */ }
    return { statut: rep.status, json };
  }

  async charge(d: DemandePaiement): Promise<ResultatPaiement> {
    if (d.devise !== "XOF" || !Number.isSafeInteger(d.montant) || d.montant <= 0) throw new PaiementRefuse("montant invalide");
    if (!/^[0-9]{8}$/.test(d.numero)) throw new PaiementRefuse("numéro invalide");
    const provider = PROVIDER[d.operateur];
    if (!provider) throw new PaiementRefuse("opérateur non pris en charge");
    if (d.operateur === "orange_bf" && !(d.otp && /^[A-Za-z0-9]{1,36}$/.test(d.otp))) throw new PaiementRefuse("code Orange Money manquant");
    const depositId = depositIdDe(d.reference);
    const { statut, json } = await this.appel("POST", "/v2/deposits", {
      depositId,
      payer: { type: "MMO", accountDetails: { phoneNumber: `226${d.numero}`, provider } },
      amount: String(d.montant),
      currency: "XOF",
      clientReferenceId: d.reference,
      customerMessage: "WAKATNET",
      ...(d.operateur === "orange_bf" ? { preAuthorisationCode: d.otp } : {}),
    });
    const r = (json ?? {}) as { status?: string; failureReason?: { failureCode?: string } };
    if (statut === 200 && (r.status === "ACCEPTED" || r.status === "DUPLICATE_IGNORED")) return { referenceFournisseur: depositId, statut: "PENDING" };
    const code = r.failureReason?.failureCode ?? "INCONNU";
    if (statut === 200 && r.status === "REJECTED") {
      // UNKNOWN_ERROR : issue inconnue, verify() tranchera (doc failure_codes ; relecture : jamais un refus, sinon le
      // client repaierait).
      if (code === "PROVIDER_TEMPORARILY_UNAVAILABLE" || code === "UNKNOWN_ERROR") throw new FournisseurIndisponible(`pawaPay : ${code}`);
      throw new PaiementRefuse(`pawaPay : ${code}`);
    }
    // 400 : demande refusée telle quelle (aucun dépôt créé). 401, 403 : compte ou jeton à revoir. 5xx : issue inconnue,
    // le dépôt existe peut-être ; verify() tranchera (P8).
    if (statut === 400) throw new PaiementRefuse(`pawaPay : ${code}`);
    throw new FournisseurIndisponible(`pawaPay : HTTP ${statut} ${code}`);
  }

  async verify(reference: string): Promise<EtatPaiement> {
    const depositId = depositIdDe(reference);
    const { statut, json } = await this.appel("GET", `/v2/deposits/${depositId}`);
    if (statut !== 200) throw new FournisseurIndisponible(`pawaPay : HTTP ${statut}`);
    const r = (json ?? {}) as { status?: string; data?: Record<string, unknown> };
    // NOT_FOUND : pawaPay n'a jamais reçu ce dépôt ; c'est un échec sûr (doc « deposits », réconciliation).
    if (r.status === "NOT_FOUND") return { reference, statut: "FAILED", montant: 0, devise: "XOF" };
    const data = r.data;
    if (r.status !== "FOUND" || !data || data.depositId !== depositId) throw new FournisseurIndisponible("pawaPay : réponse inattendue");
    if (data.clientReferenceId !== undefined && data.clientReferenceId !== reference) throw new FournisseurIndisponible("pawaPay : référence inattendue");
    const etat = data.status === "COMPLETED" ? "SUCCEEDED" : data.status === "FAILED" ? "FAILED" : "PENDING";
    return { reference, referenceFournisseur: depositId, statut: etat, montant: montantPawapay(data.amount),
             devise: typeof data.currency === "string" ? data.currency : "?" };
  }

  private async clesPubliques(keyidInconnu?: string): Promise<ClePublique[]> {
    const k = `${this.urlBase}|${createHash("sha256").update(this.jeton).digest("hex")}`;
    const c = CACHE_CLES.get(k);
    const t = this.maintenant();
    const aRelire = !c || c.jusqua <= t
      || (keyidInconnu !== undefined && !c.cles.some((x) => x.id === keyidInconnu) && t - c.relu >= RELECTURE_MIN_MS);
    if (!aRelire) return c!.cles;
    if (c?.enCours) return c.enCours;
    const lecture = (async () => {
      const { statut, json } = await this.appel("GET", "/v2/public-key/http");
      if (statut !== 200 || !Array.isArray(json)) throw new SignatureInvalide("clés publiques de pawaPay indisponibles");
      return json.filter((x): x is ClePublique => typeof x?.id === "string" && typeof x?.key === "string");
    })();
    CACHE_CLES.set(k, { cles: c?.cles ?? [], jusqua: c?.jusqua ?? 0, relu: t, enCours: lecture });
    try {
      const cles = await lecture;
      CACHE_CLES.set(k, { cles, jusqua: t + 3_600_000, relu: t });
      return cles;
    } catch (e) {
      CACHE_CLES.set(k, { cles: c?.cles ?? [], jusqua: c?.jusqua ?? 0, relu: t });
      throw e;
    }
  }

  /** À l'enregistrement (relecture) : jeton valable pour cet environnement, callbacks signés activés, dépôts Orange et
   *  Moov du Burkina ouverts sur le compte (GET /v2/active-conf). */
  async verifierCompte(): Promise<void> {
    const { statut, json } = await this.appel("GET", "/v2/active-conf?country=BFA&operationType=DEPOSIT");
    if (statut === 401 || statut === 403) throw new CompteInvalide("jeton pawaPay refusé pour cet environnement (bac à sable ou production ?)");
    if (statut !== 200) throw new FournisseurIndisponible(`pawaPay : HTTP ${statut}`);
    const c = (json ?? {}) as { signatureConfiguration?: { signedCallbacks?: boolean };
                                countries?: { country?: string; providers?: { provider?: string }[] }[] };
    if (c.signatureConfiguration?.signedCallbacks !== true) {
      throw new CompteInvalide("activez les callbacks signés (« signed callbacks ») dans le tableau de bord pawaPay, puis recommencez");
    }
    const bf = c.countries?.find((x) => x.country === "BFA");
    const providers = new Set((bf?.providers ?? []).map((p) => p.provider));
    if (!providers.has("ORANGE_BFA") && !providers.has("MOOV_BFA")) {
      throw new CompteInvalide("ce compte pawaPay n'a aucun opérateur du Burkina Faso ouvert aux dépôts");
    }
  }

  async parseWebhook(enTetes: Record<string, Entete>, corps: Buffer, requete?: RequeteWebhook): Promise<EvenementWebhook> {
    if (!requete) throw new SignatureInvalide("requête du callback inconnue");
    const maintenantS = Math.floor(this.maintenant() / 1000);
    const keyid = /;keyid="([^"]*)"/.exec(entete(enTetes, "signature-input") ?? "")?.[1];
    verifierSignature(enTetes, corps, requete, await this.clesPubliques(keyid), maintenantS);
    let d: Record<string, unknown>;
    try { d = JSON.parse(corps.toString("utf8")) as Record<string, unknown>; } catch { throw new SignatureInvalide("corps illisible"); }
    const ref = d.clientReferenceId;
    if (typeof d.depositId !== "string" || !/^[0-9a-f-]{36}$/.test(d.depositId) || typeof d.status !== "string") throw new SignatureInvalide("callback incomplet");
    const idEvenement = `${d.depositId}:${d.status}`.slice(0, 200);
    // Sans clientReferenceId (la doc du callback n'en garantit pas la présence), le service retrouve le paiement par
    // depositId. Avec, la référence doit correspondre au depositId.
    if (ref === undefined) return { idEvenement, reference: "", referenceFournisseur: d.depositId };
    let attendu: string;
    try { attendu = typeof ref === "string" ? depositIdDe(ref) : ""; } catch { throw new SignatureInvalide("référence inconnue"); }
    if (attendu !== d.depositId) throw new SignatureInvalide("depositId et référence incohérents");
    return { idEvenement, reference: ref as string, referenceFournisseur: d.depositId };
  }
}
