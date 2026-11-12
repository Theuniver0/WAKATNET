// WAKATNET — comptes, sessions, rôles, TOTP (ADR 0014 §1 à §3).
// Ticket : .scratch/phase-4-exploitation/issues/02-comptes-auth.md
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Base } from "./base.ts";
import { chiffrer, dechiffrer } from "./chiffrement.ts";

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

function scryptAsync(mdp: string, sel: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((ok, ko) => scrypt(mdp, sel, LONGUEUR, { N: n, r, p, maxmem: 128 * n * r * 2 }, (e, k) => (e ? ko(e) : ok(k))));
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

/** Empreinte factice : le même temps de calcul, que le compte existe ou non. */
let EMPREINTE_FACTICE: Promise<string> | null = null;
const empreinteFactice = () => (EMPREINTE_FACTICE ??= hacher(randomBytes(16).toString("hex")));

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

function poserSession(rep: FastifyReply, jeton: string) {
  rep.header("set-cookie", `${COOKIE_SESSION}=${jeton}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`);
}

export async function ouvrirSession(base: Base, utilisateurId: bigint): Promise<string> {
  const jeton = randomBytes(32).toString("base64url");
  await base.$executeRaw`SELECT app.session_ouvrir(${utilisateurId}, ${empreinte(jeton)})`;
  return jeton;
}

export function routesAuth(app: FastifyInstance, base: Base, cleChiffrement: Buffer | null): void {
  app.register(async (pub) => {
    pub.addHook("onRequest", async (req, rep) => {
      if (!csrfOk(req)) return rep.code(403).send({ erreur: "en-tête X-Wakatnet-Requete manquant" });
    });

    // Inscription d'un propriétaire (accès ouvert, ADR 0001 §5).
    pub.post<{ Body: { nom?: unknown; email?: unknown; mot_de_passe?: unknown } }>("/v1/inscription", async (req, rep) => {
      const { nom, email, mot_de_passe } = req.body ?? {};
      if (typeof nom !== "string" || nom.trim().length < 1 || nom.length > 120) return rep.code(422).send({ erreur: "nom de 1 à 120 caractères" });
      if (typeof email !== "string" || !EMAIL.test(email)) return rep.code(422).send({ erreur: "adresse e-mail invalide" });
      if (!mdpAcceptable(mot_de_passe)) return rep.code(422).send({ erreur: "mot de passe de 10 caractères au moins" });
      const [r] = await base.$queryRaw<{ statut: string; utilisateur_id: bigint | null }[]>`
        SELECT statut, utilisateur_id FROM app.inscription(${nom.trim()}, ${email}, ${await hacher(mot_de_passe)})`;
      if (r.statut !== "cree") return rep.code(409).send({ erreur: "adresse déjà utilisée" });
      poserSession(rep, await ouvrirSession(base, r.utilisateur_id!));
      return rep.code(201).send({ ok: true });
    });

    // Connexion : même réponse que le compte existe ou non ; 5 essais par adresse en 15 min, RÉSERVÉS en
    // base avant la vérification (revue de sécurité M2 : des requêtes parallèles ne passent plus outre).
    pub.post<{ Body: { email?: unknown; mot_de_passe?: unknown } }>("/v1/connexion", async (req, rep) => {
      const { email, mot_de_passe } = req.body ?? {};
      if (typeof email !== "string" || typeof mot_de_passe !== "string" || email.length > 254 || mot_de_passe.length > 200) {
        return rep.code(401).send({ erreur: "adresse ou mot de passe incorrect" });
      }
      const [{ essai }] = await base.$queryRaw<{ essai: bigint | null }[]>`SELECT app.connexion_reserver(${email}) AS essai`;
      if (essai === null) return rep.code(429).send({ erreur: "trop d'essais : patientez 15 minutes" });
      const [l] = await base.$queryRaw<{ utilisateur_id: bigint | null; mot_de_passe: string | null; actif: boolean | null }[]>`
        SELECT utilisateur_id, mot_de_passe, actif FROM app.connexion_lire(${email})`;
      const bon = await verifier(mot_de_passe, l.mot_de_passe ?? (await empreinteFactice()));
      // Échec : la réservation reste et compte. Réussite : elle est effacée.
      if (!bon || l.utilisateur_id === null || !l.actif) return rep.code(401).send({ erreur: "adresse ou mot de passe incorrect" });
      await base.$executeRaw`SELECT app.connexion_reussie(${essai})`;
      poserSession(rep, await ouvrirSession(base, l.utilisateur_id));
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
      return { id: u.id.toString(), role: u.role, email: u.email, tenant_id: u.tenantId?.toString() ?? null,
               point_of_sale_id: u.pdvId?.toString() ?? null, totp_ok: u.totpOk };
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
