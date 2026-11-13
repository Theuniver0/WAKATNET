// WAKATNET — adaptateur CinetPay, API v1 « paiement direct » (sans redirection), Burkina Faso (ADR 0022).
// Source : SDK officiel cinetpay-js 0.1.1 (npm, auteur « CinetPay », lu le 13/11/2026) : la v1 n'est décrite sur aucune
// page de docs.cinetpay.com (docs/PAYMENT_PROVIDERS.md §2.2). Chaque forme ci-dessous vient du code du SDK ; ce qui
// n'y figure pas est marqué [À CONFIRMER] et se tranche au bac à sable.
//
// Règles :
//   - verify() FAIT FOI. Le webhook v1 ne porte aucune signature, seulement un notify_token par transaction : il n'est
//     qu'un déclencheur. Le service ne lance verify() que pour un paiement réel de ce propriétaire (pas d'appel sortant
//     pour une référence inventée) ;
//   - merchant_transaction_id = NOTRE référence (25 caractères, le SDK en admet 30) : charge() et verify() sont
//     idempotents sur elle ; un second envoi rend TRANSACTION_EXIST, traité comme « en attente » ;
//   - A8 : le statut v1, tel que le SDK le lit, ne contient ni montant ni devise. Ils sont lus s'ils sont présents ;
//     sinon montant -1, et le service fait du paiement un ÉCART (MISMATCH) : aucun ticket sans montant confirmé ;
//   - jamais de redirection suivie (le jeton la suivrait), corps d'erreur jamais journalisé ni rendu.
import { createHash } from "node:crypto";
import {
  CompteInvalide, FournisseurIndisponible, PaiementRefuse, SignatureInvalide,
  type Capacites, type DemandePaiement, type EtatPaiement, type EvenementWebhook, type FournisseurPaiement,
  type Operateur, type ResultatPaiement,
} from "./fournisseur.ts";

export type EnvironnementCinetpay = "sandbox" | "production";
export type ClesCinetpay = { cleApi: string; motDePasseApi: string; environnement: EnvironnementCinetpay };

/** Bases du SDK officiel (DEFAULT_BASE_URL, PRODUCTION_BASE_URL). */
export const URL_CINETPAY: Record<EnvironnementCinetpay, string> = {
  sandbox: "https://api.cinetpay.net",
  production: "https://api.cinetpay.co",
};

/** Préfixes des clés (SDK : API_KEY_PREFIX_TEST, API_KEY_PREFIX_LIVE) : une clé de test n'est jamais envoyée en
 *  production, ni l'inverse. */
export const PREFIXE_CLE: Record<EnvironnementCinetpay, string> = { sandbox: "sk_test_", production: "sk_live_" };

/** Orange : code OTP saisi par le client (`*144*4*6*montant#`) ; Moov : notification poussée, code secret sur le
 *  téléphone. Méthodes du SDK : OM_BF, MOOV_BF. Canal de Moov BF : déduction (PAYMENT_PROVIDERS §2.2) [À CONFIRMER]. */
const METHODE: Record<Operateur, { methode: string; canal: "OTP" | "PUSH" }> = {
  orange_bf: { methode: "OM_BF", canal: "OTP" },
  moov_bf: { methode: "MOOV_BF", canal: "PUSH" },
};
/** Budgets TOTAUX d'une opération (connexion comprise), sous les délais du service (DELAI_CHARGE_MS 15 s,
 *  DELAI_VERIFY_MS 10 s) : à leur échéance, chaque requête est ANNULÉE, pas seulement abandonnée (relecture n° 3 : sinon
 *  un paiement parti après la réponse « réessayez » du portail ferait payer deux fois). */
const BUDGET_CHARGE_MS = 12_000;
const BUDGET_VERIFY_MS = 9_000;
/** Temps minimal restant pour ENVOYER le paiement ; en deçà, il n'est pas envoyé (aucun argent ne bouge). */
const MARGE_ENVOI_MS = 6_000;
const DELAI_COMPTE_MS = 15_000;
/** Verrou de G-ARGENT propre à CinetPay (relecture n° 1) : le statut v1 lu par le SDK ne contient pas le montant (A8).
 *  Tant que le bac à sable n'a pas montré `amount` et `currency` au statut, l'environnement de production est refusé :
 *  sinon chaque client payé finirait en écart, sans ticket. À passer à true par un ADR, preuve du bac à sable à l'appui. */
export const MONTANT_AU_STATUT_CONFIRME = false;
/** Durée de vie d'un jeton d'accès dans le SDK (DEFAULT_TOKEN_TTL : 23 h). */
const JETON_TTL_MS = 82_800_000;
/** Codes de réponse que le SDK traite comme un succès d'appel (handleResponse). */
const CODES_OK = new Set([200, 100, 2001, 2002]);
/** Refus du payeur ou de l'opérateur (SDK : API_CODES) : rien n'est encaissé. */
const REFUS = new Set(["OTP_ERROR", "OTP_EXPIRED", "INSUFFICIENT_BALANCE", "USER_NOT_FOUND", "USER_IS_BLOCKED", "FAILED", "EXPIRED"]);
/** Jeton périmé ou invalide : une nouvelle connexion, une seule fois (SDK : isTokenExpired, code 1003). */
const JETON_A_RENOUVELER = new Set([1002, 1003]);

/** Montant rendu par CinetPay → XOF entier : nombre entier, « 100 » ou « 100.00 ». Toute autre forme, ou un montant
 *  absent, donne -1, que le service traite comme un écart (MISMATCH), jamais comme un succès. */
export function montantCinetpay(v: unknown): number {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : -1;
  if (typeof v !== "string") return -1;
  const m = /^(0|[1-9][0-9]{0,14})(?:\.0+)?$/.exec(v);
  return m ? Number(m[1]) : -1;
}

type Reponse = { http: number; json: Record<string, unknown> };
const code = (r: Reponse): number | undefined => (typeof r.json.code === "number" ? r.json.code : undefined);
const statut = (r: Reponse): string => (typeof r.json.status === "string" ? r.json.status : "");

/** Jetons d'accès, en cache par environnement et par clé (empreinte, jamais la clé). Une seule connexion à la fois. */
const CACHE_JETONS = new Map<string, { jeton: string; jusqua: number } | { enCours: Promise<string> }>();

export class CinetpayProvider implements FournisseurPaiement {
  readonly id = "cinetpay";
  private readonly cles: ClesCinetpay;
  private readonly urlBase: string;
  private readonly urlWebhook: string | undefined;
  private readonly urlRetour: string | undefined;
  private readonly maintenant: () => number;

  /** `urlWebhook` : notify_url du compte marchand (exigée par charge()). `urlRetour` : success_url et failed_url, que
   *  le paiement direct n'utilise pas, mais que le SDK exige (1 à 120 caractères, http ou https). */
  constructor(cles: ClesCinetpay, options: { urlBase?: string; urlWebhook?: string; urlRetour?: string; maintenant?: () => number } = {}) {
    this.cles = cles;
    this.urlBase = (options.urlBase ?? URL_CINETPAY[cles.environnement]).replace(/\/+$/, "");
    this.urlWebhook = options.urlWebhook;
    this.urlRetour = options.urlRetour;
    this.maintenant = options.maintenant ?? Date.now;
  }

  capacites(): Capacites {
    // SDK : montant de 100 à 2 500 000 ; multiple de 5 exigé pour le Burkina (extraits, PAYMENT_PROVIDERS §2.2).
    return { operateurs: ["orange_bf", "moov_bf"], flux: ["ussd_otp", "push"], reversement: false, montantMin: 100 };
  }

  private async appel(methode: "GET" | "POST", chemin: string, echeance: number, corps?: unknown, jeton?: string): Promise<Reponse> {
    const reste = echeance - Date.now();
    if (reste <= 0) throw new FournisseurIndisponible("CinetPay : délai épuisé");
    let rep: Response;
    try {
      rep = await fetch(`${this.urlBase}${chemin}`, {
        method: methode,
        headers: { accept: "application/json", "content-type": "application/json", ...(jeton ? { authorization: `Bearer ${jeton}` } : {}) },
        ...(corps ? { body: JSON.stringify(corps) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(reste),
      });
    } catch {
      throw new FournisseurIndisponible("CinetPay injoignable");
    }
    let json: unknown = null;
    try { json = await rep.json(); } catch { /* corps vide ou illisible */ }
    return { http: rep.status, json: json !== null && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : {} };
  }

  /** Empreinte de la clé ET du mot de passe (relecture n° 7) : un mauvais mot de passe ne réutilise jamais le jeton
   *  d'un bon. */
  private cleCache(): string {
    return `${this.urlBase}|${createHash("sha256").update(`${this.cles.cleApi}\u0000${this.cles.motDePasseApi}`).digest("hex")}`;
  }

  /** POST /v1/oauth/login {api_key, api_password} → access_token (SDK : Authenticator.authenticate). */
  private async connexion(echeance: number): Promise<string> {
    const r = await this.appel("POST", "/v1/oauth/login", echeance, { api_key: this.cles.cleApi, api_password: this.cles.motDePasseApi });
    const j = r.json.access_token;
    if (r.http >= 500) throw new FournisseurIndisponible(`CinetPay : HTTP ${r.http}`);
    if (typeof j !== "string" || j.length < 1 || j.length > 8192) throw new CompteInvalide("clé ou mot de passe d'API CinetPay refusés");
    return j;
  }

  /** Jeton en cache ; une seule connexion à la fois. `perime` : jeton refusé (1002, 1003) ; une nouvelle connexion n'a
   *  lieu que s'il est encore celui du cache (relecture n° 6 : sinon deux appels se relancent l'un l'autre). */
  private async jeton(echeance: number, perime?: string): Promise<string> {
    const k = this.cleCache();
    const c = CACHE_JETONS.get(k);
    if (c && "enCours" in c) return c.enCours;
    if (c && "jeton" in c && c.jusqua > this.maintenant() && c.jeton !== perime) return c.jeton;
    const lecture = this.connexion(echeance);
    CACHE_JETONS.set(k, { enCours: lecture });
    try {
      const j = await lecture;
      CACHE_JETONS.set(k, { jeton: j, jusqua: this.maintenant() + JETON_TTL_MS });
      return j;
    } catch (e) {
      CACHE_JETONS.delete(k);
      throw e;
    }
  }

  /** Appel authentifié ; jeton refusé (1002, 1003) : une nouvelle connexion, un seul nouvel essai (le premier envoi a été
   *  refusé pour le jeton : rien n'a été créé). `avantEnvoi` : contrôle refait juste avant chaque envoi. */
  private async appelAuthentifie(methode: "GET" | "POST", chemin: string, echeance: number, corps?: unknown,
                                 avantEnvoi: () => void = () => {}): Promise<Reponse> {
    const jetonSur = async (perime?: string) => {
      try { return await this.jeton(echeance, perime); } catch (e) {
        // Hors de verifierCompte(), des identifiants refusés sont une panne du compte, pas un refus du payeur.
        if (e instanceof CompteInvalide) throw new FournisseurIndisponible("CinetPay : identifiants d'API refusés");
        throw e;
      }
    };
    let jeton = await jetonSur();
    avantEnvoi();
    const r = await this.appel(methode, chemin, echeance, corps, jeton);
    const c = code(r);
    if (c === undefined || !JETON_A_RENOUVELER.has(c)) return r;
    jeton = await jetonSur(jeton);
    avantEnvoi();
    return this.appel(methode, chemin, echeance, corps, jeton);
  }

  async charge(d: DemandePaiement): Promise<ResultatPaiement> {
    if (d.devise !== "XOF" || !Number.isSafeInteger(d.montant) || d.montant < 100 || d.montant > 2_500_000) {
      throw new PaiementRefuse("montant invalide (100 à 2 500 000 XOF)");
    }
    if (d.montant % 5 !== 0) throw new PaiementRefuse("montant invalide (multiple de 5 exigé par CinetPay)");
    if (!/^wk_[A-Za-z0-9_-]{22}$/.test(d.reference)) throw new PaiementRefuse("référence invalide");
    if (!/^[0-9]{8}$/.test(d.numero)) throw new PaiementRefuse("numéro invalide");
    const m = METHODE[d.operateur];
    if (!m) throw new PaiementRefuse("opérateur non pris en charge");
    // SDK : otp_code de 4 à 6 chiffres.
    if (m.canal === "OTP" && !(d.otp && /^[0-9]{4,6}$/.test(d.otp))) throw new PaiementRefuse("code Orange Money manquant (4 à 6 chiffres)");
    if (!this.urlWebhook || !this.urlRetour) throw new FournisseurIndisponible("CinetPay : URL de notification non configurée");
    const echeance = Date.now() + BUDGET_CHARGE_MS;
    const assezDeTemps = () => {
      if (echeance - Date.now() < MARGE_ENVOI_MS) throw new FournisseurIndisponible("CinetPay : connexion trop lente, paiement non envoyé");
    };
    const r = await this.appelAuthentifie("POST", "/v1/payment", echeance, {
      currency: "XOF",
      merchant_transaction_id: d.reference,
      amount: d.montant,
      lang: "fr",
      designation: "WAKATNET",
      // Exigés par le SDK même en paiement direct ; aucune donnée du client n'est envoyée [À CONFIRMER : facultatifs ?].
      client_email: "client@wakatnet.invalid",
      client_first_name: "Client",
      client_last_name: "WAKATNET",
      success_url: this.urlRetour,
      failed_url: this.urlRetour,
      notify_url: this.urlWebhook,
      channel: m.canal,
      payment_method: m.methode,
      client_phone_number: `+226${d.numero}`,
      direct_pay: true,
      ...(m.canal === "OTP" ? { otp_code: d.otp } : {}),
    }, assezDeTemps);
    const c = code(r), s = statut(r);
    const details = (r.json.details ?? {}) as { must_be_redirected?: unknown; status?: unknown };
    const idCinetpay = typeof r.json.transaction_id === "string" && r.json.transaction_id.length >= 1 && r.json.transaction_id.length <= 128
      ? r.json.transaction_id : d.reference;
    // Déjà reçue (rejeu de charge()) : la transaction existe, verify() tranchera.
    // Identifiant CinetPay inconnu ici : chaîne vide, que le service n'écrit pas (relecture n° 9 : sinon l'identifiant
    // noté au premier envoi serait écrasé).
    if (c === 1200 || s === "TRANSACTION_EXIST") return { referenceFournisseur: "", statut: "PENDING" };
    if (r.http < 400 && c !== undefined && CODES_OK.has(c)) {
      // Paiement direct qui exige malgré tout une redirection : impossible depuis le portail. La transaction existe,
      // mais le client ne peut pas la conclure ; verify() continue (un succès tardif délivrera le ticket).
      if (details.must_be_redirected === true) throw new PaiementRefuse("CinetPay exige une redirection : paiement direct indisponible pour ce compte");
      return { referenceFournisseur: idCinetpay, statut: "PENDING" };
    }
    const detail = typeof details.status === "string" ? details.status : s;
    if (REFUS.has(s) || REFUS.has(detail)) throw new PaiementRefuse(`CinetPay : ${detail || s}`);
    // 1004 INVALID_PARAMS : demande refusée telle quelle (aucune transaction créée).
    if (c === 1004 || s === "INVALID_PARAMS") throw new PaiementRefuse("CinetPay : paramètres refusés");
    // 1005, 2011 (IP non autorisée), -1, 5xx, forme inattendue : issue inconnue ou compte à revoir ; verify() tranchera.
    throw new FournisseurIndisponible(`CinetPay : HTTP ${r.http} ${c ?? "?"} ${s || "?"}`);
  }

  async verify(reference: string): Promise<EtatPaiement> {
    if (!/^wk_[A-Za-z0-9_-]{22}$/.test(reference)) throw new TypeError("référence de paiement invalide");
    // SDK : GET /v1/payment/{identifiant}, identifiant = payment_token, transaction_id ou merchant_transaction_id.
    const r = await this.appelAuthentifie("GET", `/v1/payment/${encodeURIComponent(reference)}`, Date.now() + BUDGET_VERIFY_MS);
    const c = code(r), s = statut(r);
    // Jamais reçue par CinetPay (réponse JSON 404 NOT_FOUND) : échec sûr ; un succès tardif reste repris (FAILED est
    // re-vérifié). Un 404 sans ce corps (répartiteur, pare-feu, route déplacée) est une PANNE (relecture n° 4).
    if (c === 404 && s === "NOT_FOUND") {
      return { reference, statut: "FAILED", montant: 0, devise: "XOF" };
    }
    if (r.http >= 400) throw new FournisseurIndisponible(`CinetPay : HTTP ${r.http}`);
    const ref = r.json.merchant_transaction_id;
    if (ref !== undefined && ref !== null && ref !== reference) throw new FournisseurIndisponible("CinetPay : référence inattendue");
    const idCinetpay = typeof r.json.transaction_id === "string" && r.json.transaction_id.length <= 128 ? r.json.transaction_id : undefined;
    let etat: EtatPaiement["statut"];
    if (s === "SUCCESS") etat = "SUCCEEDED";
    else if (REFUS.has(s)) etat = "FAILED";
    else if (s === "INITIATED" || s === "PENDING" || s === "TRANSACTION_EXIST") etat = "PENDING";
    // Statut inconnu : jamais lu comme un échec (le client a peut-être payé) ; réessayé au tour suivant.
    else throw new FournisseurIndisponible(`CinetPay : statut inattendu ${s.slice(0, 40) || "?"}`);
    return {
      reference, ...(idCinetpay ? { referenceFournisseur: idCinetpay } : {}), statut: etat,
      // A8 : montant et devise lus s'ils sont présents ; absents → -1 et « ? » : écart, jamais un ticket non payé.
      montant: montantCinetpay(r.json.amount),
      devise: typeof r.json.currency === "string" ? r.json.currency : "?",
    };
  }

  /** À l'enregistrement : la clé correspond à l'environnement choisi, et CinetPay accepte la connexion. */
  async verifierCompte(): Promise<void> {
    if (!this.cles.cleApi.startsWith(PREFIXE_CLE[this.cles.environnement])) {
      throw new CompteInvalide(`clé d'API CinetPay attendue en ${PREFIXE_CLE[this.cles.environnement]}… pour cet environnement`);
    }
    // Connexion propre, jamais celle d'un autre appel en cours (relecture n° 7).
    const j = await this.connexion(Date.now() + DELAI_COMPTE_MS);
    CACHE_JETONS.set(this.cleCache(), { jeton: j, jusqua: this.maintenant() + JETON_TTL_MS });
  }

  /** Corps JSON du webhook v1 (SDK : parseNotification) : notify_token, transaction_id, merchant_transaction_id. Aucune
   *  signature : le webhook ne fait que déclencher verify(), qui fait foi. */
  parseWebhook(_enTetes: Record<string, string | string[] | undefined>, corps: Buffer): EvenementWebhook {
    let d: Record<string, unknown>;
    try { d = JSON.parse(corps.toString("utf8")) as Record<string, unknown>; } catch { throw new SignatureInvalide("corps illisible"); }
    if (d === null || typeof d !== "object" || Array.isArray(d)) throw new SignatureInvalide("corps illisible");
    const { notify_token: jeton, transaction_id: id, merchant_transaction_id: ref } = d;
    if (typeof jeton !== "string" || jeton.length < 1 || jeton.length > 512) throw new SignatureInvalide("notify_token absent");
    if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw new SignatureInvalide("transaction_id absent ou invalide");
    if (ref !== undefined && (typeof ref !== "string" || !/^wk_[A-Za-z0-9_-]{22}$/.test(ref))) throw new SignatureInvalide("référence inconnue");
    // Sans merchant_transaction_id, le service retrouve le paiement par l'identifiant de CinetPay noté à charge().
    return { idEvenement: `cinetpay:${id}`.slice(0, 200), reference: typeof ref === "string" ? ref : "", referenceFournisseur: id };
  }
}
