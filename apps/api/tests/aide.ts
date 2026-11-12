// WAKATNET — aides des tests de l'API. PostgreSQL réel (§14.4 : faux aux frontières seulement).
// Variables posées par tests/run.sh : URL admin (données de test) et URL wk_api (code testé).
import type { Expediteur } from "../src/courriel.ts";
import { createHash, randomBytes } from "node:crypto";

// MockProvider : autorisé explicitement pour les tests seulement (packages/payments/src/mock.ts).
process.env.WAKATNET_MOCK = "1";
import pg from "pg";
import { construire } from "../src/app.ts";
import { ouvrirBase, type Base } from "../src/base.ts";
import type { Config } from "../src/config.ts";
import { NOEUDS } from "./aide-sans-base.ts";

export { NOEUDS };

export const URL_ADMIN = exiger("WAKATNET_TEST_ADMIN_URL");
export const URL_API = exiger("WAKATNET_API_DATABASE_URL");

function exiger(nom: string): string {
  const v = process.env[nom];
  if (!v) throw new Error(`${nom} manquant : lancer les tests par tests/run.sh`);
  return v;
}

export async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(url: string, texte: string, valeurs: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(texte, valeurs)).rows;
  } finally {
    await c.end();
  }
}

let compteur = 0;

/** Empreinte scrypt d'un mot de passe de test, calculée une fois (ADR 0014 §1). */
export const MDP_TEST = "mot-de-passe-de-test";
let EMPREINTE: Promise<string> | null = null;
export const empreinteTest = () => (EMPREINTE ??= import("../src/auth.ts").then((m) => m.hacher(MDP_TEST)));

/** Jeton de session de chaque propriétaire de test (vraie session, ADR 0014 §1). */
const SESSIONS = new Map<string, string>();

/** Compte et session pour un utilisateur ; rend le jeton du cookie. */
export async function session(tenant: string | null, role: string, pdv: string | null = null, email?: string): Promise<{ jeton: string; utilisateur: string }> {
  const adresse = email ?? `test-${process.pid}-${randomBytes(6).toString("hex")}@exemple.bf`;
  const [u] = await sql<{ id: string }>(URL_ADMIN,
    // Adresse réputée vérifiée (ADR 0017) : les tests de la vérification la remettent à NULL eux-mêmes.
    `INSERT INTO app.utilisateur (tenant_id, point_of_sale_id, role, email, mot_de_passe, totp_secret, email_verifie_le)
     VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id::text`,
    [tenant, pdv, role, adresse, await empreinteTest(), role === "super_admin" ? Buffer.alloc(40) : null]);
  const jeton = randomBytes(32).toString("base64url");
  await sql(URL_ADMIN, "SELECT app.session_ouvrir($1, $2)", [u.id, createHash("sha256").update(jeton).digest()]);
  return { jeton, utilisateur: u.id };
}

/** En-têtes d'une requête du propriétaire `tenant` : cookie de session et en-tête anti-CSRF. */
export function entetes(tenant: string): Record<string, string> {
  const j = SESSIONS.get(tenant);
  if (!j) throw new Error(`aucune session pour le propriétaire ${tenant}`);
  return { cookie: `wk_session=${j}`, "x-wakatnet-requete": "1" };
}

export const entetesJeton = (jeton: string) => ({ cookie: `wk_session=${jeton}`, "x-wakatnet-requete": "1" });

/** Un propriétaire neuf avec un site, un compte et une session. */
export async function proprietaire(nom: string): Promise<{ tenant: string; site: string }> {
  // Quota d'enrôlement large (ADR 0017) : les tests de l'enrôlement créent de nombreux jetons ; ceux du quota le baissent.
  const [t] = await sql<{ id: string }>(URL_ADMIN, "INSERT INTO app.tenant (nom, quota_routeurs, valide_admin) VALUES ($1, 10000, true) RETURNING id::text", [nom]);
  SESSIONS.set(t.id, (await session(t.id, "proprietaire")).jeton);
  const [s] = await sql<{ id: string }>(URL_ADMIN,
    "INSERT INTO app.site (tenant_id, nom) VALUES ($1, $2) RETURNING id::text", [t.id, `site de ${nom}`]);
  return { tenant: t.id, site: s.id };
}

export async function routeur(tenant: string, site: string): Promise<string> {
  compteur++;
  // Adresse suivante dans 10.213.200.0/22, réservée aux tests de l'API (les tests repassent
  // sur une base déjà peuplée quand on les relance à la main).
  const [r] = await sql<{ id: string }>(URL_ADMIN,
    `INSERT INTO app.router (tenant_id, site_id, overlay_ip, shortname)
     SELECT $1, $2, coalesce(max(overlay_ip), '10.213.200.0/32'::inet) + 1, $3
       FROM app.router WHERE overlay_ip << '10.213.200.0/22'::inet
     RETURNING id::text`,
    [tenant, site, `test-${process.pid}-${compteur}`]);
  return r.id;
}


/** Clés de chiffrement jetables, propres à ce processus de test. */
export const CLES = { marchands: randomBytes(32), hmac: randomBytes(32) };

export function config(surcharge: Partial<Config> = {}): Config {
  return { urlBase: URL_API, urlPublique: "https://api.test.invalid", urlPortail: "https://portail.test.invalid", noeuds: NOEUDS, cles: CLES, ...surcharge };
}

export async function avecApp<T>(travail: (app: ReturnType<typeof construire>, base: Base) => Promise<T>,
                                 conf: Config = config(), options: { expediteur?: Expediteur } = {}): Promise<T> {
  const base = ouvrirBase(conf.urlBase);
  const app = construire(conf, base, { journal: false, ...options });
  try {
    return await travail(app, base);
  } finally {
    await app.close();
    await base.$disconnect();
  }
}
