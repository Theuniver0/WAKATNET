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

test("vérification par lien : envoyé à l'inscription ; un clic le consomme ; usage unique, 24 h ; 3 liens par heure", async () => {
  const exp = new ExpediteurMemoire();
  await avecApp(async (app) => {
    const email = `verif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@exemple.bf`;
    const ins = await app.inject({ method: "POST", url: "/v1/inscription", headers: CSRF, payload: { nom: "Zone vérifiée", email, mot_de_passe: "un-mot-de-passe-long" } });
    assert.equal(ins.statusCode, 201);
    const cookie = String([ins.headers["set-cookie"]].flat()[0]).split(";")[0];
    const h = { cookie, ...CSRF };
    const m = exp.messages.find((x) => x.a === email)!;
    assert.ok(m, "lien envoyé à l'inscription");
    const lien = /https:\/\/api\.test\.invalid\/tableau\/#\/verifier\?j=([A-Za-z0-9_-]{43})/.exec(m.texte);
    assert.ok(lien, m.texte);
    // Le jeton n'est gardé qu'en empreinte.
    const [{ n }] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.verification_email WHERE empreinte = $1", [createHash("sha256").update(lien[1]).digest()]);
    assert.equal(n, 1);
    const [{ site }] = await sql<{ site: string }>(URL_ADMIN,
      "INSERT INTO app.site (tenant_id, nom) SELECT tenant_id, 's' FROM app.utilisateur WHERE email = $1 RETURNING id::text AS site", [email]);
    assert.equal((await app.inject({ method: "POST", url: `/v1/sites/${site}/enrollments`, headers: h })).statusCode, 403);
    // Lien faux, puis bon, puis rejoué.
    assert.equal((await app.inject({ method: "POST", url: "/v1/verification/confirmer", headers: CSRF, payload: { jeton: "A".repeat(43) } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/v1/verification/confirmer", headers: CSRF, payload: { jeton: lien[1] } })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/v1/verification/confirmer", headers: CSRF, payload: { jeton: lien[1] } })).statusCode, 404, "usage unique");
    assert.equal((await app.inject({ url: "/v1/moi", headers: h })).json().email_verifie, true);
    assert.equal((await app.inject({ method: "POST", url: `/v1/sites/${site}/enrollments`, headers: h })).statusCode, 201);
    // Adresse vérifiée : plus de lien.
    assert.equal((await app.inject({ method: "POST", url: "/v1/verification/envoyer", headers: h })).statusCode, 429);
  }, config(), { expediteur: exp });
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
