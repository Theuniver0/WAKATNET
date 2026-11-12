// Cloisonnement (I1, I2 ; ADR 0012 §6) : A ne voit ni ne modifie B, par l'API ou en SQL direct.
// Ticket : .scratch/phase-2-multi-proprietaires/issues/02-socle-applicatif.md
import assert from "node:assert/strict";
import { before, test } from "node:test";
import pg from "pg";
import { avecApp, proprietaire, routeur, sql, URL_API, URL_ADMIN, entetes } from "./aide.ts";

let A: { tenant: string; site: string };
let B: { tenant: string; site: string };
let rA: string;
let rB: string;

before(async () => {
  A = await proprietaire("isolement A");
  B = await proprietaire("isolement B");
  rA = await routeur(A.tenant, A.site);
  rB = await routeur(B.tenant, B.site);
  await sql(URL_ADMIN, "INSERT INTO app.audit_log (tenant_id, acteur, action, objet) VALUES ($1, 'test', 'x', 'y'), ($2, 'test', 'x', 'y')",
            [A.tenant, B.tenant]);
  // Une ligne par propriétaire dans CHAQUE table cloisonnée : un test d'isolement ne doit
  // jamais passer à vide (revue Spec).
  for (const p of [A, B]) {
    const [plan] = await sql<{ id: string }>(URL_ADMIN,
      "INSERT INTO app.plan (tenant_id, nom, prix_xof, uptime_limit_s) VALUES ($1, 'p', 100, 600) RETURNING id::text", [p.tenant]);
    await sql(URL_ADMIN, "SELECT app.voucher_creer($1, $2)", [p.tenant, plan.id]);
    await sql(URL_ADMIN, `INSERT INTO app.enrollment_token (tenant_id, site_id, empreinte, expire_le)
                          VALUES ($1, $2, gen_random_bytes(32), now() + interval '30 minutes')`, [p.tenant, p.site]);
  }
});

test("par l'API, chaque propriétaire ne voit que ses sites et ses routeurs", async () => {
  await avecApp(async (app) => {
    for (const [p, r, autre] of [[A, rA, B], [B, rB, A]] as const) {
      const sites = (await app.inject({ url: "/v1/sites", headers: entetes(p.tenant) })).json();
      assert.deepEqual(sites.map((s: { id: string }) => s.id), [p.site]);
      const routeurs = (await app.inject({ url: "/v1/routers", headers: entetes(p.tenant) })).json();
      assert.deepEqual(routeurs.map((x: { id: string }) => x.id), [r]);
      assert.ok(!JSON.stringify(routeurs).includes(`"site_id":"${autre.site}"`));
    }
  });
});

test("sans session, session inventée, ou ancien en-tête de développement : 401", async () => {
  await avecApp(async (app) => {
    for (const headers of [{}, { "x-wakatnet-tenant": A.tenant }, { cookie: `wk_session=${"A".repeat(43)}` },
                           { cookie: "wk_session=court" }, { cookie: `wk_session=${"A".repeat(43)}; x=1` }]) {
      assert.equal((await app.inject({ url: "/v1/sites", headers })).statusCode, 401, JSON.stringify(headers));
    }
  });
});

test("propriétaire suspendu : ses sessions sont refusées à la requête suivante (401)", async () => {
  const S = await proprietaire("suspendu");
  await sql(URL_ADMIN, "UPDATE app.tenant SET suspendu = true WHERE id = $1", [S.tenant]);
  await avecApp(async (app) => {
    assert.equal((await app.inject({ url: "/v1/sites", headers: entetes(S.tenant) })).statusCode, 401);
  });
});

const TABLES = ["site", "router", "audit_log", "enrollment_token"];

test("les six tables cloisonnées ont des lignes de A et de B (le test ne passe pas à vide)", async () => {
  for (const t of [...TABLES, "plan", "voucher"]) {
    const [{ n }] = await sql<{ n: number }>(URL_ADMIN, `SELECT count(DISTINCT tenant_id)::int AS n FROM app.${t} WHERE tenant_id IN ($1, $2)`,
                                             [A.tenant, B.tenant]);
    assert.equal(n, 2, `app.${t}`);
  }
});

test("wk_api sans contexte : zéro ligne sur chaque table cloisonnée, sans erreur", async () => {
  for (const t of TABLES) {
    const [{ n }] = await sql<{ n: string }>(URL_API, `SELECT count(*)::text AS n FROM app.${t}`);
    assert.equal(n, "0", `app.${t}`);
  }
});

test("wk_api ne lit jamais les tickets en direct (les codes valent accès) ; les forfaits, sous RLS seulement", async () => {
  await assert.rejects(sql(URL_API, "SELECT 1 FROM app.voucher"), /permission denied/);
  const [{ n }] = await sql<{ n: string }>(URL_API, "SELECT count(*)::text AS n FROM app.plan");
  assert.equal(n, "0", "forfaits : zéro ligne sans contexte (phase 4, gestion des forfaits)");
});

test("wk_api dans le contexte de A : rien de B, même en le demandant explicitement", async () => {
  const c = new pg.Client({ connectionString: URL_API });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('wakatnet.tenant_id', $1, true)", [A.tenant]);
    for (const t of TABLES) {
      const deB = await c.query(`SELECT count(*)::int AS n FROM app.${t} WHERE tenant_id = $1`, [B.tenant]);
      assert.equal(deB.rows[0].n, 0, `app.${t}`);
      const deA = await c.query(`SELECT count(*)::int AS n FROM app.${t} WHERE tenant_id = $1`, [A.tenant]);
      assert.ok(deA.rows[0].n >= 1, `app.${t} : A voit ses lignes`);
    }
    await c.query("COMMIT");
  } finally {
    await c.end();
  }
});

test("le contexte ne survit pas à la transaction sur la même connexion", async () => {
  const c = new pg.Client({ connectionString: URL_API });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('wakatnet.tenant_id', $1, true)", [A.tenant]);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM app.site")).rows[0].n, 1);
    await c.query("COMMIT");
    assert.equal((await c.query("SELECT count(*)::int AS n FROM app.site")).rows[0].n, 0);
  } finally {
    await c.end();
  }
});

test("wk_api ne peut pas écrire chez un autre propriétaire (WITH CHECK)", async () => {
  const c = new pg.Client({ connectionString: URL_API });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('wakatnet.tenant_id', $1, true)", [A.tenant]);
    await assert.rejects(
      c.query("INSERT INTO app.audit_log (tenant_id, acteur, action, objet) VALUES ($1, 'x', 'x', 'x')", [B.tenant]),
      /row-level security/);
    await c.query("ROLLBACK");
  } finally {
    await c.end();
  }
});

test("wk_api ne lit aucun secret et n'exécute aucune fonction radius", async () => {
  await assert.rejects(sql(URL_API, "SELECT secret FROM radius.router_secret"), /permission denied/);
  await assert.rejects(sql(URL_API, "SELECT * FROM radius.authorize('X', '10.213.1.10', '', '')"), /permission denied/);
  await assert.rejects(sql(URL_API, "SELECT * FROM radius.client_lookup('10.213.1.10')"), /permission denied/);
  // Seule la colonne actif est modifiable (révocation, ticket 06), et sous RLS.
  await assert.rejects(sql(URL_API, "UPDATE app.router SET shortname = 'x'"), /permission denied/);
  await assert.rejects(sql(URL_API, "DELETE FROM app.router"), /permission denied/);
  await assert.rejects(sql(URL_API, "SELECT nom FROM app.tenant"), /permission denied/);
});
