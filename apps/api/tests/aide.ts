// WAKATNET — aides des tests de l'API. PostgreSQL réel (§14.4 : faux aux frontières seulement).
// Variables posées par tests/run.sh : URL admin (données de test) et URL wk_api (code testé).
import { randomBytes } from "node:crypto";

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
/** Un propriétaire neuf avec un site. */
export async function proprietaire(nom: string): Promise<{ tenant: string; site: string }> {
  const [t] = await sql<{ id: string }>(URL_ADMIN, "INSERT INTO app.tenant (nom) VALUES ($1) RETURNING id::text", [nom]);
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
  return { urlBase: URL_API, authDev: true, urlPublique: "https://api.test.invalid", urlPortail: "https://portail.test.invalid", noeuds: NOEUDS, cles: CLES, ...surcharge };
}

export async function avecApp<T>(travail: (app: ReturnType<typeof construire>, base: Base) => Promise<T>,
                                 conf: Config = config()): Promise<T> {
  const base = ouvrirBase(conf.urlBase);
  const app = construire(conf, base, { journal: false });
  try {
    return await travail(app, base);
  } finally {
    await app.close();
    await base.$disconnect();
  }
}
