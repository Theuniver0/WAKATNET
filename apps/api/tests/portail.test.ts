// Portail captif (SPEC §7.1, §7.2, P6, P9 ; ADR 0005 §1 ; ADR 0013 §9, §10).
// Ticket : .scratch/phase-3-portail-paiement/issues/06-portail.md
import assert from "node:assert/strict";
import { test } from "node:test";
import { MockProvider } from "../../../packages/payments/src/index.ts";
import { lienConnexion, messageErreur } from "../src/portail.ts";
import { avecApp, sql, URL_ADMIN } from "./aide.ts";
import { attendreStatut, numero, statut, vendeur, type App, type Vendeur } from "./aide-paiement.ts";

const L = "http://10.5.50.1/login";
const ctx = `?l=${encodeURIComponent(L)}&o=${encodeURIComponent("http://exemple.bf/")}`;

function cookieDe(r: { headers: Record<string, unknown> }): string {
  const c = r.headers["set-cookie"];
  const v = Array.isArray(c) ? c[0] : String(c ?? "");
  return v.split(";")[0];
}

/** Parcours complet par les formulaires, comme un navigateur sans JavaScript. */
async function acheter(app: App, v: Vendeur, sc: string, cookie = ""): Promise<{ ref: string; cookie: string; soumission: string }> {
  const f = await app.inject({ url: `/p/${v.publicId}/payer${ctx}&plan=${v.plan}`, headers: cookie ? { cookie } : {} });
  assert.equal(f.statusCode, 200, f.body);
  const c = cookie || cookieDe(f);
  const soumission = /name="soumission" value="([A-Za-z0-9_-]+)"/.exec(f.body)![1];
  const r = await app.inject({ method: "POST", url: `/p/${v.publicId}/payer`, headers: { cookie: c, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ l: L, o: "http://exemple.bf/", plan: v.plan, soumission, operateur: "moov_bf", numero: numero(sc) }).toString() });
  assert.equal(r.statusCode, 303, r.body);
  const ref = /\/achat\/(wk_[A-Za-z0-9_-]{22})/.exec(String(r.headers.location))![1];
  return { ref, cookie: c, soumission };
}

test("lien d'auto-connexion : seulement vers un hôte du hotspot relevé à l'enrôlement ; jamais une redirection ouverte", () => {
  const hotes = ["10.5.50.1", "login.wifi"];
  assert.equal(lienConnexion(L, hotes, "AB3K9MZQ", "http://exemple.bf/"),
    "http://10.5.50.1/login?username=AB3K9MZQ&password=AB3K9MZQ&dst=http%3A%2F%2Fexemple.bf%2F");
  assert.ok(lienConnexion("https://LOGIN.wifi/login", hotes, "X"));
  for (const mauvais of ["http://10.5.50.77/", "http://203.0.113.5/login", "https://pirate.example/login", "javascript:alert(1)",
                         "http://user:pass@10.5.50.1/login", "http://10.5.50.1.pirate.example/", "ftp://10.5.50.1/", "", "http://256.1.1.1/"]) {
    assert.equal(lienConnexion(mauvais, hotes, "X"), null, mauvais);
  }
  assert.equal(lienConnexion(L, [], "X"), null, "aucun hôte relevé : code affiché seulement");
});

test("messages : les causes de refus deviennent des phrases utiles (§7.1)", () => {
  assert.match(messageErreur("epuise")!, /Forfait terminé/);
  assert.match(messageErreur("RADIUS server: expire")!, /expiré/);
  assert.match(messageErreur("ticket_inconnu")!, /Code inconnu/);
  assert.equal(messageErreur(""), null);
});

test("pages : < 100 Ko, aucune ressource externe, en-têtes de sécurité, jamais le mot RADIUS", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "portail pages");
    const urls = [`/p/${v.publicId}${ctx}&error=epuise`, `/p/${v.publicId}/forfaits${ctx}`, `/p/${v.publicId}/payer${ctx}&plan=${v.plan}`,
                  `/p/${v.publicId}/retrouver${ctx}`];
    const { ref, cookie } = await acheter(app, v, "07");
    urls.push(`/p/${v.publicId}/achat/${ref}${ctx}`);
    for (const u of urls) {
      const r = await app.inject({ url: u, headers: { cookie } });
      assert.equal(r.statusCode, 200, u);
      assert.ok(Buffer.byteLength(r.body) < 100 * 1024, `${u} : ${Buffer.byteLength(r.body)} octets`);
      console.log(`# ${u.split("?")[0].replace(v.publicId, "SITE").replace(ref, "REF")} : ${Buffer.byteLength(r.body)} octets`);
      assert.ok(!/(src|href)="https?:\/\//.test(r.body), `${u} : ressource externe`);
      assert.ok(!/<link|@import|url\(/.test(r.body), u);
      assert.ok(!/radius/i.test(r.body.replace(/<style>[\s\S]*?<\/style>/, "")), u);
      assert.match(String(r.headers["content-security-policy"]), /default-src 'none'/);
      assert.equal(r.headers["cache-control"], "no-store");
    }
    assert.match((await app.inject({ url: `/p/${v.publicId}${ctx}&error=epuise` })).body, /Forfait terminé/);
    assert.equal((await app.inject({ url: `/p/${"x".repeat(16)}` })).statusCode, 404);
  });
});

test("achat par les formulaires : attente, puis ticket et auto-connexion GET vers le hotspot", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "portail achat");
    const { ref, cookie } = await acheter(app, v, "00");
    await attendreStatut(ref, "SUCCEEDED");
    const r = await app.inject({ url: `/p/${v.publicId}/achat/${ref}${ctx}`, headers: { cookie } });
    const code = /class="code">([0-9A-Z]+)</.exec(r.body)![1];
    assert.match(r.body, new RegExp(`content="3;url=http://10\\.5\\.50\\.1/login\\?username=${code}&amp;password=${code}&amp;dst=`));
    // Sans le jeton de l'appareil : pas de code.
    const autre = await app.inject({ url: `/p/${v.publicId}/achat/${ref}${ctx}` });
    assert.ok(!autre.body.includes(code));
    assert.match(autre.body, /autre appareil/);
    // Mauvais site dans l'URL : introuvable.
    const w = await vendeur(app, "portail autre site");
    assert.equal((await app.inject({ url: `/p/${w.publicId}/achat/${ref}`, headers: { cookie } })).statusCode, 404);
  });
});

test("P9 par le formulaire : double envoi → un seul paiement ; Orange sans code reçu → 422", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "portail P9");
    const f = await app.inject({ url: `/p/${v.publicId}/payer${ctx}&plan=${v.plan}` });
    const cookie = cookieDe(f);
    const soumission = /name="soumission" value="([A-Za-z0-9_-]+)"/.exec(f.body)![1];
    const corps = new URLSearchParams({ plan: v.plan, soumission, operateur: "moov_bf", numero: numero("07") }).toString();
    const h = { cookie, "content-type": "application/x-www-form-urlencoded" };
    const [a, b] = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: `/p/${v.publicId}/payer`, headers: h, payload: corps })));
    assert.equal(a.headers.location, b.headers.location);
    const [n] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.payment WHERE tenant_id = $1", [v.tenant]);
    assert.equal(n.n, 1);
    const sansOtp = new URLSearchParams({ plan: v.plan, soumission: "S".repeat(24), operateur: "orange_bf", numero: numero("00") }).toString();
    const r = await app.inject({ method: "POST", url: `/p/${v.publicId}/payer`, headers: h, payload: sansOtp });
    assert.equal(r.statusCode, 422);
    assert.match(r.body, /code reçu/);
  });
});

test("P6 : page fermée pendant PENDING → l'accueil propose l'achat au retour, puis le ticket", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "portail P6");
    const { ref, cookie } = await acheter(app, v, "07");
    // Le client ferme la page, compose son code, puis revient sur l'accueil du portail.
    const accueil = await app.inject({ url: `/p/${v.publicId}${ctx}`, headers: { cookie } });
    assert.match(accueil.body, /Votre achat est en cours/);
    assert.ok(accueil.body.includes(`/achat/${ref}`));
    new MockProvider(v.secret, null).confirmer(ref);
    await app.paiement!.rapprocher(ref, BigInt(v.tenant));
    const r = await app.inject({ url: `/p/${v.publicId}/achat/${ref}${ctx}`, headers: { cookie } });
    assert.match(r.body, /class="code">[0-9A-Z]{8}</);
  });
});

test("retrouver depuis un AUTRE appareil : numéro + 4 derniers caractères ; tentatives limitées ; jamais la MAC", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "portail retrouver");
    const num = numero("00");
    const f = await app.inject({ url: `/p/${v.publicId}/payer?plan=${v.plan}` });
    const soumission = /name="soumission" value="([A-Za-z0-9_-]+)"/.exec(f.body)![1];
    const r0 = await app.inject({ method: "POST", url: `/p/${v.publicId}/payer`, headers: { cookie: cookieDe(f), "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ plan: v.plan, soumission, operateur: "moov_bf", numero: num }).toString() });
    const ref = /\/achat\/(wk_[A-Za-z0-9_-]{22})/.exec(String(r0.headers.location))![1];
    await attendreStatut(ref, "SUCCEEDED");
    const [{ rf }] = await sql<{ rf: string }>(URL_ADMIN, "SELECT reference_fournisseur AS rf FROM app.payment WHERE reference = $1", [ref]);
    // Nouvel appareil : il obtient son propre jeton, puis cherche.
    const g = await app.inject({ url: `/p/${v.publicId}/retrouver` });
    const cookie2 = cookieDe(g);
    const h = { cookie: cookie2, "content-type": "application/x-www-form-urlencoded" };
    const faux = await app.inject({ method: "POST", url: `/p/${v.publicId}/retrouver`, headers: h, payload: `numero=${num}&suffixe=ZZZZ` });
    assert.equal(faux.statusCode, 404);
    const bon = await app.inject({ method: "POST", url: `/p/${v.publicId}/retrouver`, headers: h, payload: `numero=226${num}&suffixe=${rf.slice(-4).toLowerCase()}` });
    assert.equal(bon.statusCode, 303);
    const t = await app.inject({ url: String(bon.headers.location), headers: { cookie: cookie2 } });
    assert.match(t.body, /class="code">[0-9A-Z]{8}</, "le nouvel appareil voit le code");
    // 5 essais par numéro et par site sur 15 min (2 déjà faits) : le 6e est bloqué, même juste.
    for (let i = 0; i < 3; i++) await app.inject({ method: "POST", url: `/p/${v.publicId}/retrouver`, headers: h, payload: `numero=${num}&suffixe=AAAA` });
    const bloque = await app.inject({ method: "POST", url: `/p/${v.publicId}/retrouver`, headers: h, payload: `numero=${num}&suffixe=${rf.slice(-4)}` });
    assert.equal(bloque.statusCode, 429);
    const [{ n }] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.recuperation_tentative t JOIN app.site s ON s.id = t.site_id WHERE s.public_id = $1", [v.publicId]);
    assert.equal(n, 5, "chaque tentative est journalisée");
    assert.equal((await statut(ref)).statut, "SUCCEEDED");
  });
});

test("« J'ai un ticket » : majuscules, redirection vers le hotspot ; lien suspect → code affiché seulement", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "portail ticket");
    const h = { "content-type": "application/x-www-form-urlencoded" };
    const r = await app.inject({ method: "POST", url: `/p/${v.publicId}/ticket`, headers: h, payload: `l=${encodeURIComponent(L)}&code=ab3k+9mzq` });
    assert.equal(r.statusCode, 303);
    assert.equal(r.headers.location, "http://10.5.50.1/login?username=AB3K9MZQ&password=AB3K9MZQ");
    const s = await app.inject({ method: "POST", url: `/p/${v.publicId}/ticket`, headers: h,
                                 payload: `l=${encodeURIComponent("https://pirate.example/x")}&code=AB3K9MZQ` });
    assert.equal(s.statusCode, 200);
    assert.match(s.body, /AB3K9MZQ/);
    const mal = await app.inject({ method: "POST", url: `/p/${v.publicId}/ticket`, headers: h, payload: `code=<x>` });
    assert.match(String(mal.headers.location), /error=ticket_inconnu/);
  });
});

test("page de redirection du hotspot : générée pour SON site, vers le portail, variables du routeur seules", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "portail redirection");
    const w = await vendeur(app, "portail redirection autre");
    const r = await app.inject({ url: `/v1/sites/${v.site}/redirection.html`, headers: { "x-wakatnet-tenant": v.tenant } });
    assert.equal(r.statusCode, 200);
    assert.ok(r.body.includes(`https://portail.test.invalid/p/${v.publicId}?l=$(link-login-only-esc)`));
    assert.ok(!r.body.includes("__PORTAIL__") && !r.body.includes("__SITE__"));
    assert.equal((await app.inject({ url: `/v1/sites/${w.site}/redirection.html`, headers: { "x-wakatnet-tenant": v.tenant } })).statusCode, 404);
  });
});

test("retrouver : 30 requêtes PARALLÈLES ne font que 5 tentatives (verrou, relecture argent B1)", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "portail parallèle");
    const num = numero("00");
    const essais = await Promise.all(Array.from({ length: 30 }, (_, i) => app.inject({ method: "POST", url: `/p/${v.publicId}/retrouver`,
      headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `numero=${num}&suffixe=${(1000 + i).toString()}` })));
    assert.equal(essais.filter((r) => r.statusCode === 404).length, 5);
    assert.equal(essais.filter((r) => r.statusCode === 429).length, 25);
    const [{ n }] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.recuperation_tentative t JOIN app.site s ON s.id = t.site_id WHERE s.public_id = $1", [v.publicId]);
    assert.equal(n, 5);
  });
});
