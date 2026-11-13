// Comptes, sessions, rôles, TOTP (ADR 0014 §1 à §3).
// Ticket : .scratch/phase-4-exploitation/issues/02-comptes-auth.md
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { test } from "node:test";
import pg from "pg";
import { construire } from "../src/app.ts";
import { base32Encoder, chiffrerTotp, envoisEnCours, hacher, hotp, totpPas, verifier } from "../src/auth.ts";
import { enTantQue, ouvrirBase } from "../src/base.ts";
import { ExpediteurMemoire } from "../src/courriel.ts";
import { avecApp, CLES, config, empreinteTest, entetesJeton, MDP_TEST, proprietaire, session, sql, URL_ADMIN, URL_API } from "./aide.ts";

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

// --- Audit du 13/11/2026 (comptes, inscription, vérification de l'adresse) : migration 0039. ---

const verifie = async (email: string) => (await sql<{ v: boolean }>(URL_ADMIN,
  "SELECT email_verifie_le IS NOT NULL AS v FROM app.utilisateur WHERE email = lower($1)", [email]))[0]?.v;
const inscrireDepuis = (app: App, email: string, source: string, mot_de_passe = "un-mot-de-passe-long", nom = "Zone test") =>
  app.inject({ method: "POST", url: "/v1/inscription", headers: CSRF, remoteAddress: source, payload: { nom, email, mot_de_passe } });
const renvoyer = (app: App, email: string, source = sourceAuHasard()) =>
  app.inject({ method: "POST", url: "/v1/verification/renvoyer", headers: CSRF, remoteAddress: source, payload: { email } });
const confirmer = (app: App, jeton: string) =>
  app.inject({ method: "POST", url: "/v1/verification/confirmer", headers: CSRF, payload: { jeton } });
const jetonsPour = (exp: ExpediteurMemoire, email: string) =>
  exp.messages.filter((m) => m.a === email).map((m) => /#\/verifier\?j=([A-Za-z0-9_-]{43})/.exec(m.texte)?.[1]).filter((j): j is string => !!j);
/** Envois partis en arrière-plan (renvoi du lien) : terminés avant de regarder les messages. */
const envoisTermines = envoisEnCours;
const liensComptes = async (email: string) => (await sql<{ n: number }>(URL_ADMIN,
  `SELECT ((SELECT count(*) FROM app.utilisateur_liens l WHERE l.utilisateur_id = u.id)
        + (SELECT count(*) FROM app.verification_email v WHERE v.utilisateur_id = u.id))::int AS n
     FROM app.utilisateur u WHERE u.email = lower($1)`, [email]))[0].n;

test("audit 13/11/2026 (1) : adresses en .invalid refusées par l'API (422) et par la base ; seule la forme purgée de la ligne elle-même passe", async () => {
  await avecApp(async (app) => {
    const [{ n }] = await sql<{ n: string }>(URL_ADMIN, "SELECT (coalesce(max(id), 0) + 3)::text AS n FROM app.utilisateur");
    for (const email of [`purge-${n}@wakatnet.invalid`, "quelqu-un@exemple.invalid", `PURGE-${n}@WAKATNET.INVALID`, "a@sous.wakatnet.invalid"]) {
      const r = await inscrireBrut(app, email);
      assert.equal(r.statusCode, 422, `${email} : ${r.body}`);
    }
    // En base : une adresse du domaine wakatnet.invalid n'est permise qu'à la ligne purgée elle-même (purge-<son id>).
    const p = await proprietaire("adresse réservée");
    const [{ id }] = await sql<{ id: string }>(URL_ADMIN, "SELECT id::text FROM app.utilisateur WHERE tenant_id = $1", [p.tenant]);
    await assert.rejects(sql(URL_ADMIN, "UPDATE app.utilisateur SET email = $2 WHERE id = $1", [id, `purge-${BigInt(id) + 1000n}@wakatnet.invalid`]), /utilisateur_email_reservee/);
    await assert.rejects(sql(URL_ADMIN, "UPDATE app.utilisateur SET email = 'x@sous.wakatnet.invalid' WHERE id = $1", [id]), /utilisateur_email_reservee/);
    await sql(URL_ADMIN, "UPDATE app.utilisateur SET email = $2, actif = false WHERE id = $1", [id, `purge-${id}@wakatnet.invalid`]);
  });
});

test("audit 13/11/2026 (1) : une purge en échec ne fait jamais échouer l'inscription", async () => {
  const exp = new ExpediteurMemoire();
  await avecApp(async (app) => {
    // Un compte jamais confirmé depuis 8 jours : la prochaine inscription le purge. On force l'échec de cette purge.
    const vieux = adresse();
    await inscrireBrut(app, vieux);
    await sql(URL_ADMIN, "UPDATE app.utilisateur SET cree_le = now() - interval '8 days' WHERE email = $1", [vieux]);
    await sql(URL_ADMIN, `CREATE FUNCTION public.purge_en_echec() RETURNS trigger LANGUAGE plpgsql AS $$
                          BEGIN IF NEW.email LIKE 'purge-%' THEN RAISE EXCEPTION 'purge refusée (test)'; END IF; RETURN NEW; END $$`);
    await sql(URL_ADMIN, "CREATE TRIGGER purge_en_echec BEFORE UPDATE ON app.utilisateur FOR EACH ROW EXECUTE FUNCTION public.purge_en_echec()");
    try {
      const email = adresse();
      const r = await inscrireBrut(app, email);
      assert.equal(r.statusCode, 202, r.body);
      assert.equal(jetonsPour(exp, email).length, 1, "le compte neuf est créé et reçoit son lien");
    } finally {
      await sql(URL_ADMIN, "DROP TRIGGER purge_en_echec ON app.utilisateur");
      await sql(URL_ADMIN, "DROP FUNCTION public.purge_en_echec()");
      await sql(URL_ADMIN, "UPDATE app.utilisateur SET cree_le = now() WHERE email = $1", [vieux]);
    }
  }, config(), { expediteur: exp });
});

test("audit 13/11/2026 (2) : nom de 81 caractères refusé (422) ; une création en échec répond comme une adresse prise et compte dans le budget de la source", async () => {
  await avecApp(async (app) => {
    const r = await inscrireDepuis(app, adresse(), sourceAuHasard(), "un-mot-de-passe-long", "N".repeat(81));
    assert.equal(r.statusCode, 422);
    assert.equal((await inscrireDepuis(app, adresse(), sourceAuHasard(), "un-mot-de-passe-long", "N".repeat(80))).statusCode, 202);
    // En base, directement (wk_api) : une création qui échoue ne lève pas d'erreur, et l'essai est compté.
    const source = `essai-${randomBytes(6).toString("hex")}`;
    const statuts: string[] = [];
    for (let i = 0; i < 6; i++) {
      const [s] = await sql<{ statut: string; utilisateur_id: string | null }>(URL_API,
        "SELECT statut, utilisateur_id::text FROM app.inscription_demander($1, $2, $3, $4)",
        ["N".repeat(100), adresse(), await empreinteTest(), source]);
      statuts.push(s.statut);
      if (i < 5) assert.equal(s.utilisateur_id, null);
    }
    assert.deepEqual(statuts, ["existe", "existe", "existe", "existe", "existe", "trop"]);
  });
});

test("audit 13/11/2026 (3) : pré-appropriation — l'inscription d'une adresse non confirmée remplace le mot de passe et invalide les liens ouverts", async () => {
  const exp = new ExpediteurMemoire();
  await avecApp(async (app) => {
    const victime = adresse();
    const att = await inscrireDepuis(app, victime, sourceAuHasard(), "mdp-de-l-attaquant-42");
    const [lienAttaquant] = jetonsPour(exp, victime);
    assert.ok(lienAttaquant, "lien envoyé à la boîte de la victime");
    const vic = await inscrireDepuis(app, victime, sourceAuHasard(), "mdp-de-la-victime-1");
    assert.deepEqual([att.statusCode, vic.statusCode], [202, 202]);
    assert.equal(vic.body, att.body, "réponse identique (F9)");
    const avis = exp.messages.filter((m) => m.a === victime).at(-1)!;
    assert.doesNotMatch(avis.texte, /verifier\?j=/, "l'avis ne porte aucun lien");
    assert.equal((await confirmer(app, lienAttaquant)).statusCode, 404, "le lien ouvert avant la nouvelle demande ne vaut plus");
    assert.equal(await verifie(victime), false);
    await renvoyer(app, victime);
    await envoisTermines();
    const lienVictime = jetonsPour(exp, victime).at(-1)!;
    assert.notEqual(lienVictime, lienAttaquant);
    assert.equal((await confirmer(app, lienVictime)).statusCode, 200);
    assert.equal((await connecter(app, victime, "mdp-de-l-attaquant-42")).statusCode, 401, "l'attaquant n'entre pas");
    assert.equal((await connecter(app, victime, "mdp-de-la-victime-1")).statusCode, 200, "la victime entre");
    // Adresse CONFIRMÉE : une nouvelle inscription ne change plus rien.
    assert.equal((await inscrireDepuis(app, victime, sourceAuHasard(), "mdp-de-l-attaquant-43")).statusCode, 202);
    assert.equal((await connecter(app, victime, "mdp-de-l-attaquant-43")).statusCode, 401);
    assert.equal((await connecter(app, victime, "mdp-de-la-victime-1")).statusCode, 200);
  }, config(), { expediteur: exp });
});

test("audit 13/11/2026 (4) : plafond global plein → aucun lien créé ni compté ; un envoi échoué ne compte pas", async () => {
  const exp = new ExpediteurMemoire();
  await avecApp(async (app) => {
    await sql(URL_ADMIN, "DELETE FROM app.courriel_envoye");
    await sql(URL_ADMIN, "INSERT INTO app.courriel_envoye (le) SELECT now() FROM generate_series(1, 200)");
    const email = adresse();
    try {
      assert.equal((await inscrireBrut(app, email)).statusCode, 202);
      for (let i = 0; i < 6; i++) assert.equal((await renvoyer(app, email)).statusCode, 202);
      await envoisTermines();
      assert.equal(await liensComptes(email), 0, "rien n'est créé ni compté tant que rien ne part");
    } finally {
      await sql(URL_ADMIN, "DELETE FROM app.courriel_envoye");
    }
    await renvoyer(app, email);
    await envoisTermines();
    assert.equal(jetonsPour(exp, email).length, 1, "le plafond libéré, le lien part");
  }, config(), { expediteur: exp });
  // Fournisseur en panne : le lien n'est pas compté dans la limite à vie.
  const enPanne = { envoyer: async () => { throw new Error("panne"); } };
  await avecApp(async (app) => {
    const email = adresse();
    assert.equal((await inscrireBrut(app, email)).statusCode, 202);
    await renvoyer(app, email);
    await envoisTermines();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await liensComptes(email), 0);
  }, config(), { expediteur: enPanne });
});

test("audit 13/11/2026 (4) : plafond quotidien de 10 demandes par source (inscriptions et renvois confondus)", async () => {
  await avecApp(async (app) => {
    const source = sourceAuHasard();
    const vieillir = () => sql(URL_ADMIN, "UPDATE app.source_demande SET le = le - interval '61 minutes'");
    for (let i = 0; i < 5; i++) assert.equal((await inscrireDepuis(app, adresse(), source)).statusCode, 202);
    await vieillir();
    for (let i = 0; i < 5; i++) assert.equal((await renvoyer(app, adresse(), source)).statusCode, 202);
    await envoisTermines();
    await vieillir();
    assert.equal((await inscrireDepuis(app, adresse(), source)).statusCode, 429, "11e demande du jour");
  });
});

test("audit 13/11/2026 (5) : une erreur 500 ne journalise ni le message ni le DETAIL de la base, seulement la classe, le code et la contrainte", async () => {
  const lignes: string[] = [];
  const flux = new Writable({ write(c, _e, cb) { lignes.push(String(c)); cb(); } });
  const base = ouvrirBase(URL_API);
  const app = construire(config(), base, { flux });
  const p = await proprietaire("journal");
  app.get("/test/erreur-contrainte", async () =>
    enTantQue(base, BigInt(p.tenant), (tx) => tx.$executeRaw`INSERT INTO app.point_of_sale (tenant_id, nom) VALUES (${BigInt(p.tenant)}, ${"x".repeat(81) + "fuite@exemple.bf"})`));
  app.get("/test/erreur-valeur", async () => base.$queryRawUnsafe("SELECT $1::int", "fuite@exemple.bf"));
  try {
    assert.equal((await app.inject({ url: "/test/erreur-contrainte" })).statusCode, 500);
    assert.equal((await app.inject({ url: "/test/erreur-valeur" })).statusCode, 500);
    const j = lignes.join("");
    assert.doesNotMatch(j, /fuite@exemple\.bf|Failing row|xxxxxxxx/);
    assert.match(j, /"sqlstate":"23514"/);
    assert.match(j, /"contrainte":"point_of_sale_nom_check"/);
    assert.match(j, /"sqlstate":"22P02"/);
    assert.match(j, /PrismaClientKnownRequestError/);
  } finally {
    await app.close();
    await base.$disconnect();
  }
});

test("audit 13/11/2026 (6) : le renvoi répond 202 sans attendre le travail du lien (pas d'écart de durée selon l'adresse)", async () => {
  const exp = new ExpediteurMemoire();
  await avecApp(async (app) => {
    const email = adresse();
    await inscrireBrut(app, email);
    const [{ id }] = await sql<{ id: string }>(URL_ADMIN, "SELECT id::text FROM app.utilisateur WHERE email = $1", [email]);
    // Le verrou du compte est tenu ailleurs : un renvoi qui attendrait la création du lien resterait bloqué.
    const verrou = new pg.Client({ connectionString: URL_ADMIN });
    await verrou.connect();
    await verrou.query("SELECT pg_advisory_lock(hashtext('wakatnet_verification:' || $1))", [id]);
    try {
      const r = await Promise.race([renvoyer(app, email), new Promise<"bloqué">((ok) => setTimeout(() => ok("bloqué"), 3000))]);
      assert.notEqual(r, "bloqué", "la réponse n'attend pas le lien");
      assert.equal((r as { statusCode: number }).statusCode, 202);
    } finally {
      await verrou.query("SELECT pg_advisory_unlock_all()");
      await verrou.end();
    }
    await envoisTermines();
    assert.equal(jetonsPour(exp, email).length, 2, "le lien part ensuite (inscription, puis renvoi)");
  }, config(), { expediteur: exp });
});

test("audit 13/11/2026 (LIMITES n° 2) : calculs scrypt plafonnés ; au-delà, 503 et Retry-After, jamais 500", async () => {
  // Sans base : 4 calculs actifs + 32 en attente ; le 37e est refusé tout de suite (CalculsSatures).
  const r = await Promise.allSettled(Array.from({ length: 40 }, () => hacher("mot-de-passe-de-test")));
  const refus = r.filter((x) => x.status === "rejected");
  assert.equal(refus.length, 4, "40 demandes simultanées : 36 servies, 4 refusées");
  for (const x of refus) assert.equal(((x as PromiseRejectedResult).reason as Error).name, "CalculsSatures");
  assert.ok(await verifier("a", await hacher("a")), "les places se libèrent ensuite");
  // Par l'API : 60 connexions simultanées sur des adresses inconnues (le hachage factice tourne à chaque fois).
  await avecApp(async (app) => {
    const reps = await Promise.all(Array.from({ length: 60 }, (_, i) => app.inject({ method: "POST", url: "/v1/connexion",
      headers: CSRF, remoteAddress: `198.51.100.${i + 1}`, payload: { email: `inconnu-${i}-${randomBytes(4).toString("hex")}@exemple.bf`, mot_de_passe: "mot-de-passe-faux" } })));
    const codes = reps.map((x) => x.statusCode);
    assert.ok(codes.every((c) => c === 401 || c === 503), `codes inattendus : ${[...new Set(codes)]}`);
    assert.ok(codes.includes(503), "la saturation est bien visible (503)");
    const sature = reps.find((x) => x.statusCode === 503)!;
    assert.equal(sature.headers["retry-after"], "5");
  });
});
