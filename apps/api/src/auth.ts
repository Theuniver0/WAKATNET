// WAKATNET — comptes, sessions, rôles, TOTP (ADR 0014 §1 à §3).
// Ticket : .scratch/phase-4-exploitation/issues/02-comptes-auth.md
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Base } from "./base.ts";
import { chiffrer, dechiffrer } from "./chiffrement.ts";
import { cleSource } from "./cle-ip.ts";
import { messageAttente, messageAvis, messageVerification, type Expediteur } from "./courriel.ts";

export type Role = "super_admin" | "proprietaire" | "gerant" | "vendeur";
export type Utilisateur = { id: bigint; tenantId: bigint | null; pdvId: bigint | null; role: Role; email: string; totpOk: boolean };

declare module "fastify" {
  interface FastifyRequest {
    utilisateur: Utilisateur | null;
  }
  interface FastifyContextConfig {
    /** Rôles admis par la route (défaut : propriétaire seulement). */
    roles?: Role[];
  }
}

export const COOKIE_SESSION = "wk_session";
export const EN_TETE_CSRF = "x-wakatnet-requete";

// ------------------------------------------------------------------ mots de passe (scrypt)
const N = 32768, R = 8, P = 1, LONGUEUR = 32;

/** Audit du 13/11/2026 (LIMITES n° 2) : nginx borne scrypt par /64, mais un abonné qui détient un /56 ou un /48 en a des
 *  centaines. Plafond GLOBAL : au plus SCRYPT_ACTIFS calculs à la fois (autant que de fils libuv par défaut), et
 *  SCRYPT_ATTENTE en file ; au-delà, refus immédiat (503 et Retry-After), pour que le reste de l'API, portail et
 *  paiements compris, garde ses fils libuv. */
export class CalculsSatures extends Error {
  readonly statusCode = 503;
  constructor() { super("calculs de mots de passe saturés"); this.name = "CalculsSatures"; }
}
const SCRYPT_ACTIFS = 4, SCRYPT_ATTENTE = 32;
let scryptActifs = 0;
const scryptFile: (() => void)[] = [];
async function avecPlace<T>(f: () => Promise<T>): Promise<T> {
  if (scryptActifs < SCRYPT_ACTIFS) scryptActifs++;
  else if (scryptFile.length < SCRYPT_ATTENTE) await new Promise<void>((ok) => scryptFile.push(ok));   // place transmise
  else throw new CalculsSatures();
  try { return await f(); } finally {
    const suivant = scryptFile.shift();
    if (suivant) suivant(); else scryptActifs--;
  }
}

function scryptAsync(mdp: string, sel: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return avecPlace(() => new Promise((ok, ko) => scrypt(mdp, sel, LONGUEUR, { N: n, r, p, maxmem: 128 * n * r * 2 }, (e, k) => (e ? ko(e) : ok(k)))));
}

export async function hacher(mdp: string): Promise<string> {
  const sel = randomBytes(16);
  const k = await scryptAsync(mdp, sel, N, R, P);
  return `scrypt$${N}$${R}$${P}$${sel.toString("base64")}$${k.toString("base64")}`;
}

/** Comparaison en temps constant ; une forme inattendue vaut « faux ». */
export async function verifier(mdp: string, stocke: string): Promise<boolean> {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stocke);
  if (!m) return false;
  const [n, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (n > 1 << 20 || r > 32 || p > 16) return false;
  const attendu = Buffer.from(m[5], "base64");
  const k = await scryptAsync(mdp, Buffer.from(m[4], "base64"), n, r, p);
  return k.length === attendu.length && timingSafeEqual(k, attendu);
}

/** Empreinte factice : le même temps de calcul, que le compte existe ou non. Un échec (calculs saturés) n'est PAS gardé :
 *  sinon toute connexion sur une adresse inconnue répondrait 503 jusqu'au redémarrage de l'API (relecture du 14/11/2026). */
let EMPREINTE_FACTICE: Promise<string> | null = null;
const empreinteFactice = (): Promise<string> => {
  if (EMPREINTE_FACTICE === null) {
    const p: Promise<string> = hacher(randomBytes(16).toString("hex")).catch((e: unknown) => {
      if (EMPREINTE_FACTICE === p) EMPREINTE_FACTICE = null;
      throw e;
    });
    EMPREINTE_FACTICE = p;
  }
  return EMPREINTE_FACTICE;
};

/** Pour les tests seulement : oublier l'empreinte factice, et occuper toutes les places de calcul (rend la fonction qui
 *  les libère). */
const horsProduction = () => {
  if (process.env.NODE_ENV === "production") throw new Error("_pourTests : interdit en production");
};
export const _pourTests = {
  oublierEmpreinteFactice: (): void => { horsProduction(); EMPREINTE_FACTICE = null; },
  saturer: (): (() => void) => {
    horsProduction();
    let ouvrir!: () => void;
    const porte = new Promise<void>((ok) => (ouvrir = ok));
    for (let i = 0; i < SCRYPT_ACTIFS + SCRYPT_ATTENTE; i++) void avecPlace(() => porte).catch(() => undefined);
    return ouvrir;
  },
};

export function mdpAcceptable(mdp: unknown): mdp is string {
  return typeof mdp === "string" && mdp.length >= 10 && mdp.length <= 200;
}

// ------------------------------------------------------------------ TOTP (RFC 6238)
export function base32Decoder(s: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const i = A.indexOf(c);
    if (i < 0) throw new Error("base32 invalide");
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function base32Encoder(b: Buffer): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0, out = "";
  for (const x of b) {
    val = (val << 8) | x;
    bits += 8;
    while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}

/** HOTP (RFC 4226) sur un compteur, `chiffres` chiffres. */
export function hotp(secret: Buffer, compteur: bigint, chiffres = 6): string {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(compteur);
  const h = createHmac("sha1", secret).update(c).digest();
  const o = h[h.length - 1] & 15;
  const v = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return (v % 10 ** chiffres).toString().padStart(chiffres, "0");
}

export const pasTotp = (ms: number) => BigInt(Math.floor(ms / 1000 / 30));

/** Pas accepté (±1 pas toléré), ou null. */
export function totpPas(secret: Buffer, code: string, ms = Date.now()): bigint | null {
  if (!/^[0-9]{6}$/.test(code)) return null;
  const t = pasTotp(ms);
  for (const d of [0n, -1n, 1n]) {
    const a = Buffer.from(hotp(secret, t + d));
    if (timingSafeEqual(a, Buffer.from(code))) return t + d;
  }
  return null;
}

// ------------------------------------------------------------------ sessions
const empreinte = (j: string) => createHash("sha256").update(j).digest();

function lireCookie(req: FastifyRequest): string | null {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE_SESSION}=([A-Za-z0-9_-]{43})(?:;|$)`).exec(req.headers.cookie ?? "");
  return m ? m[1] : null;
}

async function utilisateurDe(base: Base, req: FastifyRequest): Promise<Utilisateur | null> {
  const j = lireCookie(req);
  if (j === null) return null;
  const [u] = await base.$queryRaw<{ utilisateur_id: bigint; tenant_id: bigint | null; point_of_sale_id: bigint | null;
                                     role: Role; email: string; totp_ok: boolean }[]>`
    SELECT utilisateur_id, tenant_id, point_of_sale_id, role, email, totp_ok FROM app.session_lire(${empreinte(j)})`;
  return u ? { id: u.utilisateur_id, tenantId: u.tenant_id, pdvId: u.point_of_sale_id, role: u.role, email: u.email, totpOk: u.totp_ok } : null;
}

/** CSRF (ADR 0014 §1) : toute requête qui modifie porte l'en-tête X-Wakatnet-Requete: 1. */
function csrfOk(req: FastifyRequest): boolean {
  return req.method === "GET" || req.method === "HEAD" || req.headers[EN_TETE_CSRF] === "1";
}

/**
 * Garde d'un ensemble de routes : session valide, rôle admis par la route (défaut : propriétaire),
 * en-tête anti-CSRF. `admin` : super-admin dont la session a validé son TOTP.
 */
export function garde(base: Base, mode: "proprietaire" | "admin") {
  return async (req: FastifyRequest, rep: FastifyReply) => {
    if (!csrfOk(req)) return rep.code(403).send({ erreur: "en-tête X-Wakatnet-Requete manquant" });
    const u = await utilisateurDe(base, req);
    if (u === null) return rep.code(401).send({ erreur: "connexion requise" });
    if (mode === "admin") {
      if (u.role !== "super_admin") return rep.code(403).send({ erreur: "réservé au super-admin" });
      if (!u.totpOk) return rep.code(403).send({ erreur: "double authentification requise" });
    } else {
      const roles = req.routeOptions.config.roles ?? ["proprietaire"];
      if (!roles.includes(u.role) || u.tenantId === null) return rep.code(403).send({ erreur: "accès refusé pour ce rôle" });
      req.tenantId = u.tenantId;
    }
    req.utilisateur = u;
  };
}

// ------------------------------------------------------------------ routes publiques et de session
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[a-zA-Z]{2,24}$/;
/** Adresse acceptée à l'inscription et au renvoi. Le domaine de premier niveau .invalid (RFC 2606) ne reçoit jamais
 *  d'e-mail, et wakatnet.invalid est réservé aux adresses purgées (audit du 13/11/2026, migration 0039). */
export const emailAcceptable = (e: unknown): e is string =>
  typeof e === "string" && e.length <= 254 && EMAIL.test(e) && !/\.invalid$/i.test(e);

// Envois partis après la réponse (audit du 13/11/2026) : suivis, pour que l'arrêt de l'API (et les tests) les attendent.
// Les renvois de lien ne sont plus acceptés au-delà de 500 travaux en cours : la réponse ne les attendant plus, un client
// pressé ne doit pas les accumuler sans fin. L'envoi d'un lien déjà créé et compté, lui, part toujours.
const ENVOIS = new Set<Promise<unknown>>();
const ENVOIS_MAX = 500;
function enArrierePlan(travail: () => Promise<unknown>): void {
  const p: Promise<unknown> = travail().catch(() => undefined).finally(() => ENVOIS.delete(p));
  ENVOIS.add(p);
}
/** Attend la fin des envois en arrière-plan (arrêt de l'API, tests). */
export async function envoisEnCours(): Promise<void> {
  while (ENVOIS.size > 0) await Promise.allSettled([...ENVOIS]);
}

// Appareil connu (revue de sécurité M2, migration 0031) : posé à chaque connexion réussie, envoyé seulement à
// /v1/connexion ; il donne un budget d'essais propre, que le plafond global d'une attaque distribuée n'atteint pas.
const COOKIE_APPAREIL = "wk_appareil";
function lireAppareil(req: FastifyRequest): string | null {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE_APPAREIL}=([A-Za-z0-9_-]{43})(?:;|$)`).exec(req.headers.cookie ?? "");
  return m ? m[1] : null;
}

function poserSession(rep: FastifyReply, jeton: string) {
  rep.header("set-cookie", `${COOKIE_SESSION}=${jeton}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`);
}

export async function ouvrirSession(base: Base, utilisateurId: bigint): Promise<string> {
  const jeton = randomBytes(32).toString("base64url");
  await base.$executeRaw`SELECT app.session_ouvrir(${utilisateurId}, ${empreinte(jeton)})`;
  return jeton;
}

/** Vérification de l'adresse (ADR 0017) : nouveau lien pour ce propriétaire, envoyé si un expéditeur existe.
 *  Rend false sans expéditeur, adresse déjà vérifiée, 3 liens dans l'heure, 5 en tout, ou plafond global plein. La place
 *  sur le plafond est prise AVANT de créer le lien, dans la même transaction (migration 0039) ; un envoi refusé par le
 *  fournisseur est décompté. Jamais d'erreur vers l'appelant : l'inscription ne doit pas en dépendre. */
async function envoyerVerification(base: Base, courriel: { expediteur: Expediteur | null; urlTableau: string },
                                   utilisateur: bigint, journal: FastifyBaseLogger): Promise<boolean> {
  const expediteur = courriel.expediteur;
  if (expediteur === null) return false;
  // Relecture C4 et C5 : une erreur de la base ou du fournisseur ne fait jamais échouer l'inscription, et son
  // message (qui pourrait citer l'adresse ou le lien) n'est pas journalisé.
  try {
    const jeton = randomBytes(32).toString("base64url");
    const e = empreinte(jeton);
    const [{ email }] = await base.$queryRaw<{ email: string | null }[]>`SELECT app.verification_creer(${utilisateur}, ${e}) AS email`;
    if (email === null) return false;
    // Envoi en arrière-plan (relecture ADR 0019) : la durée de la réponse ne dépend pas de l'aller-retour vers Brevo.
    enArrierePlan(() => expediteur.envoyer(messageVerification(email, `${courriel.urlTableau}#/verifier?j=${jeton}`)).catch(async () => {
      journal.error("envoi du lien de vérification échoué");
      // Le lien n'est pas parti : il ne compte pas dans les limites du compte (audit du 13/11/2026).
      await base.$queryRaw`SELECT app.verification_annuler(${e})`.catch(() => journal.error("décompte du lien non envoyé échoué"));
    }));
    return true;
  } catch {
    journal.error("envoi du lien de vérification échoué");
    return false;
  }
}

// ADR 0019 (F9) : un seul message pour tout échec de connexion, adresse non confirmée comprise.
const ECHEC_CONNEXION = "Adresse ou mot de passe incorrect, ou adresse pas encore confirmée (lien reçu par e-mail).";
const REPONSE_INSCRIPTION = "Si cette adresse n'a pas encore de compte, il vient d'être créé : ouvrez le lien de confirmation reçu par e-mail, choisissez-y votre mot de passe, puis connectez-vous.";
const REPONSE_RENVOI = "Si un compte attend la confirmation de cette adresse, un nouveau lien vient d'être envoyé.";

/** Avis à une adresse déjà inscrite (ADR 0019) : « compte existant », ou « compte en attente » quand l'adresse n'est pas
 *  confirmée (audit du 13/11/2026 : le mot de passe de cette dernière demande vaut désormais). 1 par jour et par compte ;
 *  place prise sur le plafond global en base ; jamais d'erreur vers l'appelant. */
async function envoyerAvis(base: Base, courriel: { expediteur: Expediteur | null; urlTableau: string },
                           utilisateur: bigint, attente: boolean, journal: FastifyBaseLogger): Promise<void> {
  const expediteur = courriel.expediteur;
  if (expediteur === null) return;
  try {
    const [{ email }] = await base.$queryRaw<{ email: string | null }[]>`SELECT app.avis_compte_existant(${utilisateur}) AS email`;
    if (email !== null) {
      const m = attente ? messageAttente(email, courriel.urlTableau) : messageAvis(email, courriel.urlTableau);
      enArrierePlan(() => expediteur.envoyer(m).catch(() => journal.error("envoi de l'avis de compte existant échoué")));
    }
  } catch {
    journal.error("envoi de l'avis de compte existant échoué");
  }
}

export function routesAuth(app: FastifyInstance, base: Base, cleChiffrement: Buffer | null, cleHmac: Buffer | null = null,
                           courriel: { expediteur: Expediteur | null; urlTableau: string } = { expediteur: null, urlTableau: "" }): void {
  // À l'arrêt, les envois partis après la réponse se terminent avant la fermeture de la base.
  app.addHook("onClose", async () => { await envoisEnCours(); });
  // Empreinte factice préparée au démarrage : la première adresse inconnue ne paie pas deux calculs (écart de durée).
  void empreinteFactice().catch(() => undefined);
  app.register(async (pub) => {
    pub.addHook("onRequest", async (req, rep) => {
      if (!csrfOk(req)) return rep.code(403).send({ erreur: "en-tête X-Wakatnet-Requete manquant" });
    });

    // Inscription d'un propriétaire (accès ouvert, ADR 0001 §5). ADR 0019 : aucune session, et la même réponse que
    // l'adresse soit libre ou déjà inscrite (F9). Un compte neuf reçoit le lien ; une adresse déjà inscrite, un avis.
    // Depuis le scan de sécurité F2 (migration 0043), le mot de passe se choisit à la confirmation : celui de
    // l'inscription n'est plus demandé (décision de Yacouba, 14/11/2026), et un « mot_de_passe » encore envoyé par un
    // ancien client est ignoré. Le compte neuf reçoit un secret aléatoire, haché comme avant (même durée de réponse) :
    // personne ne le connaît, et la connexion reste fermée jusqu'à la confirmation.
    pub.post<{ Body: { nom?: unknown; email?: unknown } }>("/v1/inscription", async (req, rep) => {
      const { nom, email } = req.body ?? {};
      // 80 caractères : la limite de la colonne app.utilisateur.nom (audit du 13/11/2026).
      if (typeof nom !== "string" || nom.trim().length < 1 || nom.length > 80) return rep.code(422).send({ erreur: "nom de 1 à 80 caractères" });
      if (!emailAcceptable(email)) return rep.code(422).send({ erreur: "adresse e-mail invalide" });
      const empreinteMdp = await hacher(randomBytes(32).toString("base64url"));
      const [r] = await base.$queryRaw<{ statut: string; utilisateur_id: bigint | null }[]>`
        SELECT statut, utilisateur_id FROM app.inscription_demander(${nom.trim()}, ${email}, ${empreinteMdp}, ${cleSource(req.ip, cleHmac, new Date(), 48)})`;
      if (r.statut === "trop") return rep.code(429).send({ erreur: "Trop de demandes depuis cette connexion : réessayez plus tard." });
      // Le lien (compte neuf) ou l'avis (adresse déjà inscrite) se préparent APRÈS la réponse : ils ne font pas le même
      // travail en base (relecture du 14/11/2026, comme le renvoi). Reste un écart propre à inscription_demander (création
      // ou lecture d'un compte), de quelques millisecondes, borné par la limite de 5 inscriptions par heure et par source.
      const id = r.utilisateur_id;
      if (r.statut === "cree") enArrierePlan(() => envoyerVerification(base, courriel, id!, req.log));
      else if ((r.statut === "existe" || r.statut === "attente") && id !== null) {
        const attente = r.statut === "attente";
        enArrierePlan(() => envoyerAvis(base, courriel, id, attente, req.log));
      }
      return rep.code(202).send({ ok: true, message: REPONSE_INSCRIPTION });
    });

    // Lien perdu (ADR 0019) : renvoi sans session, réponse toujours identique ; 5 par heure et 10 par jour et par source.
    // Audit du 13/11/2026 : la réponse part AVANT tout travail en base, qui se fait ensuite ; sa durée ne dit donc pas si
    // un compte attend la confirmation de cette adresse. Les erreurs sont journalisées sans donnée personnelle.
    pub.post<{ Body: { email?: unknown } }>("/v1/verification/renvoyer", async (req, rep) => {
      const email = req.body?.email;
      if (!emailAcceptable(email)) return rep.code(422).send({ erreur: "adresse e-mail invalide" });
      const source = cleSource(req.ip, cleHmac, new Date(), 48);
      const journal = req.log;
      if (ENVOIS.size >= ENVOIS_MAX) {
        journal.error("renvoi du lien abandonné : trop de travaux en cours");
        return rep.code(202).send({ ok: true, message: REPONSE_RENVOI });
      }
      enArrierePlan(async () => {
        try {
          const [{ u }] = await base.$queryRaw<{ u: bigint | null }[]>`SELECT app.renvoi_demander(${email}, ${source}) AS u`;
          if (u !== null) await envoyerVerification(base, courriel, u, journal);
        } catch {
          journal.error("renvoi du lien de vérification échoué");
        }
      });
      return rep.code(202).send({ ok: true, message: REPONSE_RENVOI });
    });

    // Lien de vérification suivi (ADR 0017) : public. La page du tableau de bord demande un clic avant cet appel,
    // car les antivirus de messagerie ouvrent les liens (un GET ne consomme rien).
    // Scan de sécurité du 13/11/2026 (F2, migration 0043) : le mot de passe se choisit ICI, par le détenteur du lien.
    // L'inscription ne fixe plus rien d'un compte en attente : ni un tiers inscrit avant, ni un tiers inscrit après,
    // n'activent leur mot de passe.
    pub.post<{ Body: { jeton?: unknown; mot_de_passe?: unknown } }>("/v1/verification/confirmer", async (req, rep) => {
      const j = req.body?.jeton, mdp = req.body?.mot_de_passe;
      if (typeof j !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(j)) return rep.code(404).send({ erreur: "lien invalide ou expiré" });
      if (!mdpAcceptable(mdp)) return rep.code(422).send({ erreur: "choisissez un mot de passe de 10 caractères au moins" });
      const [{ ok }] = await base.$queryRaw<{ ok: boolean }[]>`SELECT app.verification_confirmer(${empreinte(j)}, ${await hacher(mdp)}) AS ok`;
      if (!ok) return rep.code(404).send({ erreur: "lien invalide ou expiré" });
      return { ok: true };
    });

    // Nouveau lien, à la demande du propriétaire connecté.
    pub.post("/v1/verification/envoyer", async (req, rep) => {
      const u = await utilisateurDe(base, req);
      if (u === null) return rep.code(401).send({ erreur: "connexion requise" });
      if (u.role !== "proprietaire") return rep.code(403).send({ erreur: "réservé au propriétaire" });
      if (courriel.expediteur === null) {
        return rep.code(503).send({ erreur: "L'envoi d'e-mails n'est pas encore en service : Telecom Universel valide votre adresse sur demande." });
      }
      if (!(await envoyerVerification(base, courriel, u.id, req.log))) {
        return rep.code(429).send({ erreur: "Adresse déjà vérifiée, ou trop de liens demandés : réessayez dans une heure." });
      }
      return rep.code(202).send({ ok: true });
    });

    // Connexion : même réponse que le compte existe ou non ; 5 essais par adresse et par source (ou par appareil
    // connu) en 15 min, 10 par adresse toutes sources inconnues confondues, RÉSERVÉS en base avant la vérification (revue de sécurité M2, migrations
    // 0030 et 0031 : des requêtes parallèles ne passent plus outre, un tiers ne bloque plus le compte à lui seul).
    pub.post<{ Body: { email?: unknown; mot_de_passe?: unknown } }>("/v1/connexion", async (req, rep) => {
      const { email, mot_de_passe } = req.body ?? {};
      if (typeof email !== "string" || typeof mot_de_passe !== "string" || email.length > 254 || mot_de_passe.length > 200) {
        return rep.code(401).send({ erreur: ECHEC_CONNEXION });
      }
      const appareil = lireAppareil(req);
      const [{ essai }] = await base.$queryRaw<{ essai: bigint | null }[]>`
        SELECT app.connexion_reserver(${email}, ${cleSource(req.ip, cleHmac)}, ${appareil ? empreinte(appareil) : null}::bytea) AS essai`;
      if (essai === null) return rep.code(429).send({ erreur: "trop d'essais : patientez 15 minutes" });
      const [l] = await base.$queryRaw<{ utilisateur_id: bigint | null; mot_de_passe: string | null; actif: boolean | null }[]>`
        SELECT utilisateur_id, mot_de_passe, actif FROM app.connexion_lire(${email})`;
      let bon: boolean;
      try {
        bon = await verifier(mot_de_passe, l.mot_de_passe ?? (await empreinteFactice()));
      } catch (e) {
        // Calculs saturés (503) : aucun mot de passe n'a été vérifié, l'essai ne compte pas. Sinon, qui sature scrypt
        // ferait perdre leurs essais aux vrais utilisateurs (relecture du 14/11/2026). Avec un appareil NULL,
        // connexion_reussie efface seulement la réservation (migration 0031).
        if (e instanceof CalculsSatures) {
          // Une base indisponible ici ne change pas la réponse (503) : l'essai reste alors compté, ce qui est prudent.
          await base.$executeRaw`SELECT app.connexion_reussie(${essai}, NULL::bytea)`
            .catch(() => req.log.error("libération de l'essai saturé échouée"));
        }
        throw e;
      }
      // Échec : la réservation reste et compte. Réussite : elle est effacée.
      if (!bon || l.utilisateur_id === null || !l.actif) return rep.code(401).send({ erreur: ECHEC_CONNEXION });
      const jetonAppareil = appareil ?? randomBytes(32).toString("base64url");
      await base.$executeRaw`SELECT app.connexion_reussie(${essai}, ${empreinte(jetonAppareil)})`;
      poserSession(rep, await ouvrirSession(base, l.utilisateur_id));
      rep.header("set-cookie", `${COOKIE_APPAREIL}=${jetonAppareil}; Path=/v1/connexion; HttpOnly; Secure; SameSite=Strict; Max-Age=7776000`);
      return { ok: true };
    });

    pub.post("/v1/deconnexion", async (req, rep) => {
      const j = lireCookie(req);
      if (j) await base.$executeRaw`SELECT app.session_fermer(${empreinte(j)})`;
      rep.header("set-cookie", `${COOKIE_SESSION}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      return { ok: true };
    });

    pub.get("/v1/moi", async (req, rep) => {
      const u = await utilisateurDe(base, req);
      if (u === null) return rep.code(401).send({ erreur: "connexion requise" });
      const [{ verifie }] = await base.$queryRaw<{ verifie: boolean | null }[]>`
        SELECT app.session_email_verifie(${empreinte(lireCookie(req)!)}) AS verifie`;
      return { id: u.id.toString(), role: u.role, email: u.email, tenant_id: u.tenantId?.toString() ?? null,
               point_of_sale_id: u.pdvId?.toString() ?? null, totp_ok: u.totpOk, email_verifie: verifie === true };
    });

    // TOTP du super-admin : valide la session pour les routes /admin (ADR 0014 §3).
    pub.post<{ Body: { code?: unknown } }>("/v1/totp", async (req, rep) => {
      const j = lireCookie(req);
      if (j === null || cleChiffrement === null) return rep.code(401).send({ erreur: "connexion requise" });
      const [s] = await base.$queryRaw<{ email: string; secret: Buffer | null }[]>`
        SELECT email, secret FROM app.totp_secret(${empreinte(j)})`;
      if (!s || !s.secret) return rep.code(403).send({ erreur: "double authentification indisponible" });
      // 5 essais en 15 min par super-admin, réservés avant la vérification ; au-delà, session fermée et
      // événement audité (revue de sécurité E2 : 10^6 codes se devinaient sans limite).
      const [{ essai }] = await base.$queryRaw<{ essai: bigint | null }[]>`SELECT app.totp_reserver(${empreinte(j)}) AS essai`;
      if (essai === null) {
        rep.header("set-cookie", `${COOKIE_SESSION}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
        return rep.code(429).send({ erreur: "trop d'essais : session fermée, reconnectez-vous dans 15 minutes" });
      }
      const secret = dechiffrer(cleChiffrement, s.secret, `totp:${s.email}`);
      const pas = totpPas(secret, String(req.body?.code ?? ""));
      if (pas === null) return rep.code(401).send({ erreur: "code invalide" });
      const [{ ok }] = await base.$queryRaw<{ ok: boolean }[]>`SELECT app.totp_valider(${empreinte(j)}, ${pas}) AS ok`;
      if (!ok) return rep.code(401).send({ erreur: "code déjà utilisé" });
      await base.$executeRaw`SELECT app.totp_reussi(${essai})`;
      return { ok: true };
    });
  });
}

/** Secret TOTP chiffré pour un super-admin (script de création) ; donnée associée : son adresse. */
export function chiffrerTotp(cle: Buffer, email: string, secret: Buffer): Buffer {
  return chiffrer(cle, secret, `totp:${email.toLowerCase()}`);
}
