// Revue de sécurité M4 (ADR 0017, migration 0033) : quota d'enrôlement et vérification de l'adresse e-mail.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ExpediteurMemoire } from "../src/courriel.ts";
import { avecApp, config, entetes, proprietaire, routeur, session, sql, URL_ADMIN } from "./aide.ts";

type App = Parameters<Parameters<typeof avecApp>[0]>[0];
const CSRF = { "x-wakatnet-requete": "1" };
const commande = (app: App, p: { tenant: string; site: string }) =>
  app.inject({ method: "POST", url: `/v1/sites/${p.site}/enrollments`, headers: entetes(p.tenant) });

async function admin(): Promise<Record<string, string>> {
  const s = await session(null, "super_admin");
  await sql(URL_ADMIN, "UPDATE app.session_utilisateur SET totp_ok = true WHERE empreinte = $1", [createHash("sha256").update(s.jeton).digest()]);
  return { cookie: `wk_session=${s.jeton}`, ...CSRF };
}

test("quota : routeurs enrôlés (révoqués compris) + jetons ouverts ; au-delà, 409 ; relevé par le super-admin", async () => {
  await avecApp(async (app) => {
    const p = await proprietaire("quota");
    await sql(URL_ADMIN, "UPDATE app.tenant SET quota_routeurs = 3 WHERE id = $1", [p.tenant]);
    const r = await routeur(p.tenant, p.site);
    await sql(URL_ADMIN, "UPDATE app.router SET actif = false WHERE id = $1", [r]);     // révoqué : compte encore
    assert.equal((await commande(app, p)).statusCode, 201);
    assert.equal((await commande(app, p)).statusCode, 201);
    const refus = await commande(app, p);
    assert.equal(refus.statusCode, 409);
    assert.match(refus.json().erreur, /Quota de routeurs atteint/);
    // Un jeton expiré libère sa place ; pas un routeur révoqué.
    await sql(URL_ADMIN, "UPDATE app.enrollment_token SET cree_le = now() - interval '1 hour', expire_le = now() - interval '1 minute' WHERE tenant_id = $1", [p.tenant]);
    assert.equal((await commande(app, p)).statusCode, 201);
    // Le super-admin relève le quota (audité) ; la liste montre quota et routeurs enrôlés.
    const h = await admin();
    assert.equal((await app.inject({ method: "PUT", url: `/admin/v1/proprietaires/${p.tenant}/acces`, headers: h, payload: { quota_routeurs: 5 } })).statusCode, 200);
    assert.equal((await commande(app, p)).statusCode, 201);
    const ligne = (await app.inject({ url: "/admin/v1/proprietaires", headers: h })).json().find((x: { id: string }) => x.id === p.tenant);
    assert.equal(ligne.quota_routeurs, 5);
    assert.equal(ligne.routeurs_enroles, 1);
    assert.equal(ligne.email_verifie, true);
    const [{ n }] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.audit_log WHERE action = 'admin_acces' AND tenant_id = $1", [p.tenant]);
    assert.equal(n, 1);
    for (const corps of [{ quota_routeurs: -1 }, { quota_routeurs: 10_001 }, { quota_routeurs: 1.5 }, { valider_email: false }, {}]) {
      assert.equal((await app.inject({ method: "PUT", url: `/admin/v1/proprietaires/${p.tenant}/acces`, headers: h, payload: corps })).statusCode, 422, JSON.stringify(corps));
    }
  });
});

test("quota : 12 commandes PARALLÈLES avec un quota de 4 → 4 acceptées exactement (verrou par propriétaire)", async () => {
  await avecApp(async (app) => {
    const p = await proprietaire("quota parallèle");
    await sql(URL_ADMIN, "UPDATE app.tenant SET quota_routeurs = 4 WHERE id = $1", [p.tenant]);
    const codes = (await Promise.all(Array.from({ length: 12 }, () => commande(app, p)))).map((r) => r.statusCode);
    assert.equal(codes.filter((c) => c === 201).length, 4, JSON.stringify(codes));
    assert.equal(codes.filter((c) => c === 409).length, 8);
  });
});

test("adresse non vérifiée : raccordement refusé (403), le reste du compte marche ; le super-admin la valide", async () => {
  await avecApp(async (app) => {
    const p = await proprietaire("non vérifié");
    await sql(URL_ADMIN, "UPDATE app.utilisateur SET email_verifie_le = NULL WHERE tenant_id = $1", [p.tenant]);
    const refus = await commande(app, p);
    assert.equal(refus.statusCode, 403);
    assert.match(refus.json().erreur, /Adresse e-mail non vérifiée/);
    assert.equal((await app.inject({ url: "/v1/moi", headers: entetes(p.tenant) })).json().email_verifie, false);
    assert.equal((await app.inject({ url: "/v1/sites", headers: entetes(p.tenant) })).statusCode, 200);
    // Sans expéditeur (production tant qu'aucun fournisseur n'est choisi) : 503, avec la marche à suivre.
    const envoi = await app.inject({ method: "POST", url: "/v1/verification/envoyer", headers: entetes(p.tenant) });
    assert.equal(envoi.statusCode, 503);
    assert.match(envoi.json().erreur, /Telecom Universel valide votre adresse/);
    const h = await admin();
    assert.equal((await app.inject({ method: "PUT", url: `/admin/v1/proprietaires/${p.tenant}/acces`, headers: h, payload: { valider_email: true } })).statusCode, 200);
    assert.equal((await app.inject({ url: "/v1/moi", headers: entetes(p.tenant) })).json().email_verifie, true);
    assert.equal((await commande(app, p)).statusCode, 201);
  });
});

test("ADR 0019 : inscription → lien → confirmation → connexion → raccordement ; quota de 2 ; lien à usage unique", async () => {
  const exp = new ExpediteurMemoire();
  await avecApp(async (app) => {
    const email = `verif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@exemple.bf`;
    const ins = await app.inject({ method: "POST", url: "/v1/inscription", headers: CSRF, remoteAddress: "10.77.0.1",
                                   payload: { nom: "Zone vérifiée", email, mot_de_passe: "un-mot-de-passe-long" } });
    assert.equal(ins.statusCode, 202);
    const m = exp.messages.find((x) => x.a === email)!;
    assert.ok(m, "lien envoyé à l'inscription");
    const lien = /https:\/\/api\.test\.invalid\/tableau\/#\/verifier\?j=([A-Za-z0-9_-]{43})/.exec(m.texte);
    assert.ok(lien, m.texte);
    const [{ n }] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.verification_email WHERE empreinte = $1", [createHash("sha256").update(lien[1]).digest()]);
    assert.equal(n, 1, "le jeton n'est gardé qu'en empreinte");
    const connecter = () => app.inject({ method: "POST", url: "/v1/connexion", headers: CSRF, remoteAddress: "10.77.0.1", payload: { email, mot_de_passe: "un-mot-de-passe-long" } });
    assert.equal((await connecter()).statusCode, 401, "pas de connexion avant confirmation");
    assert.equal((await app.inject({ method: "POST", url: "/v1/verification/confirmer", headers: CSRF, payload: { jeton: "A".repeat(43) } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/v1/verification/confirmer", headers: CSRF, payload: { jeton: lien[1] } })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/v1/verification/confirmer", headers: CSRF, payload: { jeton: lien[1] } })).statusCode, 404, "usage unique");
    const c = await connecter();
    assert.equal(c.statusCode, 200);
    const h = { cookie: String([c.headers["set-cookie"]].flat()[0]).split(";")[0], ...CSRF };
    assert.equal((await app.inject({ url: "/v1/moi", headers: h })).json().email_verifie, true);
    const [{ site, quota, valide }] = await sql<{ site: string; quota: number; valide: boolean }>(URL_ADMIN,
      `INSERT INTO app.site (tenant_id, nom) SELECT tenant_id, 's' FROM app.utilisateur WHERE email = $1
       RETURNING id::text AS site, (SELECT quota_routeurs FROM app.tenant WHERE id = tenant_id) AS quota,
                 (SELECT valide_admin FROM app.tenant WHERE id = tenant_id) AS valide`, [email]);
    assert.deepEqual([quota, valide], [2, false], "compte neuf : quota de 2, non validé");
    const enrole = () => app.inject({ method: "POST", url: `/v1/sites/${site}/enrollments`, headers: h });
    assert.deepEqual([(await enrole()).statusCode, (await enrole()).statusCode, (await enrole()).statusCode], [201, 201, 409]);
    // Adresse vérifiée : plus de lien.
    assert.equal((await app.inject({ method: "POST", url: "/v1/verification/envoyer", headers: h })).statusCode, 429);
  }, config(), { expediteur: exp });
});

test("ADR 0019 : adresse déjà inscrite → même réponse, avis à la titulaire ; 5 inscriptions par heure et par source", async () => {
  const exp = new ExpediteurMemoire();
  await avecApp(async (app) => {
    const p = await proprietaire("déjà inscrit");
    const [{ email }] = await sql<{ email: string }>(URL_ADMIN, "SELECT email FROM app.utilisateur WHERE tenant_id = $1", [p.tenant]);
    const inscrire = (adresse: string, source: string) => app.inject({ method: "POST", url: "/v1/inscription", headers: CSRF, remoteAddress: source,
      payload: { nom: "Z", email: adresse, mot_de_passe: "un-mot-de-passe-long" } });
    const neuf = await inscrire(`neuf-${Date.now()}@exemple.bf`, "10.78.0.1");
    const pris = await inscrire(email, "10.78.0.2");
    assert.equal(pris.statusCode, 202);
    assert.equal(pris.body, neuf.body, "réponse identique");
    const avis = exp.messages.filter((x) => x.a === email);
    assert.equal(avis.length, 1);
    await inscrire(email, "10.78.0.4");
    assert.equal(exp.messages.filter((x) => x.a === email).length, 1, "un avis par jour au plus");
    assert.match(avis[0].sujet, /déjà un compte/);
    assert.doesNotMatch(avis[0].texte, /verifier\?j=/, "l'avis ne porte aucun lien de confirmation");
    // Limite par source : 5 dans l'heure, puis 429.
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await inscrire(`src-${Date.now()}-${i}@exemple.bf`, "10.78.0.3")).statusCode);
    assert.deepEqual(codes, [202, 202, 202, 202, 202, 429]);
  }, config(), { expediteur: exp });
});

test("ADR 0019 : renvoi du lien sans session ; réponse identique ; seulement au propriétaire non confirmé ; 5 par heure et par source", async () => {
  const exp = new ExpediteurMemoire();
  await avecApp(async (app) => {
    const p = await proprietaire("renvoi");
    await sql(URL_ADMIN, "UPDATE app.utilisateur SET email_verifie_le = NULL WHERE tenant_id = $1", [p.tenant]);
    const [{ email }] = await sql<{ email: string }>(URL_ADMIN, "SELECT email FROM app.utilisateur WHERE tenant_id = $1", [p.tenant]);
    const renvoyer = (adresse: string, source: string) => app.inject({ method: "POST", url: "/v1/verification/renvoyer", headers: CSRF, remoteAddress: source, payload: { email: adresse } });
    const a = await renvoyer(email, "10.79.0.1");
    const b = await renvoyer(`inconnu-${Date.now()}@exemple.bf`, "10.79.0.1");
    assert.deepEqual([a.statusCode, b.statusCode], [202, 202]);
    assert.equal(a.body, b.body, "réponse identique");
    assert.equal(exp.messages.filter((x) => x.a === email).length, 1, "lien envoyé au seul compte qui attend");
    for (let i = 0; i < 3; i++) await renvoyer(email, "10.79.0.1");
    const avant = exp.messages.filter((x) => x.a === email).length;
    await renvoyer(email, "10.79.0.1");       // 6e demande de la source dans l'heure : rien n'est envoyé
    assert.equal(exp.messages.filter((x) => x.a === email).length, avant);
  }, config(), { expediteur: exp });
});

test("ADR 0019 : comptes non validés → plafond global de 100 routeurs enrôlés par jour ; la validation du super-admin le lève et porte le quota à 10", async () => {
  await avecApp(async (app) => {
    const p = await proprietaire("plafond global");
    await sql(URL_ADMIN, "UPDATE app.tenant SET valide_admin = false, quota_routeurs = 1000 WHERE id = $1", [p.tenant]);
    // 100 routeurs enrôlés dans les 24 h par d'AUTRES comptes non validés (adresses prises, pas jetons créés).
    const autre = await proprietaire("plafond global, autre compte");
    await sql(URL_ADMIN, "UPDATE app.tenant SET valide_admin = false WHERE id = $1", [autre.tenant]);
    await sql(URL_ADMIN, `INSERT INTO app.router (tenant_id, site_id, overlay_ip, shortname, enrole_le)
                          SELECT $1::bigint, $2::bigint, '10.213.150.0'::inet + g, 'plafond-' || g, now() - interval '2 hours'
                            FROM generate_series(1, 100) g`, [autre.tenant, autre.site]);
    try {
      const refus = await commande(app, p);
      assert.equal(refus.statusCode, 409);
      assert.match(refus.json().erreur, /suspendus pour les comptes non validés/);
      const h = await admin();
      await sql(URL_ADMIN, "UPDATE app.tenant SET quota_routeurs = 2 WHERE id = $1", [p.tenant]);
      assert.equal((await app.inject({ method: "PUT", url: `/admin/v1/proprietaires/${p.tenant}/acces`, headers: h, payload: { valider_email: true } })).statusCode, 200);
      const [t] = await sql<{ quota: number; valide: boolean }>(URL_ADMIN, "SELECT quota_routeurs AS quota, valide_admin AS valide FROM app.tenant WHERE id = $1", [p.tenant]);
      assert.deepEqual(t, { quota: 10, valide: true });
      assert.equal((await commande(app, p)).statusCode, 201, "compte validé : hors plafond global");
      // Baisser le quota d'un compte ne le valide pas (relecture) : seuls la validation de l'adresse ou un quota relevé.
      const q = await proprietaire("quota baissé");
      await sql(URL_ADMIN, "UPDATE app.tenant SET valide_admin = false, quota_routeurs = 2 WHERE id = $1", [q.tenant]);
      await app.inject({ method: "PUT", url: `/admin/v1/proprietaires/${q.tenant}/acces`, headers: h, payload: { quota_routeurs: 1 } });
      const [{ v }] = await sql<{ v: boolean }>(URL_ADMIN, "SELECT valide_admin AS v FROM app.tenant WHERE id = $1", [q.tenant]);
      assert.equal(v, false);
    } finally {
      await sql(URL_ADMIN, "DELETE FROM app.enrollment_token WHERE tenant_id = $1", [p.tenant]);
      await sql(URL_ADMIN, "DELETE FROM app.router WHERE shortname LIKE 'plafond-%'");
    }
  });
});

test("vérification par lien : expiré refusé ; 3 liens par heure, 5 en tout ; un gérant n'en demande pas", async () => {
  const exp = new ExpediteurMemoire();
  await avecApp(async (app) => {
    const p = await proprietaire("liens");
    await sql(URL_ADMIN, "UPDATE app.utilisateur SET email_verifie_le = NULL WHERE tenant_id = $1", [p.tenant]);
    const envoyer = () => app.inject({ method: "POST", url: "/v1/verification/envoyer", headers: entetes(p.tenant) });
    assert.deepEqual([(await envoyer()).statusCode, (await envoyer()).statusCode, (await envoyer()).statusCode, (await envoyer()).statusCode], [202, 202, 202, 429]);
    const jeton = /#\/verifier\?j=([A-Za-z0-9_-]{43})/.exec(exp.messages[0].texte)![1];
    await sql(URL_ADMIN, "UPDATE app.verification_email SET expire_le = now() - interval '1 minute' WHERE empreinte = $1", [createHash("sha256").update(jeton).digest()]);
    assert.equal((await app.inject({ method: "POST", url: "/v1/verification/confirmer", headers: CSRF, payload: { jeton } })).statusCode, 404, "expiré");
    // Une heure plus tard : 2 liens encore, puis plus rien, même des heures après (5 en tout).
    await sql(URL_ADMIN, "UPDATE app.verification_email v SET cree_le = v.cree_le - interval '2 hours' WHERE v.utilisateur_id IN (SELECT id FROM app.utilisateur WHERE tenant_id = $1)", [p.tenant]);
    assert.deepEqual([(await envoyer()).statusCode, (await envoyer()).statusCode, (await envoyer()).statusCode], [202, 202, 429]);
    await sql(URL_ADMIN, "UPDATE app.verification_email v SET cree_le = v.cree_le - interval '2 hours' WHERE v.utilisateur_id IN (SELECT id FROM app.utilisateur WHERE tenant_id = $1)", [p.tenant]);
    assert.equal((await envoyer()).statusCode, 429, "5 liens en tout");
    const [{ pdv }] = await sql<{ pdv: string }>(URL_ADMIN, "INSERT INTO app.point_of_sale (tenant_id, nom) VALUES ($1, 'pdv') RETURNING id::text AS pdv", [p.tenant]);
    const g = await session(p.tenant, "gerant", pdv);
    assert.equal((await app.inject({ method: "POST", url: "/v1/verification/envoyer", headers: { cookie: `wk_session=${g.jeton}`, ...CSRF } })).statusCode, 403);
  }, config(), { expediteur: exp });
});

test("ADR 0019 : overlay rempli à 90 % → aucune commande pour un compte non validé ; un compte validé passe", async () => {
  await avecApp(async (app) => {
    const nonValide = await proprietaire("overlay non validé");
    const valide = await proprietaire("overlay validé");
    const remplissage = await proprietaire("overlay remplissage");   // porte les routeurs de remplissage (pas le quota des deux autres)
    await sql(URL_ADMIN, "UPDATE app.tenant SET valide_admin = false WHERE id = $1", [nonValide.tenant]);
    // Remplit l'overlay hors de la plage des routeurs de test (10.213.200.0/22), puis le vide à la fin.
    await sql(URL_ADMIN, `INSERT INTO app.router (tenant_id, site_id, overlay_ip, shortname)
                          SELECT $1, $2, '10.213.0.0'::inet + g, 'remplissage-' || g FROM generate_series(1, 64000) g
                           WHERE NOT ('10.213.0.0'::inet + g) << '10.213.200.0/22'::inet
                          ON CONFLICT DO NOTHING`, [remplissage.tenant, remplissage.site]);
    try {
      const [{ n }] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.router WHERE overlay_ip << '10.213.0.0/16'::inet");
      assert.ok(n >= 0.9 * 254 * 254, `overlay rempli : ${n}`);
      const refus = await commande(app, nonValide);
      assert.equal(refus.statusCode, 409);
      assert.match(refus.json().erreur, /suspendus pour les comptes non validés/);
      assert.equal((await commande(app, valide)).statusCode, 201, "compte validé par le super-admin : hors de ce seuil");
    } finally {
      await sql(URL_ADMIN, "DELETE FROM app.enrollment_token WHERE tenant_id = $1", [valide.tenant]);
      await sql(URL_ADMIN, "DELETE FROM app.router WHERE shortname LIKE 'remplissage-%'");
    }
  });
});

test("ADR 0019 (relecture) : des avis provoqués par un tiers n'épuisent pas les liens d'un compte neuf ; adresse libérée après 7 jours", async () => {
  const exp = new ExpediteurMemoire();
  await avecApp(async (app) => {
    const email = `neuf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@exemple.bf`;
    const inscrire = (source: string, mdp = "un-mot-de-passe-long") => app.inject({ method: "POST", url: "/v1/inscription", headers: CSRF,
      remoteAddress: source, payload: { nom: "Z", email, mot_de_passe: mdp } });
    await inscrire("10.80.0.1");
    for (let i = 0; i < 6; i++) await inscrire(`10.80.1.${i}`, "mot-de-passe-du-tiers");      // le tiers insiste
    const renvoi = await app.inject({ method: "POST", url: "/v1/verification/renvoyer", headers: CSRF, remoteAddress: "10.80.2.1", payload: { email } });
    assert.equal(renvoi.statusCode, 202);
    const liens = exp.messages.filter((x) => x.a === email && /verifier\?j=/.test(x.texte));
    assert.equal(liens.length, 2, "lien d'inscription, puis lien renvoyé : le budget de liens est intact");
    // Jamais confirmé au bout de 7 jours : l'adresse est libérée à la prochaine inscription, et le compte désactivé.
    const [{ id }] = await sql<{ id: string }>(URL_ADMIN,
      "UPDATE app.utilisateur SET cree_le = now() - interval '8 days' WHERE email = $1 RETURNING id::text", [email]);
    assert.equal((await inscrire("10.80.3.1")).statusCode, 202);
    const [ancien] = await sql<{ email: string; actif: boolean }>(URL_ADMIN, "SELECT email, actif FROM app.utilisateur WHERE id = $1", [id]);
    assert.deepEqual(ancien, { email: `purge-${id}@wakatnet.invalid`, actif: false });
    const [{ n }] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.utilisateur WHERE email = $1", [email]);
    assert.equal(n, 1, "un compte neuf a repris l'adresse");
  }, config(), { expediteur: exp });
});

test("ADR 0019 (relecture) : plafond global de 200 e-mails par 24 h ; au-delà, rien ne part", async () => {
  const exp = new ExpediteurMemoire();
  await avecApp(async (app) => {
    const p = await proprietaire("plafond e-mails");
    await sql(URL_ADMIN, "UPDATE app.utilisateur SET email_verifie_le = NULL WHERE tenant_id = $1", [p.tenant]);
    const [{ email }] = await sql<{ email: string }>(URL_ADMIN, "SELECT email FROM app.utilisateur WHERE tenant_id = $1", [p.tenant]);
    await sql(URL_ADMIN, "INSERT INTO app.courriel_envoye (le) SELECT now() FROM generate_series(1, 200)");
    try {
      const r = await app.inject({ method: "POST", url: "/v1/verification/renvoyer", headers: CSRF, remoteAddress: "10.81.0.1", payload: { email } });
      assert.equal(r.statusCode, 202, "réponse identique");
      assert.equal(exp.messages.filter((x) => x.a === email).length, 0);
    } finally {
      await sql(URL_ADMIN, "DELETE FROM app.courriel_envoye");
    }
  }, config(), { expediteur: exp });
});
