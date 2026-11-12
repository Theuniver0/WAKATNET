// Import Mikhmon (SPEC §6.3, ADR 0012 §10).
// Ticket : .scratch/phase-2-multi-proprietaires/issues/07-import-mikhmon.md
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { examiner, lireCsv } from "../src/import.ts";
import { avecApp, proprietaire, routeur, sql, URL_ADMIN, entetes } from "./aide.ts";

let A: { tenant: string; site: string };
let B: { tenant: string; site: string };
let planA: string;
let planB: string;

async function forfait(tenant: string): Promise<string> {
  const [p] = await sql<{ id: string }>(URL_ADMIN,
    "INSERT INTO app.plan (tenant_id, nom, prix_xof, uptime_limit_s) VALUES ($1, '1 heure', 200, 3600) RETURNING id::text", [tenant]);
  return p.id;
}

before(async () => {
  A = await proprietaire("import A");
  B = await proprietaire("import B");
  planA = await forfait(A.tenant);
  planB = await forfait(B.tenant);
});

const CSV = [
  'name,password,profile,limit-uptime,comment',
  'ab3k9,ab3k9,1h,1h,"vendu, lot 3"',      // importé (minuscules → majuscules)
  'X0O1IL7Q,x0o1il7q,1h,,',                // importé : symboles ambigus admis pour un ticket déjà imprimé
  'user1,secret,1h,,',                     // refusé : identifiant ≠ mot de passe
  'ab-12,ab-12,1h,,',                      // refusé : caractère hors [0-9A-Za-z]
  'abc,abc,1h,,',                          // refusé : trop court
  'zz99zz,zz99zz,inconnu,,',               // refusé : profil sans correspondance
  'AB3K9,AB3K9,1h,,',                      // doublon dans le même fichier
].join("\r\n");

const importer = (app: Parameters<Parameters<typeof avecApp>[0]>[0], tenant: string, corps: object) =>
  app.inject({ method: "POST", url: "/v1/imports/mikhmon", headers: entetes(tenant), payload: corps });

test("CSV : guillemets, séparateur ; ou virgule, BOM, lignes vides", () => {
  assert.deepEqual(lireCsv('﻿name;password\r\n"a;""b";c\r\n\r\n'), [["name", "password"], ['a;"b', "c"]]);
  assert.deepEqual(lireCsv("name,password\na,b"), [["name", "password"], ["a", "b"]]);
  assert.throws(() => lireCsv('name\n"ouvert'));
});

test("examiner : motifs de refus", () => {
  const c = new Map([["p", 1n]]);
  assert.deepEqual(examiner(" ab3k9 ", "AB3K9", "p", c), { code: "AB3K9", plan: 1n });
  assert.ok("motif" in examiner("ab3k9", "autre", "p", c));
  assert.ok("motif" in examiner("é1234", "é1234", "p", c));
  assert.ok("motif" in examiner("a".repeat(33), "a".repeat(33), "p", c));
  assert.ok("motif" in examiner("ab3k9", "ab3k9", "q", c));
});

test("import : rapport ligne par ligne, rejeu sans doublon, ticket importé authentifié", async () => {
  await avecApp(async (app) => {
    const r = await importer(app, A.tenant, { csv: CSV, correspondance: { "1h": planA } });
    assert.equal(r.statusCode, 200, r.body);
    const x = r.json();
    assert.deepEqual([x.importes, x.doublons, x.refuses, x.courts], [2, 1, 4, 1]);
    assert.deepEqual(x.lignes.map((l: { statut: string }) => l.statut),
      ["importe", "importe", "refuse", "refuse", "refuse", "refuse", "doublon"]);
    const encore = (await importer(app, A.tenant, { csv: CSV, correspondance: { "1h": planA } })).json();
    assert.deepEqual([encore.importes, encore.doublons], [0, 3]);
  });
  const [n] = await sql<{ n: number }>(URL_ADMIN,
    "SELECT count(*)::int AS n FROM app.voucher WHERE tenant_id = $1 AND origine = 'import'", [A.tenant]);
  assert.equal(n.n, 2);
  // Copie figée du forfait, et authentification par radius.authorize, saisie en minuscules (PAP).
  const id = await routeur(A.tenant, A.site);
  await sql(URL_ADMIN, "INSERT INTO radius.router_secret (router_id, secret) VALUES ($1, repeat('s', 32))", [id]);
  const [{ ip }] = await sql<{ ip: string }>(URL_ADMIN, "SELECT host(overlay_ip) AS ip FROM app.router WHERE id = $1", [id]);
  const [d] = await sql<{ decision: string; cleartext_password: string; session_timeout: string }>(URL_ADMIN,
    "SELECT decision, cleartext_password, session_timeout::text FROM radius.authorize('ab3k9', $1, '', '')", [ip]);
  assert.deepEqual(d, { decision: "Accept", cleartext_password: "AB3K9", session_timeout: "3600" });
});

test("cloisonnement : le forfait d'un autre propriétaire est refusé, rien n'est créé chez lui", async () => {
  await avecApp(async (app) => {
    const x = (await importer(app, A.tenant, { csv: "name,password,profile\nqq77qq,qq77qq,p", correspondance: { p: planB } })).json();
    assert.deepEqual([x.importes, x.refuses], [0, 1]);
    assert.equal(x.lignes[0].motif, "forfait inconnu");
  });
  const [n] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.voucher WHERE code = 'QQ77QQ'");
  assert.equal(n.n, 0);
});

test("corps invalides : 422, rien n'est importé", async () => {
  await avecApp(async (app) => {
    for (const corps of [{}, { csv: CSV }, { csv: CSV, correspondance: { "1h": "abc" } },
                         { csv: CSV, correspondance: { "1h": "9999999999999999999" } }, { csv: "name\n", correspondance: {} },
                         { csv: "nom,mdp\nx,y", correspondance: {} }, { csv: 'name,password,profile\n"x', correspondance: {} }]) {
      assert.equal((await importer(app, A.tenant, corps)).statusCode, 422, JSON.stringify(corps));
    }
  });
});

test("en base : un ticket de la plateforme garde l'alphabet de 31 symboles", async () => {
  await assert.rejects(sql(URL_ADMIN,
    `INSERT INTO app.voucher (tenant_id, plan_id, code, f_prix_xof, f_uptime_limit_s, f_devices, f_scope)
     VALUES ($1, $2, 'AB0O1IL7', 200, 3600, 1, 'tenant')`, [A.tenant, planA]), /voucher_code_forme/);
});

test("20 000 lignes (le maximum) : un seul appel SQL, dans les délais ; 20 001 : 422", async () => {
  const C = await proprietaire("import volumineux");
  const plan = await forfait(C.tenant);
  const lignes = ["name,password,profile"];
  for (let i = 0; i < 20_000; i++) { const c = `V${i.toString(36).toUpperCase().padStart(6, "0")}`; lignes.push(`${c},${c},p`); }
  await avecApp(async (app) => {
    const debut = Date.now();
    const r = await importer(app, C.tenant, { csv: lignes.join("\n"), correspondance: { p: plan } });
    assert.equal(r.statusCode, 200, r.body.slice(0, 200));
    assert.equal(r.json().importes, 20_000);
    console.log(`# 20 000 tickets importés en ${Date.now() - debut} ms`);
    lignes.push("ZZZZZZZ,ZZZZZZZ,p");
    assert.equal((await importer(app, C.tenant, { csv: lignes.join("\n"), correspondance: { p: plan } })).statusCode, 422);
  });
});
