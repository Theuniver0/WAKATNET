// Révocation (ticket 06) : effet en base immédiat ; jamais sur le routeur d'un autre.
// Le retrait du pair WireGuard est prouvé par apps/wg-agent (TestBoucleNotifyEtRevocation).
// Ticket : .scratch/phase-2-multi-proprietaires/issues/06-revocation.md
import assert from "node:assert/strict";
import { before, test } from "node:test";
import pg from "pg";
import { avecApp, proprietaire, routeur, sql, URL_ADMIN, URL_API, entetes } from "./aide.ts";

let A: { tenant: string; site: string };
let B: { tenant: string; site: string };

before(async () => {
  A = await proprietaire("révocation A");
  B = await proprietaire("révocation B");
});

const revoquer = (app: Parameters<Parameters<typeof avecApp>[0]>[0], id: string, tenant: string) =>
  app.inject({ method: "POST", url: `/v1/routers/${id}/revoke`, headers: entetes(tenant) });

test("révocation : actif = false, plus reconnu par client_lookup, audit, idempotente", async () => {
  const id = await routeur(A.tenant, A.site);
  const [{ ip }] = await sql<{ ip: string }>(URL_ADMIN, "SELECT host(overlay_ip) AS ip FROM app.router WHERE id = $1", [id]);
  await sql(URL_ADMIN, "INSERT INTO radius.router_secret (router_id, secret) VALUES ($1, repeat('s', 32))", [id]);
  assert.equal((await sql(URL_ADMIN, "SELECT * FROM radius.client_lookup($1)", [ip])).length, 1);
  await avecApp(async (app) => {
    for (let i = 0; i < 2; i++) {
      const r = await revoquer(app, id, A.tenant);
      assert.equal(r.statusCode, 200);
      assert.deepEqual(r.json(), { id, actif: false });
    }
  });
  assert.equal((await sql(URL_ADMIN, "SELECT * FROM radius.client_lookup($1)", [ip])).length, 0);
  const audit = await sql(URL_ADMIN, "SELECT 1 FROM app.audit_log WHERE action = 'routeur_revoque' AND objet = $1", [`router:${id}`]);
  assert.equal(audit.length, 1, "une seule entrée d'audit, même révoqué deux fois");
});

test("le routeur d'un autre propriétaire : 404, et il reste actif", async () => {
  const id = await routeur(B.tenant, B.site);
  await avecApp(async (app) => {
    assert.equal((await revoquer(app, id, A.tenant)).statusCode, 404);
    assert.equal((await revoquer(app, "abc", A.tenant)).statusCode, 404);
  });
  const [{ actif }] = await sql<{ actif: boolean }>(URL_ADMIN, "SELECT actif FROM app.router WHERE id = $1", [id]);
  assert.equal(actif, true);
});

test("en SQL direct, wk_api ne change que actif, et seulement chez lui", async () => {
  const idB = await routeur(B.tenant, B.site);
  const idA = await routeur(A.tenant, A.site);
  const c = new pg.Client({ connectionString: URL_API });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('wakatnet.tenant_id', $1, true)", [A.tenant]);
    const r = await c.query("UPDATE app.router SET actif = false WHERE id = $1", [idB]);
    assert.equal(r.rowCount, 0, "routeur de B invisible, donc intouchable");
    await assert.rejects(c.query("UPDATE app.router SET overlay_ip = '10.213.250.1' WHERE id = $1", [idA]), /permission denied/);
    await c.query("ROLLBACK");
  } finally {
    await c.end();
  }
});
