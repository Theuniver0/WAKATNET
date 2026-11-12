// Comptes, sessions, rôles, TOTP (ADR 0014 §1 à §3).
// Ticket : .scratch/phase-4-exploitation/issues/02-comptes-auth.md
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { base32Encoder, chiffrerTotp, hacher, hotp, totpPas, verifier } from "../src/auth.ts";
import { avecApp, CLES, empreinteTest, entetesJeton, MDP_TEST, proprietaire, session, sql, URL_ADMIN } from "./aide.ts";

type App = Parameters<Parameters<typeof avecApp>[0]>[0];
const CSRF = { "x-wakatnet-requete": "1" };
const adresse = () => `auth-${randomBytes(5).toString("hex")}@exemple.bf`;
const cookieDe = (r: { headers: Record<string, unknown> }) => String([r.headers["set-cookie"]].flat()[0] ?? "");
const jetonDe = (r: { headers: Record<string, unknown> }) => /wk_session=([A-Za-z0-9_-]{43})/.exec(cookieDe(r))?.[1] ?? "";

const inscrire = (app: App, email: string, mot_de_passe = "un-mot-de-passe-long") =>
  app.inject({ method: "POST", url: "/v1/inscription", headers: CSRF, payload: { nom: "Zone test", email, mot_de_passe } });
const connecter = (app: App, email: string, mot_de_passe: string) =>
  app.inject({ method: "POST", url: "/v1/connexion", headers: CSRF, payload: { email, mot_de_passe } });

test("scrypt : forme stockée, vérification, refus d'une empreinte altérée", async () => {
  const h = await hacher("correct horse battery");
  assert.match(h, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await verifier("correct horse battery", h), true);
  assert.equal(await verifier("correct horse batterY", h), false);
  assert.equal(await verifier("x", "pas-une-empreinte"), false);
  assert.notEqual(await hacher("même"), await hacher("même"), "sel aléatoire");
});

test("TOTP : vecteurs de la RFC 6238 (SHA-1) et tolérance d'un pas", () => {
  const s = Buffer.from("12345678901234567890");
  for (const [t, attendu] of [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
                              [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]] as const) {
    assert.equal(hotp(s, BigInt(Math.floor(t / 30)), 8), attendu, `T=${t}`);
  }
  const maintenant = 1_800_000_000_000;
  const code = hotp(s, BigInt(Math.floor(maintenant / 30000)) - 1n);
  assert.ok(totpPas(s, code, maintenant) !== null, "un pas de retard accepté");
  assert.equal(totpPas(s, hotp(s, BigInt(Math.floor(maintenant / 30000)) - 3n), maintenant), null);
  assert.equal(totpPas(s, "12345", maintenant), null);
});

test("inscription : cookie de session sûr ; adresse déjà prise 409 ; mot de passe court 422 ; sans en-tête anti-CSRF 403", async () => {
  await avecApp(async (app) => {
    const email = adresse();
    const r = await inscrire(app, email);
    assert.equal(r.statusCode, 201);
    const c = cookieDe(r);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(c.includes(attr), attr);
    const moi = await app.inject({ url: "/v1/moi", headers: entetesJeton(jetonDe(r)) });
    assert.equal(moi.json().role, "proprietaire");
    assert.equal((await inscrire(app, email.toUpperCase())).statusCode, 409);
    assert.equal((await inscrire(app, adresse(), "court")).statusCode, 422);
    const sans = await app.inject({ method: "POST", url: "/v1/inscription", payload: { nom: "x", email: adresse(), mot_de_passe: "un-mot-de-passe-long" } });
    assert.equal(sans.statusCode, 403);
    const [{ n }] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.utilisateur WHERE mot_de_passe LIKE '%un-mot-de-passe%'");
    assert.equal(n, 0, "jamais de mot de passe en clair");
  });
});

test("connexion : même réponse que le compte existe ou non ; 5 échecs → refus même avec le bon mot de passe", async () => {
  await avecApp(async (app) => {
    const email = adresse();
    await inscrire(app, email);
    const ok = await connecter(app, email, "un-mot-de-passe-long");
    assert.equal(ok.statusCode, 200);
    assert.ok(jetonDe(ok));
    const mauvais = await connecter(app, email, "faux-mot-de-passe");
    const inconnu = await connecter(app, adresse(), "faux-mot-de-passe");
    assert.equal(mauvais.statusCode, 401);
    assert.equal(mauvais.body, inconnu.body);
    for (let i = 0; i < 4; i++) await connecter(app, email, "faux-mot-de-passe");
    assert.equal((await connecter(app, email, "un-mot-de-passe-long")).statusCode, 429);
  });
});

test("déconnexion : la session ne vaut plus rien ; requête qui modifie sans en-tête anti-CSRF : 403", async () => {
  await avecApp(async (app) => {
    const P = await proprietaire("déconnexion");
    const { jeton } = await session(P.tenant, "proprietaire");
    assert.equal((await app.inject({ url: "/v1/sites", headers: entetesJeton(jeton) })).statusCode, 200);
    const sansCsrf = await app.inject({ method: "POST", url: `/v1/sites/${P.site}/enrollments`, headers: { cookie: `wk_session=${jeton}` } });
    assert.equal(sansCsrf.statusCode, 403);
    await app.inject({ method: "POST", url: "/v1/deconnexion", headers: entetesJeton(jeton) });
    assert.equal((await app.inject({ url: "/v1/sites", headers: entetesJeton(jeton) })).statusCode, 401);
    const [{ n }] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.session_utilisateur WHERE empreinte::text LIKE '%' || $1 || '%'", [jeton]);
    assert.equal(n, 0, "jeton jamais stocké en clair");
  });
});

test("rôles : gérant et vendeur refusés sur les routes du propriétaire ; super-admin aussi", async () => {
  await avecApp(async (app) => {
    const P = await proprietaire("rôles");
    const [pdv] = await sql<{ id: string }>(URL_ADMIN, "INSERT INTO app.point_of_sale (tenant_id, nom) VALUES ($1, 'Boutique') RETURNING id::text", [P.tenant]);
    for (const role of ["gerant", "vendeur"]) {
      const { jeton } = await session(P.tenant, role, pdv.id);
      assert.equal((await app.inject({ url: "/v1/routers", headers: entetesJeton(jeton) })).statusCode, 403, role);
    }
    const { jeton } = await session(null, "super_admin");
    assert.equal((await app.inject({ url: "/v1/routers", headers: entetesJeton(jeton) })).statusCode, 403);
  });
});

test("super-admin : TOTP obligatoire, un code ne sert qu'une fois", async () => {
  await avecApp(async (app) => {
    const email = adresse();
    const secret = randomBytes(20);
    await sql(URL_ADMIN, "SELECT app.super_admin_creer($1, $2, $3)", [email, await empreinteTest(), chiffrerTotp(CLES.marchands, email, secret)]);
    const c = await connecter(app, email, MDP_TEST);
    assert.equal(c.statusCode, 200);
    const h = entetesJeton(jetonDe(c));
    assert.equal((await app.inject({ url: "/v1/moi", headers: h })).json().totp_ok, false);
    assert.equal((await app.inject({ method: "POST", url: "/v1/totp", headers: h, payload: { code: "000000" } })).statusCode, 401);
    const code = hotp(secret, BigInt(Math.floor(Date.now() / 30000)));
    assert.equal((await app.inject({ method: "POST", url: "/v1/totp", headers: h, payload: { code } })).statusCode, 200);
    assert.equal((await app.inject({ url: "/v1/moi", headers: h })).json().totp_ok, true);
    // Rejeu du même code depuis une nouvelle session : refusé.
    const c2 = await connecter(app, email, MDP_TEST);
    const h2 = entetesJeton(jetonDe(c2));
    assert.equal((await app.inject({ method: "POST", url: "/v1/totp", headers: h2, payload: { code } })).statusCode, 401);
    assert.equal((await app.inject({ url: "/v1/moi", headers: h2 })).json().totp_ok, false);
    void base32Encoder;
  });
});
