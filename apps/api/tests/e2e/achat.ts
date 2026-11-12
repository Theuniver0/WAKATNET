// WAKATNET — achat de bout en bout dans un VRAI navigateur sans interface (Chromium, Playwright).
// Ticket : .scratch/phase-3-portail-paiement/issues/07-achat-bout-en-bout.md
// Lancé par tests/e2e.sh (PostgreSQL neuf). Parcours :
//   faux hotspot (page de redirection du routeur) → portail → forfait → Moov → paiement simulé
//   confirmé par webhook → ticket → redirection GET vers link-login-only → le faux hotspot vérifie
//   le code par radius.authorize (la fonction du vrai chemin d'authentification).
// Puis P6 : page fermée pendant l'attente, retour sur le portail, ticket, connexion.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { MockProvider } from "../../../../packages/payments/src/index.ts";
import { construire } from "../../src/app.ts";
import { ouvrirBase } from "../../src/base.ts";
import { config, routeur, sql, URL_ADMIN } from "../aide.ts";
import { numero, vendeur } from "../aide-paiement.ts";

// Playwright est installé hors du dépôt (navigateur préinstallé) : chargé par require, typé au plus juste.
type Page = {
  goto(u: string): Promise<unknown>; waitForURL(u: string | RegExp, o?: { timeout: number }): Promise<void>; url(): string;
  getByText(t: string | RegExp): { click(): Promise<void>; waitFor(): Promise<void> };
  getByLabel(t: string): { check(): Promise<void>; fill(v: string): Promise<void> };
  getByRole(r: string, o: { name: RegExp }): { click(): Promise<void> };
  textContent(s: string): Promise<string | null>; close(): Promise<void>;
};
type Contexte = { newPage(): Promise<Page>; close(): Promise<void> };
const { chromium } = createRequire(import.meta.url)("playwright") as
  { chromium: { launch(): Promise<{ newContext(): Promise<Contexte>; close(): Promise<void> }> } };

function ecouter(s: Server): Promise<number> {
  return new Promise((ok) => s.listen(0, "127.0.0.1", () => ok((s.address() as { port: number }).port)));
}

const base = ouvrirBase(config().urlBase);
const app = construire({ ...config(), urlPortail: "https://portail.test.invalid" }, base, { journal: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const PORTAIL = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

const v = await vendeur(app, "bout en bout");
// Hôte du faux hotspot, avec son port (non standard) : seule forme admise d'un port explicite.
const pretHotes = (port: number) => sql(URL_ADMIN, "UPDATE app.site SET hotspot_hotes = ARRAY[$2] WHERE id = $1", [v.site, `localhost:${port}`]);
const idRouteur = await routeur(v.tenant, v.site);
await sql(URL_ADMIN, "INSERT INTO radius.router_secret (router_id, secret) VALUES ($1, repeat('s', 32))", [idRouteur]);
const [{ ip }] = await sql<{ ip: string }>(URL_ADMIN, "SELECT host(overlay_ip) AS ip FROM app.router WHERE id = $1", [idRouteur]);

// --- Faux hotspot : sert la VRAIE page de redirection (variables du routeur substituées), et une
// page /login qui accepte un code si radius.authorize répond Accept.
const modele = await readFile(new URL("../../../../routeros/hotspot/redirection.html", import.meta.url), "utf8");
const connexions: string[] = [];
const hotspot = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://localhost");
  if (u.pathname === "/login" && u.searchParams.get("username")) {
    const code = u.searchParams.get("username")!;
    const [d] = await sql<{ decision: string }>(URL_ADMIN, "SELECT decision FROM radius.authorize($1, $2, '', '')", [code, ip]);
    if (d?.decision === "Accept" && u.searchParams.get("password") === code) {
      connexions.push(code);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<h1>Vous êtes connecté</h1>");
    } else res.writeHead(403).end("refus");
    return;
  }
  const lien = `http://localhost:${(hotspot.address() as { port: number }).port}/login`;
  const page = modele.replaceAll("__PORTAIL__", PORTAIL).replaceAll("__SITE__", v.publicId)
    .replaceAll("$(link-login-only-esc)", encodeURIComponent(lien)).replaceAll("$(link-orig-esc)", encodeURIComponent("http://exemple.bf/"))
    .replaceAll("$(error-esc)", "").replaceAll("$(mac-esc)", encodeURIComponent("AA:BB:CC:00:11:22")).replaceAll("$(ip)", "10.5.50.20");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
});
const portHotspot = await ecouter(hotspot);
await pretHotes(portHotspot);
const HOTSPOT = `http://localhost:${portHotspot}`;

const navigateur = await chromium.launch();
let echec = false;
try {
  // ---------------------------------------------------------------- 1. achat complet
  const ctx = await navigateur.newContext();
  const page = await ctx.newPage();
  await page.goto(`${HOTSPOT}/`);
  await page.waitForURL(/\/p\/[A-Za-z0-9_-]{16}\?/);
  console.log("ok : la page de redirection du hotspot mène au portail");
  await page.getByText("Acheter du temps de connexion").click();
  await page.getByText(/1 heure — 200 F/).click();
  await page.getByLabel("Moov Money").check();
  await page.getByLabel("Votre numéro").fill(numero("00"));
  await page.getByRole("button", { name: /Payer 200 F/ }).click();
  await page.waitForURL(`${HOTSPOT}/login?**`, { timeout: 20_000 });
  const code = new URL(page.url()).searchParams.get("username")!;
  assert.match(code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
  assert.equal(await page.textContent("h1"), "Vous êtes connecté");
  assert.deepEqual(connexions, [code]);
  assert.equal(new URL(page.url()).searchParams.get("dst"), "http://exemple.bf/");
  console.log(`ok : achat, attente, ticket ${code.slice(0, 2)}…, auto-connexion GET, code accepté par radius.authorize`);
  await ctx.close();

  // ---------------------------------------------------------------- 2. P6 : page fermée pendant l'attente
  const ctx2 = await navigateur.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto(`${HOTSPOT}/`);
  await p2.waitForURL(/\/p\//);
  await p2.getByText("Acheter du temps de connexion").click();
  await p2.getByText(/1 heure — 200 F/).click();
  await p2.getByLabel("Moov Money").check();
  await p2.getByLabel("Votre numéro").fill(numero("07"));
  await p2.getByRole("button", { name: /Payer 200 F/ }).click();
  await p2.getByText("Validez le paiement").waitFor();
  const ref = /\/achat\/(wk_[A-Za-z0-9_-]{22})/.exec(p2.url())![1];
  await p2.close();                                         // le client ferme la page…
  new MockProvider(v.secret, null).confirmer(ref);          // …paie sur son téléphone…
  await app.paiement!.rapprocher(ref, BigInt(v.tenant));    // …et le rapprochement le constate.
  const p3 = await ctx2.newPage();                          // il revient sur le Wi-Fi
  await p3.goto(`${HOTSPOT}/`);
  await p3.getByText("Votre ticket est prêt.").waitFor();
  await p3.getByText("Voir mon achat").click();
  await p3.waitForURL(`${HOTSPOT}/login?**`, { timeout: 20_000 });
  assert.equal(await p3.textContent("h1"), "Vous êtes connecté");
  console.log("ok : P6, page fermée pendant l'attente, ticket proposé au retour, connexion");
  await ctx2.close();
} catch (e) {
  echec = true;
  console.error("ÉCHEC :", e);
} finally {
  await navigateur.close();
  hotspot.close();
  await app.close();
  await base.$disconnect();
}
console.log(echec ? "bout en bout : ÉCHEC" : "bout en bout : SUCCÈS");
process.exitCode = echec ? 1 : 0;
