// Import Mikhmon (SPEC §6.3, ADR 0012 §10).
// Ticket : .scratch/phase-2-multi-proprietaires/issues/07-import-mikhmon.md
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { examiner, lireCsv } from "../src/import.ts";
import { avecApp, proprietaire, routeur, session, sql, URL_ADMIN, entetes, entetesJeton } from "./aide.ts";

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

test("réémission (migration 0050) : seuls les tickets importés JAMAIS utilisés ; remplaçants en lots ; anciens expirés, sans retour ; le premier activé gagne", async () => {
  await avecApp(async (app) => {
    const P = await proprietaire("réémission");
    const plan = await forfait(P.tenant);
    const planB = await forfait(B.tenant);
    await routeur(P.tenant, P.site);
    const [{ ip }] = await sql<{ ip: string }>(URL_ADMIN, "SELECT host(overlay_ip) AS ip FROM app.router WHERE tenant_id = $1 LIMIT 1", [P.tenant]);
    const decider = async (code: string) => (await sql<{ d: string; m: string | null }>(URL_ADMIN,
      "SELECT decision AS d, reply_message AS m FROM radius.authorize($1, $2, '02AABBCCDD01', '')", [code, ip]))[0];
    const [{ id: pdv }] = await sql<{ id: string }>(URL_ADMIN,
      "INSERT INTO app.point_of_sale (tenant_id, nom) VALUES ($1, 'Boutique') RETURNING id::text", [P.tenant]);
    const [{ id: pdvAutre }] = await sql<{ id: string }>(URL_ADMIN,
      "INSERT INTO app.point_of_sale (tenant_id, nom) VALUES ($1, 'Ailleurs') RETURNING id::text", [B.tenant]);
    const csv = ["name,password,profile", "1234,1234,1h", "567890,567890,1h", "K7Q2,K7Q2,1h", "AB12CD34EF,AB12CD34EF,1h"].join("\n");
    const corresp = { "1h": plan };
    assert.equal((await importer(app, P.tenant, { csv, correspondance: corresp })).statusCode, 200);
    assert.deepEqual(await decider("1234"), { d: "Accept", m: null }, "avant : l'ancien code est servi");
    // K7Q2 a déjà servi (activé) ; AB12CD34EF a une connexion acceptée : jamais réémis.
    await sql(URL_ADMIN, "UPDATE app.voucher SET activated_at = now() WHERE tenant_id = $1 AND code = 'K7Q2'", [P.tenant]);
    await sql(URL_ADMIN, `INSERT INTO radius.auth_log (router_id, tenant_id, mac, resultat, voucher_id)
                          SELECT NULL, tenant_id, '02AABBCCDDEE', 'Accept', id FROM app.voucher WHERE tenant_id = $1 AND code = 'AB12CD34EF'`, [P.tenant]);
    const lireEtat = async () => (await app.inject({ url: "/v1/imports/reemission", headers: entetes(P.tenant) })).json();
    assert.deepEqual((await lireEtat()).forfaits, [{ forfait_id: plan, forfait: "1 heure", tickets: 2, courts: 2 }]);
    // Propriétaire seulement ; point de vente et forfait d'un autre propriétaire : rien.
    const g = await session(P.tenant, "gerant", pdv);
    const reemettre = (h: Record<string, string>, corps: object) => app.inject({ method: "POST", url: "/v1/imports/reemission", headers: h, payload: corps });
    assert.equal((await reemettre(entetesJeton(g.jeton), { point_de_vente_id: pdv })).statusCode, 403);
    assert.equal((await reemettre(entetes(P.tenant), { point_de_vente_id: pdvAutre })).statusCode, 422, "point de vente d'un autre propriétaire");
    assert.equal((await reemettre(entetes(P.tenant), { point_de_vente_id: pdv, forfait_id: planB })).statusCode, 409, "forfait d'un autre propriétaire");
    const r = await reemettre(entetes(P.tenant), { point_de_vente_id: pdv });
    assert.equal(r.statusCode, 201, r.body);
    const corps = r.json();
    assert.equal(corps.tickets, 2);
    assert.equal(corps.lots.length, 1);
    // Remplaçants : un lot ordinaire, imprimable, codes de la plateforme, copie figée de l'ancien (200 F), servis.
    const t = (await app.inject({ url: `/v1/lots/${corps.lots[0].id}/tickets`, headers: entetes(P.tenant) })).json() as { code: string }[];
    assert.equal(t.length, 2);
    for (const x of t) {
      assert.match(x.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
      assert.deepEqual(await decider(x.code), { d: "Accept", m: null }, "remplaçant servi");
    }
    const prix = await sql<{ p: string }>(URL_ADMIN, "SELECT f_prix_xof::text AS p FROM app.voucher WHERE batch_id = $1", [corps.lots[0].id]);
    assert.deepEqual(prix.map((x) => x.p), ["200", "200"]);
    assert.equal((await app.inject({ url: `/v1/lots/${corps.lots[0].id}/tickets.pdf`, headers: entetes(P.tenant) })).statusCode, 200);
    // Anciens : code gardé, expiré, lié à son remplaçant ; saisi, il répond « expiré » (hors budget anti-devinette).
    assert.deepEqual(await decider("1234"), { d: "Reject", m: "expire" });
    const anciens = await sql<{ code: string; lie: boolean; expire: boolean }>(URL_ADMIN,
      `SELECT code, reemis_par IS NOT NULL AS lie, expires_at <= now() AS expire FROM app.voucher
        WHERE tenant_id = $1 AND origine = 'import' ORDER BY code`, [P.tenant]);
    assert.deepEqual(anciens, [
      { code: "1234", lie: true, expire: true }, { code: "567890", lie: true, expire: true },
      { code: "AB12CD34EF", lie: false, expire: null }, { code: "K7Q2", lie: false, expire: null }]);
    // Réimport du même export Mikhmon : les anciens codes restent des doublons, ils ne revivent pas.
    const re = (await importer(app, P.tenant, { csv, correspondance: corresp })).json();
    assert.equal(re.importes, 0);
    assert.deepEqual(await decider("1234"), { d: "Reject", m: "expire" }, "toujours expiré après un réimport");
    // Rien à refaire ; journalisé une fois, avec les lots.
    assert.deepEqual((await lireEtat()).forfaits, []);
    assert.equal((await reemettre(entetes(P.tenant), { point_de_vente_id: pdv })).statusCode, 409);
    const [{ a }] = await sql<{ a: number }>(URL_ADMIN,
      "SELECT count(*)::int AS a FROM app.audit_log WHERE tenant_id = $1 AND action = 'import_reemis' AND details ? 'lots'", [P.tenant]);
    assert.equal(a, 1);
    // Le premier activé gagne : un ancien ticket activé quand même (connexion pendant la réémission, accounting par code)
    // expire son remplaçant inutilisé, une seule fois.
    await sql(URL_ADMIN, "UPDATE app.voucher SET activated_at = now() WHERE tenant_id = $1 AND code = '1234'", [P.tenant]);
    const [{ n }] = await sql<{ n: number }>(URL_ADMIN, "SELECT app.reemission_reconcilier() AS n");
    assert.ok(n >= 1);
    const [{ remplacant }] = await sql<{ remplacant: string }>(URL_ADMIN,
      "SELECT n.code AS remplacant FROM app.voucher o JOIN app.voucher n ON n.id = o.reemis_par WHERE o.tenant_id = $1 AND o.code = '1234'", [P.tenant]);
    assert.deepEqual(await decider(remplacant), { d: "Reject", m: "expire" }, "remplaçant expiré : la valeur ne sert qu'une fois");
    const [{ c }] = await sql<{ c: number }>(URL_ADMIN,
      "SELECT count(*)::int AS c FROM app.audit_log WHERE tenant_id = $1 AND action = 'reemission_conflit'", [P.tenant]);
    assert.equal(c, 1);
    await sql(URL_ADMIN, "SELECT app.reemission_reconcilier()");
    const [{ c2 }] = await sql<{ c2: number }>(URL_ADMIN,
      "SELECT count(*)::int AS c2 FROM app.audit_log WHERE tenant_id = $1 AND action = 'reemission_conflit'", [P.tenant]);
    assert.equal(c2, 1, "une seule fois");
  });
});
