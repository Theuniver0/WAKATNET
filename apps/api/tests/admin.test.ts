// Super-admin (ADR 0014 §3, §4). Ticket : .scratch/phase-4-exploitation/issues/06-super-admin.md
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { avecApp, entetes, entetesJeton, proprietaire, session, sql, URL_ADMIN } from "./aide.ts";
import { credits } from "./aide-paiement.ts";

async function admin(totp: boolean): Promise<Record<string, string>> {
  const s = await session(null, "super_admin");
  if (totp) await sql(URL_ADMIN, "UPDATE app.session_utilisateur SET totp_ok = true WHERE empreinte = $1", [createHash("sha256").update(s.jeton).digest()]);
  return entetesJeton(s.jeton);
}

test("routes /admin : refusées au propriétaire, et au super-admin tant que son TOTP n'est pas validé", async () => {
  await avecApp(async (app) => {
    const P = await proprietaire("admin refus");
    assert.equal((await app.inject({ url: "/admin/v1/proprietaires", headers: entetes(P.tenant) })).statusCode, 403);
    assert.equal((await app.inject({ url: "/admin/v1/proprietaires", headers: await admin(false) })).statusCode, 403);
    assert.equal((await app.inject({ url: "/admin/v1/proprietaires" })).statusCode, 401);
    assert.equal((await app.inject({ url: "/admin/v1/proprietaires", headers: await admin(true) })).statusCode, 200);
  });
});

test("rechargement idempotent sur sa référence ; autre montant sur la même référence : 409 ; audité avec l'auteur", async () => {
  await avecApp(async (app) => {
    const P = await proprietaire("admin recharge");
    const h = await admin(true);
    const ref = `RECU-${P.tenant}`;
    for (let i = 0; i < 2; i++) {
      assert.equal((await app.inject({ method: "POST", url: `/admin/v1/proprietaires/${P.tenant}/recharges`, headers: h,
        payload: { montant_xof: 2500, reference: ref } })).statusCode, 201);
    }
    assert.equal(await credits(P.tenant), 2500n);
    assert.equal((await app.inject({ method: "POST", url: `/admin/v1/proprietaires/${P.tenant}/recharges`, headers: h,
      payload: { montant_xof: 9000, reference: ref } })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: "/admin/v1/proprietaires/999999999/recharges", headers: h,
      payload: { montant_xof: 1, reference: "X1" } })).statusCode, 404);
    const a = await sql<{ acteur: string }>(URL_ADMIN, "SELECT acteur FROM app.audit_log WHERE action = 'admin_recharge' AND objet = $1", [`recharge:${ref}`]);
    assert.equal(a.length, 1);
    assert.match(a[0].acteur, /^utilisateur:\d+$/);
    const l = (await app.inject({ url: "/admin/v1/proprietaires", headers: h })).json() as { id: string; solde_credits_xof: number }[];
    assert.equal(l.find((x) => x.id === P.tenant)!.solde_credits_xof, 2500);
  });
});

test("suspension par le super-admin : les sessions du propriétaire tombent ; réglages audités", async () => {
  await avecApp(async (app) => {
    const P = await proprietaire("admin suspension");
    const h = await admin(true);
    assert.equal((await app.inject({ url: "/v1/sites", headers: entetes(P.tenant) })).statusCode, 200);
    assert.equal((await app.inject({ method: "PUT", url: `/admin/v1/proprietaires/${P.tenant}`, headers: h,
      payload: { suspendu: true, commission_bps: 800, plafond_decouvert_xof: 5000 } })).statusCode, 200);
    assert.equal((await app.inject({ url: "/v1/sites", headers: entetes(P.tenant) })).statusCode, 401);
    const [t] = await sql<{ c: number; p: string }>(URL_ADMIN, "SELECT commission_bps AS c, plafond_decouvert::text AS p FROM app.tenant WHERE id = $1", [P.tenant]);
    assert.deepEqual(t, { c: 800, p: "5000" });
    assert.equal((await app.inject({ method: "PUT", url: `/admin/v1/proprietaires/${P.tenant}`, headers: h, payload: { commission_bps: 20000 } })).statusCode, 422);
    const a = await sql(URL_ADMIN, "SELECT 1 FROM app.audit_log WHERE action = 'admin_reglage' AND tenant_id = $1", [P.tenant]);
    assert.equal(a.length, 1);
  });
});
