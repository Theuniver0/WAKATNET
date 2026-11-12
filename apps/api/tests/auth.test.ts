// Comptes, sessions, rôles, TOTP (ADR 0014 §1 à §3).
// Ticket : .scratch/phase-4-exploitation/issues/02-comptes-auth.md
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { base32Encoder, chiffrerTotp, hacher, hotp, totpPas, verifier } from "../src/auth.ts";
import { avecApp, CLES, config, empreinteTest, entetesJeton, MDP_TEST, proprietaire, session, sql, URL_ADMIN } from "./aide.ts";

type App = Parameters<Parameters<typeof avecApp>[0]>[0];
const CSRF = { "x-wakatnet-requete": "1" };
const adresse = () => `auth-${randomBytes(5).toString("hex")}@exemple.bf`;
const cookieDe = (r: { headers: Record<string, unknown> }) => String([r.headers["set-cookie"]].flat()[0] ?? "");
const jetonDe = (r: { headers: Record<string, unknown> }) => /wk_session=([A-Za-z0-9_-]{43})/.exec(cookieDe(r))?.[1] ?? "";

// Une source par inscription : la limite de 5 inscriptions par heure et par source (ADR 0019) ne gêne pas les tests.
const sourceAuHasard = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
const inscrireBrut = (app: App, email: string, mot_de_passe = "un-mot-de-passe-long") =>
  app.inject({ method: "POST", url: "/v1/inscription", headers: CSRF, remoteAddress: sourceAuHasard(), payload: { nom: "Zone test", email, mot_de_passe } });
/** Inscription, puis adresse confirmée (comme par le lien) : la connexion est alors permise. */
const inscrire = async (app: App, email: string, mot_de_passe = "un-mot-de-passe-long") => {
  const r = await inscrireBrut(app, email, mot_de_passe);
  await sql(URL_ADMIN, "UPDATE app.utilisateur SET email_verifie_le = now() WHERE email = lower($1)", [email]);
  return r;
};
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

test("inscription (ADR 0019) : aucune session ; même réponse adresse libre ou prise (F9) ; connexion refusée avant confirmation, même message", async () => {
  await avecApp(async (app) => {
    const email = adresse();
    const r = await inscrireBrut(app, email);
    assert.equal(r.statusCode, 202);
    assert.equal(r.headers["set-cookie"], undefined, "aucune session à l'inscription");
    const deja = await inscrireBrut(app, email.toUpperCase());
    assert.equal(deja.statusCode, 202);
    assert.equal(deja.body, r.body, "réponse identique : rien ne dit que l'adresse existe");
    const [{ n: comptes }] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.utilisateur WHERE email = lower($1)", [email]);
    assert.equal(comptes, 1);
    // Avant confirmation : refus, avec le message d'un mauvais mot de passe.
    const avant = await connecter(app, email, "un-mot-de-passe-long");
    assert.equal(avant.statusCode, 401);
    assert.equal(avant.body, (await connecter(app, adresse(), "un-mot-de-passe-long")).body);
    await sql(URL_ADMIN, "UPDATE app.utilisateur SET email_verifie_le = now() WHERE email = lower($1)", [email]);
    const ok = await connecter(app, email, "un-mot-de-passe-long");
    assert.equal(ok.statusCode, 200);
    const c = cookieDe(ok);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(c.includes(attr), attr);
    assert.equal((await app.inject({ url: "/v1/moi", headers: entetesJeton(jetonDe(ok)) })).json().role, "proprietaire");
    assert.equal((await inscrireBrut(app, adresse(), "court")).statusCode, 422);
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

test("revue de sécurité M2 : 20 connexions PARALLÈLES sur une adresse → 5 vérifiées au plus, les autres 429", async () => {
  await avecApp(async (app) => {
    const email = adresse();
    await inscrire(app, email);
    const r = await Promise.all(Array.from({ length: 20 }, () => connecter(app, email, "faux-mot-de-passe")));
    const codes = r.map((x) => x.statusCode).sort();
    assert.equal(codes.filter((c) => c === 401).length, 5, `401 attendus : 5 ; reçus ${JSON.stringify(codes)}`);
    assert.equal(codes.filter((c) => c === 429).length, 15);
    const [{ n }] = await sql<{ n: number }>(URL_ADMIN,
      "SELECT count(*)::int AS n FROM app.connexion_echec WHERE email = $1 AND le > now() - interval '15 minutes'", [email]);
    assert.equal(n, 5, "cinq essais inscrits, pas un de plus");
    assert.equal((await connecter(app, email, "un-mot-de-passe-long")).statusCode, 429, "même le bon mot de passe attend");
  });
});

test("revue de sécurité M2 : une connexion réussie ne compte pas comme un échec", async () => {
  await avecApp(async (app) => {
    const email = adresse();
    await inscrire(app, email);
    for (let i = 0; i < 8; i++) assert.equal((await connecter(app, email, "un-mot-de-passe-long")).statusCode, 200);
    const [{ n }] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.connexion_echec WHERE email = $1", [email]);
    assert.equal(n, 0);
  });
});

test("revue de sécurité E2 : TOTP, 5 essais en 15 min (même en parallèle), puis session fermée et événement audité", async () => {
  await avecApp(async (app) => {
    const email = adresse();
    const secret = randomBytes(20);
    await sql(URL_ADMIN, "SELECT app.super_admin_creer($1, $2, $3)", [email, await empreinteTest(), chiffrerTotp(CLES.marchands, email, secret)]);
    const h = entetesJeton(jetonDe(await connecter(app, email, MDP_TEST)));
    // Un code sûrement faux : ni le pas courant ni ses voisins.
    const pas = BigInt(Math.floor(Date.now() / 30000));
    const justes = new Set([pas - 1n, pas, pas + 1n].map((p) => hotp(secret, p)));
    let faux = 0;
    while (justes.has(String(faux).padStart(6, "0"))) faux++;
    const code = String(faux).padStart(6, "0");
    const r = await Promise.all(Array.from({ length: 12 }, () => app.inject({ method: "POST", url: "/v1/totp", headers: h, payload: { code } })));
    const codes = r.map((x) => x.statusCode);
    assert.equal(codes.filter((c) => c === 401).length, 5, `5 essais vérifiés au plus : ${JSON.stringify(codes)}`);
    assert.ok(codes.every((c) => c === 401 || c === 429 || c === 403), JSON.stringify(codes));
    // La session est fermée : même le bon code ne la valide plus.
    const bon = await app.inject({ method: "POST", url: "/v1/totp", headers: h, payload: { code: hotp(secret, pas) } });
    assert.ok(bon.statusCode === 401 || bon.statusCode === 403, String(bon.statusCode));
    assert.equal((await app.inject({ url: "/v1/moi", headers: h })).statusCode, 401, "session fermée");
    const [{ n }] = await sql<{ n: number }>(URL_ADMIN,
      "SELECT count(*)::int AS n FROM app.audit_log WHERE action = 'totp_trop_d_essais' AND objet IN (SELECT 'utilisateur:' || id FROM app.utilisateur WHERE email = $1)", [email]);
    assert.ok(n >= 1, "événement audité");
    // Nouvelle session : toujours bloquée pendant 15 min (le compte d'essais est par utilisateur).
    const h2 = entetesJeton(jetonDe(await connecter(app, email, MDP_TEST)));
    assert.equal((await app.inject({ method: "POST", url: "/v1/totp", headers: h2, payload: { code: hotp(secret, pas) } })).statusCode, 429);
  });
});

test("revue de sécurité M2 : le verrou compte par source ; plafond de 10 ; l'appareil connu passe une attaque distribuée", async () => {
  await avecApp(async (app) => {
    const email = adresse();
    await inscrire(app, email);
    const depuis = (ip: string, mdp: string, cookie?: string) => app.inject({ method: "POST", url: "/v1/connexion", remoteAddress: ip,
      headers: { ...CSRF, ...(cookie ? { cookie } : {}) }, payload: { email, mot_de_passe: mdp } });
    for (let i = 0; i < 5; i++) assert.equal((await depuis("198.51.100.9", "faux-mot-de-passe")).statusCode, 401);
    assert.equal((await depuis("198.51.100.9", "un-mot-de-passe-long")).statusCode, 429, "l'attaquant est bloqué");
    const ok = await depuis("203.0.113.7", "un-mot-de-passe-long");
    assert.equal(ok.statusCode, 200, "le titulaire, ailleurs, se connecte");
    // Deux cookies : la session, et l'appareil (limité à /v1/connexion).
    const cookies = ([] as string[]).concat(ok.headers["set-cookie"] as string[] | string);
    const appareil = cookies.find((c) => c.startsWith("wk_appareil="))!;
    assert.ok(cookies.some((c) => c.startsWith("wk_session=")));
    assert.match(appareil, /^wk_appareil=[A-Za-z0-9_-]{43}; Path=\/v1\/connexion; HttpOnly; Secure; SameSite=Strict; Max-Age=7776000$/);
    const cookieAppareil = appareil.split(";")[0];
    // Une IPv6 voisine (même /64) partage le budget de sa source.
    for (let i = 0; i < 5; i++) await depuis(`2001:db8:1:2::${i + 1}`, "faux-mot-de-passe");
    assert.equal((await depuis("2001:db8:1:2::ff", "un-mot-de-passe-long")).statusCode, 429);
    // Plafond global atteint (10 échecs de sources inconnues) : toute source inconnue attend, même avec le bon mot de passe…
    assert.equal((await depuis("192.0.2.1", "un-mot-de-passe-long")).statusCode, 429);
    // …mais l'appareil connu du titulaire passe, d'où qu'il vienne.
    assert.equal((await depuis("192.0.2.1", "un-mot-de-passe-long", cookieAppareil)).statusCode, 200);
    // Un appareil connu a lui aussi son budget de 5, et un cookie inventé ne vaut rien.
    for (let i = 0; i < 5; i++) assert.equal((await depuis("192.0.2.2", "faux-mot-de-passe", cookieAppareil)).statusCode, 401);
    assert.equal((await depuis("192.0.2.2", "un-mot-de-passe-long", cookieAppareil)).statusCode, 429);
    assert.equal((await depuis("192.0.2.3", "un-mot-de-passe-long", `wk_appareil=${"A".repeat(43)}`)).statusCode, 429);
    const [{ n }] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.appareil_connu WHERE email = $1", [email]);
    assert.equal(n, 1, "un seul appareil connu : le cookie présenté est gardé, pas remplacé");
    const sources = await sql<{ source: string }>(URL_ADMIN, "SELECT DISTINCT source FROM app.connexion_echec WHERE email = $1", [email]);
    assert.ok(sources.every((x) => !/198\.51|2001:db8|192\.0\.2/.test(x.source)), "aucune IP en clair en base");
  });
});

test("revue de sécurité M2 derrière nginx : la source est l'en-tête X-Forwarded-For du seul proxy de confiance", async () => {
  await avecApp(async (app) => {
    const email = adresse();
    await inscrire(app, email);
    const via = (xff: string, remoteAddress = "127.0.0.1") => app.inject({ method: "POST", url: "/v1/connexion", remoteAddress,
      headers: { ...CSRF, "x-forwarded-for": xff }, payload: { email, mot_de_passe: "faux-mot-de-passe" } });
    for (let i = 0; i < 5; i++) assert.equal((await via("198.51.100.9")).statusCode, 401);
    assert.equal((await via("198.51.100.9")).statusCode, 429);
    assert.equal((await via("203.0.113.7")).statusCode, 401, "autre client derrière le même proxy : autre budget");
    // Un en-tête forgé par un client qui ne passe pas par le proxy n'est pas cru.
    for (let i = 0; i < 5; i++) await via(`192.0.2.${i}`, "203.0.113.50");
    assert.equal((await via("192.0.2.99", "203.0.113.50")).statusCode, 429);
  }, config({ trustProxy: "127.0.0.1" }));
});
