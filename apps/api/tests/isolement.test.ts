// Cloisonnement (I1, I2 ; ADR 0012 §6) : A ne voit ni ne modifie B, par l'API ou en SQL direct.
// Ticket : .scratch/phase-2-multi-proprietaires/issues/02-socle-applicatif.md
import assert from "node:assert/strict";
import { before, test } from "node:test";
import pg from "pg";
import { avecApp, config, proprietaire, routeur, sql, URL_API, URL_ADMIN } from "./aide.ts";

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
});

test("par l'API, chaque propriétaire ne voit que ses sites et ses routeurs", async () => {
  await avecApp(async (app) => {
    for (const [p, r, autre] of [[A, rA, B], [B, rB, A]] as const) {
      const sites = (await app.inject({ url: "/v1/sites", headers: { "x-wakatnet-tenant": p.tenant } })).json();
      assert.deepEqual(sites.map((s: { id: string }) => s.id), [p.site]);
      const routeurs = (await app.inject({ url: "/v1/routers", headers: { "x-wakatnet-tenant": p.tenant } })).json();
      assert.deepEqual(routeurs.map((x: { id: string }) => x.id), [r]);
      assert.ok(!JSON.stringify(routeurs).includes(`"site_id":"${autre.site}"`));
    }
  });
});

test("sans identité, ou avec une identité invalide ou inconnue : 401", async () => {
  await avecApp(async (app) => {
    for (const headers of [{}, { "x-wakatnet-tenant": "0" }, { "x-wakatnet-tenant": "1 OR 1=1" },
                           { "x-wakatnet-tenant": "999999999" }]) {
      assert.equal((await app.inject({ url: "/v1/sites", headers })).statusCode, 401);
    }
  });
});

test("identité de développement désactivée : 401 même avec l'en-tête", async () => {
  await avecApp(async (app) => {
    const r = await app.inject({ url: "/v1/sites", headers: { "x-wakatnet-tenant": A.tenant } });
    assert.equal(r.statusCode, 401);
  }, config({ authDev: false }));
});

test("propriétaire suspendu : 403", async () => {
  const S = await proprietaire("suspendu");
  await sql(URL_ADMIN, "UPDATE app.tenant SET suspendu = true WHERE id = $1", [S.tenant]);
  await avecApp(async (app) => {
    assert.equal((await app.inject({ url: "/v1/sites", headers: { "x-wakatnet-tenant": S.tenant } })).statusCode, 403);
  });
});

const TABLES = ["site", "router", "plan", "voucher", "audit_log", "enrollment_token"];

test("wk_api sans contexte : zéro ligne sur chaque table cloisonnée, sans erreur", async () => {
  for (const t of TABLES) {
    const [{ n }] = await sql<{ n: string }>(URL_API, `SELECT count(*)::text AS n FROM app.${t}`);
    assert.equal(n, "0", `app.${t}`);
  }
});

test("wk_api dans le contexte de A : rien de B, même en le demandant explicitement", async () => {
  const c = new pg.Client({ connectionString: URL_API });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('wakatnet.tenant_id', $1, true)", [A.tenant]);
    for (const t of ["site", "router", "audit_log"]) {
      const r = await c.query(`SELECT count(*)::int AS n FROM app.${t} WHERE tenant_id = $1`, [B.tenant]);
      assert.equal(r.rows[0].n, 0, `app.${t}`);
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
  await assert.rejects(sql(URL_API, "UPDATE app.router SET actif = false"), /permission denied/);
  await assert.rejects(sql(URL_API, "SELECT nom FROM app.tenant"), /permission denied/);
});
