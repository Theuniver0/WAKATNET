// Enrôlement (SPEC §6.2, ADR 0012 §2 à §4).
// Ticket : .scratch/phase-2-multi-proprietaires/issues/03-api-enrolement.md
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { before, test } from "node:test";
import { construire } from "../src/app.ts";
import { ouvrirBase } from "../src/base.ts";
import { avecApp, config, proprietaire, routeur, sql, URL_ADMIN } from "./aide.ts";

let A: { tenant: string; site: string };
let B: { tenant: string; site: string };

before(async () => {
  A = await proprietaire("enrôlement A");
  B = await proprietaire("enrôlement B");
});

let n = 0;
/** Clé publique WireGuard de forme valide, unique par appel. */
function nouvelleCle(): string {
  n++;
  return createHash("sha256").update(`cle ${process.pid} ${n}`).digest("base64");
}

function inscription(surcharge: Record<string, unknown> = {}) {
  return {
    cle: nouvelleCle(), identity: 'Zone "Wend-Panga" $1', modele: "hAP ax2", version: "7.15.3 (stable)",
    listen_port: 13231, coa_port: 3799, coa_accept: false,
    hotspots: [{ serveur: "hotspot1", profil: "hsprof1", use_radius: false, html_directory: "hotspot",
                 radius_accounting: true, radius_interim_update: "received", adresse: "10.5.50.1", dns: "Login.Wifi" }],
    ...surcharge,
  };
}

type App = Parameters<Parameters<typeof avecApp>[0]>[0];

async function nouveauJeton(app: App, p = A): Promise<string> {
  const r = await app.inject({ method: "POST", url: `/v1/sites/${p.site}/enrollments`, headers: { "x-wakatnet-tenant": p.tenant } });
  assert.equal(r.statusCode, 201, r.body);
  const m = /\/enroll\/([A-Za-z0-9_-]{43})"/.exec(r.json().commande);
  assert.ok(m, r.json().commande);
  return m[1];
}

const poster = (app: App, jeton: string, corps: unknown) =>
  app.inject({ method: "POST", url: `/enroll/${jeton}`, payload: corps as object });

test("commande : 201 pour son site, valable 30 min ; 404 pour le site d'un autre ou inconnu", async () => {
  await avecApp(async (app) => {
    const r = await app.inject({ method: "POST", url: `/v1/sites/${A.site}/enrollments`, headers: { "x-wakatnet-tenant": A.tenant } });
    assert.equal(r.statusCode, 201);
    const { commande, expire_le } = r.json();
    assert.match(commande, /^\/tool fetch url="https:\/\/api\.test\.invalid\/enroll\/[A-Za-z0-9_-]{43}" check-certificate=yes dst-path="wakatnet-enroll\.rsc"\n\/import file-name="wakatnet-enroll\.rsc"$/);
    const duree = new Date(expire_le).getTime() - Date.now();
    assert.ok(duree > 29 * 60_000 && duree <= 30 * 60_000, `${duree}`);
    for (const site of [B.site, "999999999", "abc"]) {
      const x = await app.inject({ method: "POST", url: `/v1/sites/${site}/enrollments`, headers: { "x-wakatnet-tenant": A.tenant } });
      assert.equal(x.statusCode, 404, site);
    }
  });
});

test("le jeton n'est stocké que sous forme d'empreinte SHA-256", async () => {
  await avecApp(async (app) => {
    const jeton = await nouveauJeton(app);
    const lignes = await sql<{ e: Buffer; t: string }>(URL_ADMIN, "SELECT empreinte AS e, t::text AS t FROM app.enrollment_token t");
    assert.ok(lignes.some((l) => l.e.equals(createHash("sha256").update(jeton).digest())));
    assert.ok(lignes.every((l) => !l.t.includes(jeton)));
  });
});

test("étape 1 : GET rend le script sans consommer ; jeton invalide ou inconnu : même 404", async () => {
  await avecApp(async (app) => {
    const jeton = await nouveauJeton(app);
    for (let i = 0; i < 2; i++) {
      const r = await app.inject({ url: `/enroll/${jeton}` });
      assert.equal(r.statusCode, 200);
      assert.match(r.headers["content-type"] as string, /^text\/plain/);
      assert.ok(r.body.includes(`/enroll/${jeton}"`));
    }
    const inconnu = await app.inject({ url: `/enroll/${"x".repeat(43)}` });
    const mal = await app.inject({ url: "/enroll/court" });
    assert.equal(inconnu.statusCode, 404);
    assert.equal(mal.statusCode, 404);
    assert.equal(inconnu.body, mal.body);
  });
});

test("étape 2 : routeur créé, secret créé, reconnu par client_lookup, jeton consommé, audit", async () => {
  await avecApp(async (app) => {
    const jeton = await nouveauJeton(app);
    const corps = inscription();
    const r = await poster(app, jeton, corps);
    assert.equal(r.statusCode, 200, r.body);
    const [rt] = await sql<{ id: string; ip: string; tenant: string; site: string; coa: number; inv: { identity: string } }>(URL_ADMIN,
      `SELECT id::text, host(overlay_ip) AS ip, tenant_id::text AS tenant, site_id::text AS site, coa_port AS coa, inventaire AS inv
         FROM app.router WHERE wg_public_key = $1`, [corps.cle]);
    assert.equal(rt.tenant, A.tenant);
    assert.equal(rt.site, A.site);
    assert.equal(rt.coa, 3799);
    assert.equal(rt.inv.identity, corps.identity);
    const [{ h }] = await sql<{ h: string[] }>(URL_ADMIN, "SELECT hotspot_hotes AS h FROM app.site WHERE id = $1", [A.site]);
    assert.ok(h.includes("10.5.50.1") && h.includes("login.wifi"), `hôtes du hotspot relevés : ${h}`);
    const [o1, o2, o3, o4] = rt.ip.split(".").map(Number);
    assert.deepEqual([o1, o2], [10, 213]);
    assert.ok(o3 >= 1 && o3 <= 254 && o4 >= 1 && o4 <= 254, rt.ip);
    const [cl] = await sql<{ secret: string }>(URL_ADMIN, "SELECT secret FROM radius.client_lookup($1)", [rt.ip]);
    assert.match(cl.secret, /^[A-Za-z0-9]{32}$/);
    assert.ok(r.body.includes(`secret="${cl.secret}"`));
    assert.ok(r.body.includes(`address=${rt.ip}/32`));
    const [jt] = await sql<{ consomme: boolean; routeur: string }>(URL_ADMIN,
      "SELECT consomme_le IS NOT NULL AS consomme, router_id::text AS routeur FROM app.enrollment_token WHERE empreinte = $1",
      [createHash("sha256").update(jeton).digest()]);
    assert.deepEqual(jt, { consomme: true, routeur: rt.id });
    const audit = await sql<{ d: Record<string, string> }>(URL_ADMIN,
      "SELECT details AS d FROM app.audit_log WHERE action = 'routeur_enrole' AND objet = $1", [`router:${rt.id}`]);
    assert.equal(audit.length, 1);
    assert.ok(!JSON.stringify(audit).includes(cl.secret));
    // Consommé : GET et POST ne rendent plus rien.
    assert.equal((await app.inject({ url: `/enroll/${jeton}` })).statusCode, 404);
    assert.equal((await poster(app, jeton, inscription())).statusCode, 404);
  });
});

test("corps invalide : 422 et jeton NON consommé", async () => {
  await avecApp(async (app) => {
    const jeton = await nouveauJeton(app);
    const mauvais = [
      inscription({ cle: "A".repeat(44) }),
      inscription({ version: "7.14.3 (stable)" }),
      inscription({ version: "6.49.18 (long-term)" }),
      inscription({ hotspots: [] }),
      inscription({ hotspots: [{ serveur: "h", profil: "p", use_radius: true, html_directory: "hotspot" }] }),
      inscription({ identity: "a\nb" }),
      inscription({ coa_port: 70000 }),
      "pas du json",
    ];
    for (const corps of mauvais) {
      const r = await poster(app, jeton, corps);
      // Un corps texte (envoyé en text/plain) est refusé par Fastify (415) ; tout le reste : 422.
      assert.equal(r.statusCode, corps === "pas du json" ? 415 : 422, `${JSON.stringify(corps)} → ${r.statusCode}`);
    }
    assert.equal((await app.inject({ url: `/enroll/${jeton}` })).statusCode, 200);
    assert.equal((await poster(app, jeton, inscription())).statusCode, 200);
  });
});

test("deux POST concurrents sur le même jeton : un seul routeur", async () => {
  await avecApp(async (app) => {
    const jeton = await nouveauJeton(app);
    const avant = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.router");
    const r = await Promise.all(Array.from({ length: 6 }, () => poster(app, jeton, inscription())));
    assert.deepEqual(r.map((x) => x.statusCode).sort(), [200, 404, 404, 404, 404, 404]);
    const apres = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.router");
    assert.equal(apres[0].n, avant[0].n + 1);
  });
});

test("jeton expiré : 404 au GET et au POST", async () => {
  await avecApp(async (app) => {
    const jeton = await nouveauJeton(app);
    await sql(URL_ADMIN, `UPDATE app.enrollment_token SET cree_le = now() - interval '31 minutes',
                          expire_le = now() - interval '1 minute' WHERE empreinte = $1`,
              [createHash("sha256").update(jeton).digest()]);
    const inconnu = (await app.inject({ url: `/enroll/${"x".repeat(43)}` })).body;
    for (const r of [await app.inject({ url: `/enroll/${jeton}` }), await poster(app, jeton, inscription())]) {
      assert.equal(r.statusCode, 404);
      assert.equal(r.body, inconnu, "expiré : même corps qu'un jeton inconnu");
    }
  });
});

test("clé déjà enrôlée : 409, jeton intact", async () => {
  await avecApp(async (app) => {
    const corps = inscription();
    assert.equal((await poster(app, await nouveauJeton(app), corps)).statusCode, 200);
    const jeton = await nouveauJeton(app);
    assert.equal((await poster(app, jeton, { ...corps })).statusCode, 409);
    assert.equal((await app.inject({ url: `/enroll/${jeton}` })).statusCode, 200);
  });
});

test("aucun nœud configuré : 503, jeton intact", async () => {
  await avecApp(async (app) => {
    const jeton = await nouveauJeton(app);
    const sans = construire(config({ noeuds: [] }), ouvrirBase(config().urlBase), { journal: false });
    try {
      assert.equal((await poster(sans, jeton, inscription())).statusCode, 503);
    } finally {
      await sans.close();
    }
    assert.equal((await app.inject({ url: `/enroll/${jeton}` })).statusCode, 200);
  });
});

test("adressage : jamais .0 ni .255, jamais une plage réservée, jamais de réemploi", async () => {
  // Remplit tout 10.213.1.0/24 (adresses libres restantes), puis 10.213.2.1 doit venir ensuite.
  await sql(URL_ADMIN, `
    INSERT INTO app.router (tenant_id, site_id, overlay_ip, shortname, actif)
    SELECT $1, $2, ('10.213.1.' || h)::inet, 'plein-' || h, false
      FROM generate_series(1, 254) h
     WHERE NOT EXISTS (SELECT 1 FROM app.router r WHERE r.overlay_ip = ('10.213.1.' || h)::inet)`, [B.tenant, B.site]);
  await avecApp(async (app) => {
    const ips: string[] = [];
    for (let i = 0; i < 2; i++) {
      const corps = inscription();
      assert.equal((await poster(app, await nouveauJeton(app), corps)).statusCode, 200);
      const [r] = await sql<{ ip: string }>(URL_ADMIN, "SELECT host(overlay_ip) AS ip FROM app.router WHERE wg_public_key = $1", [corps.cle]);
      ips.push(r.ip);
    }
    assert.ok(ips.every((ip) => ip.startsWith("10.213.2.")), ips.join());
    // Les routeurs 10.213.1.x sont tous inactifs (révoqués) : leurs adresses ne sont pas réemployées.
    assert.ok(ips.every((ip) => !ip.endsWith(".0") && !ip.endsWith(".255")));
  });
});

test("journal : le jeton n'apparaît jamais, le secret non plus", async () => {
  let journal = "";
  const flux = new Writable({ write(morceau, _enc, suite) { journal += morceau.toString(); suite(); } });
  const base = ouvrirBase(config().urlBase);
  const app = construire(config(), base, { flux });
  try {
    const jeton = await nouveauJeton(app);
    await app.inject({ url: `/enroll/${jeton}` });
    const r = await poster(app, jeton, inscription());
    assert.equal(r.statusCode, 200);
    const secret = /secret="([A-Za-z0-9]{32})"/.exec(r.body)![1];
    assert.ok(journal.includes("/enroll/***"), "la requête est bien journalisée, chemin masqué");
    assert.ok(!journal.includes(jeton), "jeton dans le journal");
    assert.ok(!journal.includes(secret), "secret dans le journal");
  } finally {
    await app.close();
    await base.$disconnect();
  }
});

test("désinstallation : propre au routeur, valeurs d'origine ; 404 chez un autre ; 409 sans inventaire", async () => {
  await avecApp(async (app) => {
    const corps = inscription({ coa_accept: true, hotspots: [{ serveur: "hs", profil: "prof \"x\"", use_radius: false,
      html_directory: "hotspot", radius_accounting: false, radius_interim_update: "5m" }] });
    assert.equal((await poster(app, await nouveauJeton(app), corps)).statusCode, 200);
    const [r] = await sql<{ id: string }>(URL_ADMIN, "SELECT id::text FROM app.router WHERE wg_public_key = $1", [corps.cle]);
    const ok = await app.inject({ url: `/v1/routers/${r.id}/uninstall.rsc`, headers: { "x-wakatnet-tenant": A.tenant } });
    assert.equal(ok.statusCode, 200);
    assert.ok(ok.body.includes('/ip hotspot profile set [find where name="prof \\"x\\""] use-radius=no radius-accounting=no radius-interim-update=5m'));
    assert.ok(ok.body.includes("/radius incoming set accept=yes"));
    assert.equal((await app.inject({ url: `/v1/routers/${r.id}/uninstall.rsc`, headers: { "x-wakatnet-tenant": B.tenant } })).statusCode, 404);
    const manuel = await routeur(B.tenant, B.site);
    assert.equal((await app.inject({ url: `/v1/routers/${manuel}/uninstall.rsc`, headers: { "x-wakatnet-tenant": B.tenant } })).statusCode, 409);
  });
});
