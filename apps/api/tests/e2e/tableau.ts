// WAKATNET — parcours 1, 2, 4 et 5 dans le tableau de bord, dans Chromium sans interface, avec
// audit axe-core de chaque écran (aucune violation sérieuse ou critique) et CSP réellement appliquée.
// Ticket : .scratch/phase-4-exploitation/issues/08-tableau-de-bord.md ; PRD phase 4 §2 et §4.
// Lancé par tests/e2e.sh (PostgreSQL neuf, tableau construit par `npm run build -w apps/dashboard`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { construire } from "../../src/app.ts";
import { base32Encoder, chiffrerTotp, hotp, pasTotp } from "../../src/auth.ts";
import { ouvrirBase } from "../../src/base.ts";
import { ExpediteurMemoire } from "../../src/courriel.ts";
import { FauxPawapay } from "../aide-pawapay.ts";
import { CLES, config, empreinteTest, MDP_TEST, routeur, session, sql, URL_ADMIN } from "../aide.ts";
import { attendreStatut, jeton, numero, soumission, vendeur } from "../aide-paiement.ts";

// Playwright est installé hors du dépôt : chargé par require, typé au plus juste.
type Loc = {
  click(): Promise<void>; fill(v: string): Promise<void>; selectOption(v: { label: string }): Promise<unknown>;
  waitFor(o?: { timeout: number }): Promise<void>; textContent(): Promise<string | null>; getAttribute(n: string): Promise<string | null>;
  getByRole(r: string, o: { name: string | RegExp; exact?: boolean }): Loc; getByLabel(t: string | RegExp, o?: { exact: boolean }): Loc;
  getByText(t: string | RegExp): Loc; first(): Loc; locator(s: string): Loc; allTextContents(): Promise<string[]>; count(): Promise<number>;
};
type Reponse = { status(): number; body(): Promise<Buffer>; headers(): Record<string, string> };
type Page = Loc & {
  goto(u: string): Promise<unknown>; evaluate<T>(s: string): Promise<T>; url(): string;
  on(e: "console" | "pageerror", f: (m: { type?(): string; text?(): string; message?: string }) => void): void;
  request: { get(u: string): Promise<Reponse> }; waitForURL(u: RegExp): Promise<void>;
};
type Contexte = { newPage(): Promise<Page>; close(): Promise<void> };
const { chromium } = createRequire(import.meta.url)("playwright") as
  { chromium: { launch(): Promise<{ newContext(): Promise<Contexte>; close(): Promise<void> }> } };
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

const base = ouvrirBase(config().urlBase);
// Expéditeur en mémoire (ADR 0017) : le lien de vérification de l'adresse est lu ici, puis suivi dans le navigateur.
const expediteur = new ExpediteurMemoire();
// Faux pawaPay local (ADR 0020) : le compte marchand est vérifié chez le fournisseur à l'enregistrement.
const fauxPawapay = await new FauxPawapay().demarrer();
process.env.WAKATNET_PAWAPAY_URL = fauxPawapay.url;
const app = construire(config(), base, { journal: false, expediteur });     // dossierTableau par défaut : apps/dashboard/dist
await app.listen({ port: 0, host: "127.0.0.1" });
// « localhost » : contexte sûr pour Chromium, le cookie Secure de session y est accepté.
const ORIGINE = `http://localhost:${(app.server.address() as { port: number }).port}`;
const TABLEAU = `${ORIGINE}/tableau/`;

const audits: string[] = [];
async function auditer(page: Page, ecran: string): Promise<void> {
  // evaluate passe par le protocole de débogage : hors CSP, l'application n'en est pas affaiblie.
  await page.evaluate(AXE);
  const v = await page.evaluate<{ id: string; impact: string; n: number; cible: string }[]>(
    `axe.run(document, { resultTypes: ["violations"] }).then((r) => r.violations.map((v) =>
       ({ id: v.id, impact: v.impact, n: v.nodes.length, cible: JSON.stringify(v.nodes[0] && v.nodes[0].target) })))`);
  const graves = v.filter((x) => x.impact === "serious" || x.impact === "critical");
  assert.deepEqual(graves, [], `axe-core, écran « ${ecran} » : ${JSON.stringify(graves)}`);
  audits.push(`${ecran} (${v.length} remarque${v.length > 1 ? "s" : ""} mineure${v.length > 1 ? "s" : ""})`);
}

function surveiller(page: Page, erreurs: string[]): void {
  page.on("console", (m) => { if (m.type?.() === "error") erreurs.push(m.text?.() ?? ""); });
  page.on("pageerror", (e) => erreurs.push(e.message ?? String(e)));
}

async function titre(page: Page, t: string): Promise<void> {
  await page.getByRole("heading", { name: t, exact: true }).first().waitFor({ timeout: 10_000 });
}

async function telecharger(page: Page, lien: Loc): Promise<Reponse> {
  const href = await lien.getAttribute("href");
  assert.ok(href?.startsWith("/"), `lien de téléchargement sur la même origine : ${href}`);
  const r = await page.request.get(`${ORIGINE}${href}`);
  assert.equal(r.status(), 200, href!);
  return r;
}

function pdfEnTexte(octets: Buffer): string {
  assert.equal(octets.subarray(0, 5).toString("latin1"), "%PDF-");
  const f = join(mkdtempSync(join(tmpdir(), "wakatnet-pdf-")), "doc.pdf");
  writeFileSync(f, octets);
  return execFileSync("pdftotext", ["-layout", f, "-"], { encoding: "utf8" });
}

const navigateur = await chromium.launch();
let echec = false;
const erreursNavigateur: string[] = [];
try {
  // ======================================================= parcours 1 : raccorder un routeur
  const ctx = await navigateur.newContext();
  const page = await ctx.newPage();
  surveiller(page, erreursNavigateur);
  const email = `proprio-${randomBytes(4).toString("hex")}@exemple.bf`;
  await page.goto(`${TABLEAU}#/inscription`);
  await titre(page, "Créer un compte");
  await auditer(page, "Créer un compte");
  await page.getByLabel("Nom de votre zone Wi-Fi").fill("Wifi du Maquis Wend-Kuni");
  await page.getByLabel("Adresse e-mail", { exact: true }).fill(email);
  assert.equal(await page.getByLabel("Mot de passe").count(), 0, "plus de mot de passe à l'inscription (choisi à la confirmation)");
  await page.getByRole("button", { name: "Créer mon compte" }).click();
  // ADR 0019 : aucune session à l'inscription ; le lien de confirmation, puis la connexion.
  await page.getByText(/un lien de confirmation reçu par e-mail|ouvrez le lien de confirmation/).waitFor();
  const message = expediteur.messages.find((m) => m.a === email);
  assert.ok(message, "lien de confirmation envoyé à l'inscription");
  const jetonVerif = /#\/verifier\?j=([A-Za-z0-9_-]{43})/.exec(message.texte)![1];
  await page.goto(`${TABLEAU}#/connexion`);
  await titre(page, "Connexion");
  await page.getByLabel("Adresse e-mail", { exact: true }).fill(email);
  await page.getByLabel("Mot de passe").fill(MDP_TEST);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.getByText(/pas encore confirmée/).waitFor();          // refus avant confirmation, message générique
  await page.goto(`${TABLEAU}#/verifier?j=${jetonVerif}`);
  await titre(page, "Confirmer votre adresse e-mail");
  await auditer(page, "Confirmer votre adresse e-mail");
  // F2 (migration 0043) : le mot de passe se choisit à la confirmation.
  await page.getByLabel("Choisissez votre mot de passe").fill(MDP_TEST);
  await page.getByLabel("Retapez le mot de passe").fill(MDP_TEST);
  await page.getByRole("button", { name: "Confirmer mon adresse" }).click();
  await page.getByText(/Adresse confirmée/).waitFor();
  await page.getByRole("button", { name: "Se connecter" }).click();
  await titre(page, "Connexion");
  await page.getByLabel("Adresse e-mail", { exact: true }).fill(email);
  await page.getByLabel("Mot de passe").fill(MDP_TEST);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await titre(page, "Tableau de bord");
  await auditer(page, "Tableau de bord");
  const [{ tenant }] = await sql<{ tenant: string }>(URL_ADMIN, "SELECT tenant_id::text AS tenant FROM app.utilisateur WHERE email = $1", [email]);

  await page.getByRole("link", { name: "Sites et routeurs", exact: true }).click();
  await titre(page, "Sites et routeurs");
  await page.getByLabel("Nom du site").fill("Maquis Wend-Kuni");
  await page.getByRole("button", { name: "Ajouter le site" }).click();
  await page.getByRole("heading", { name: "Maquis Wend-Kuni" }).waitFor();
  await page.getByRole("button", { name: "Raccorder un routeur" }).click();
  const commande = (await page.locator("pre").first().textContent()) ?? "";
  assert.match(commande, /\/tool fetch/, `commande d'enrôlement à coller : ${commande}`);
  assert.match(commande, /\/enroll\//);
  await auditer(page, "Sites et routeurs");
  const redirection = await telecharger(page, page.getByRole("link", { name: "Page de connexion du hotspot", exact: true }));
  assert.match((await redirection.body()).toString("utf8"), /<html/i);
  console.log("ok : parcours 1 — compte créé sans session, connexion refusée avant confirmation, lien suivi, connexion, site déclaré, commande d'enrôlement affichée");

  // Compte marchand pawaPay (ADR 0020) : argent réel refusé avant G-ARGENT ; bac à sable accepté, adresse des callbacks.
  await page.getByRole("link", { name: "Compte marchand", exact: true }).click();
  await titre(page, "Compte marchand");
  await page.getByLabel("Environnement").selectOption({ label: "Production (argent réel)" });
  await page.getByLabel("Jeton d'API pawaPay").fill("jeton-de-test-pawapay-0123456789");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await page.getByText(/G-ARGENT/).waitFor();
  await page.getByLabel("Environnement").selectOption({ label: "Bac à sable (essais, sans argent réel)" });
  await page.getByLabel("Jeton d'API pawaPay").fill("jeton-de-test-pawapay-0123456789");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await page.getByText(/\/webhooks\/pawapay\/[A-Za-z0-9_-]{24}/).waitFor();
  await auditer(page, "Compte marchand");
  const [{ f }] = await sql<{ f: string }>(URL_ADMIN, "SELECT fournisseur AS f FROM app.compte_marchand WHERE tenant_id = $1", [tenant]);
  assert.equal(f, "pawapay");
  console.log("ok : compte marchand pawaPay (bac à sable) enregistré, argent réel refusé avant G-ARGENT");

  // ======================================================= parcours 2 : créer ses forfaits
  await page.getByRole("link", { name: "Forfaits", exact: true }).click();
  await titre(page, "Forfaits");
  await page.getByLabel("Nom", { exact: true }).fill("1 heure");
  await page.getByLabel("Prix (F)").fill("200");
  await page.getByLabel("Durée de connexion (minutes)").fill("60");
  await page.getByLabel("Validité (heures)").fill("24");
  await page.getByLabel("Débit (ex. 2M/2M)").fill("2M/2M");
  await page.getByLabel("Appareils").fill("1");
  await page.getByRole("button", { name: "Créer le forfait" }).click();
  await page.getByRole("rowheader", { name: "1 heure", exact: true }).waitFor();
  await page.getByText("200 F").first().waitFor();
  await auditer(page, "Forfaits");
  const [plan] = await sql<{ prix_xof: string; uptime_limit_s: number; validity_s: number; rate_limit: string; devices: number }>(URL_ADMIN,
    "SELECT prix_xof::text, uptime_limit_s, validity_s, rate_limit, devices FROM app.plan WHERE tenant_id = $1", [tenant]);
  assert.deepEqual(plan, { prix_xof: "200", uptime_limit_s: 3600, validity_s: 86400, rate_limit: "2M/2M", devices: 1 });
  console.log("ok : parcours 2 — forfait créé (prix, durée, validité, débit, appareils)");

  // ======================================================= parcours 4 : vendre en espèces
  await page.getByRole("link", { name: "Points de vente", exact: true }).click();
  await titre(page, "Points de vente et vendeurs");
  await page.getByLabel("Nom du point de vente").fill("Boutique du marché");
  await page.getByRole("button", { name: "Ajouter le point de vente" }).click();
  await page.locator('section[aria-labelledby="titre-pdv"] li').first().waitFor();
  const emailVendeur = `vendeur-${randomBytes(4).toString("hex")}@exemple.bf`;
  await page.getByLabel("Adresse e-mail", { exact: true }).fill(emailVendeur);
  await page.getByLabel("Rôle").selectOption({ label: "Vendeur" });
  await page.getByLabel("Point de vente", { exact: true }).selectOption({ label: "Boutique du marché" });
  await page.getByLabel("Mot de passe provisoire").fill(MDP_TEST);
  await page.getByRole("button", { name: "Créer l'accès" }).click();
  await page.getByRole("rowheader", { name: emailVendeur }).waitFor();
  await auditer(page, "Points de vente et vendeurs");

  await page.getByRole("link", { name: "Tickets papier", exact: true }).click();
  await titre(page, "Tickets papier");
  await page.getByLabel("Forfait").selectOption({ label: "1 heure (200 F)" });
  await page.getByLabel("Point de vente", { exact: true }).selectOption({ label: "Boutique du marché" });
  await page.getByLabel("Nombre de tickets").fill("12");
  await page.getByRole("button", { name: "Générer les tickets" }).click();
  const imprimer = page.getByRole("link", { name: "Imprimer (PDF)", exact: true }).first();
  await imprimer.waitFor();
  await auditer(page, "Tickets papier");
  const pdf = await telecharger(page, imprimer);
  assert.match(pdf.headers()["content-type"], /application\/pdf/);
  const texte = pdfEnTexte(await pdf.body());
  const codes = [...texte.matchAll(/\b[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8,16}\b/g)].map((m) => m[0]);
  assert.equal(new Set(codes).size, 12, `12 codes lisibles dans le PDF (pdftotext) : ${codes.length}`);
  assert.match(texte, /Wifi du Maquis Wend-Kuni|Maquis Wend-Kuni/);
  assert.match(texte, /Boutique du march/);
  await page.getByRole("button", { name: "Marquer remis" }).click();
  await page.getByText(/Remis le/).first().waitFor();

  // Activation d'un ticket par le vrai chemin d'authentification (authorize, post_auth, acct_start).
  const [{ site }] = await sql<{ site: string }>(URL_ADMIN, "SELECT id::text AS site FROM app.site WHERE tenant_id = $1", [tenant]);
  const idRouteur = await routeur(tenant, site);
  const [{ ip }] = await sql<{ ip: string }>(URL_ADMIN, "SELECT host(overlay_ip) AS ip FROM app.router WHERE id = $1", [idRouteur]);
  const [{ decision }] = await sql<{ decision: string }>(URL_ADMIN, "SELECT decision FROM radius.authorize($1, $2, '', '')", [codes[0], ip]);
  assert.equal(decision, "Accept");
  // authorize est en lecture seule (matrice T) : comme FreeRADIUS, post_auth puis Accounting-Start,
  // qui écrit l'activation.
  await sql(URL_ADMIN, "SELECT radius.post_auth($1, $2, 'AA-BB-CC-00-11-22', 'Accept', '')", [codes[0], ip]);
  const [{ r }] = await sql<{ r: string }>(URL_ADMIN,
    "SELECT radius.acct_start($1, 'e2e-1', $2, 'AA-BB-CC-00-11-22', '10.5.50.2', '', '', '', '', '', '', $3) AS r",
    [ip, codes[0], String(Math.floor(Date.now() / 1000))]);
  assert.equal(r, "ok", `acct_start : ${r}`);
  await ctx.close();

  // Le vendeur se connecte : il voit le lot de SON point de vente et l'activation.
  const ctxV = await navigateur.newContext();
  const pv = await ctxV.newPage();
  surveiller(pv, erreursNavigateur);
  await pv.goto(`${TABLEAU}#/connexion`);
  await titre(pv, "Connexion");
  await auditer(pv, "Connexion");
  await pv.getByLabel("Adresse e-mail", { exact: true }).fill(emailVendeur);
  await pv.getByLabel("Mot de passe").fill(MDP_TEST);
  await pv.getByRole("button", { name: "Se connecter" }).click();
  await titre(pv, "Tableau de bord");
  await pv.getByRole("link", { name: "Tickets papier", exact: true }).click();
  await titre(pv, "Tickets papier");
  const ligne = pv.getByRole("row", { name: /1 heure.*Boutique du marché/ }).first();
  await ligne.waitFor();
  const cellules = await ligne.locator("td").allTextContents();
  // Forfait, point de vente, date, puis générés, remis, activés, expirés, puis l'action.
  assert.deepEqual(cellules.slice(3, 7), ["0", "11", "1", "0"], `états du lot : ${JSON.stringify(cellules)}`);
  assert.match(cellules[7], /Remis le/);
  assert.equal(await pv.getByRole("button", { name: "Générer les tickets" }).count(), 0, "le vendeur ne génère pas de lot");
  assert.equal(await pv.getByRole("link", { name: "Imprimer (PDF)", exact: true }).count(), 0, "ni n'imprime");
  await auditer(pv, "Tickets papier (vendeur)");
  await ctxV.close();

  // Le vendeur s'en va : le propriétaire coupe son accès depuis l'écran (revue de sécurité M3).
  const ctxC = await navigateur.newContext();
  const pc = await ctxC.newPage();
  surveiller(pc, erreursNavigateur);
  await pc.goto(`${TABLEAU}#/connexion`);
  await pc.getByLabel("Adresse e-mail", { exact: true }).fill(email);
  await pc.getByLabel("Mot de passe").fill(MDP_TEST);
  await pc.getByRole("button", { name: "Se connecter" }).click();
  await titre(pc, "Tableau de bord");
  await pc.getByRole("link", { name: "Points de vente", exact: true }).click();
  await titre(pc, "Points de vente et vendeurs");
  await pc.getByRole("button", { name: `Couper l'accès de ${emailVendeur}` }).click();
  await auditer(pc, "Couper l'accès (confirmation)");
  await pc.getByRole("button", { name: "Confirmer la coupure" }).click();
  await pc.getByRole("row", { name: new RegExp(`${emailVendeur.replace(/[.]/g, "\\.")}.*Suspendu`) }).waitFor();
  await ctxC.close();
  const [{ sessions }] = await sql<{ sessions: number }>(URL_ADMIN,
    "SELECT count(*)::int AS sessions FROM app.session_utilisateur s JOIN app.utilisateur u ON u.id = s.utilisateur_id WHERE u.email = $1", [emailVendeur]);
  assert.equal(sessions, 0, "sessions du vendeur fermées");
  const reconnexion = await app.inject({ method: "POST", url: "/v1/connexion", headers: { "x-wakatnet-requete": "1" },
                                         payload: { email: emailVendeur, mot_de_passe: MDP_TEST } });
  assert.equal(reconnexion.statusCode, 401, "le vendeur ne peut plus se connecter");
  console.log("ok : parcours 4 — point de vente, vendeur, lot de 12, PDF lisible, remis, activation suivie, accès du vendeur coupé");

  // ======================================================= parcours 5 : suivre l'argent
  // Propriétaire avec une vente en ligne réelle (MockProvider, webhook), connecté par l'écran.
  const v = await vendeur(app, "parcours cinq");
  const emailP5 = `argent-${randomBytes(4).toString("hex")}@exemple.bf`;
  await session(v.tenant, "proprietaire", null, emailP5);
  const num = numero("00");
  const achat = await app.paiement!.creer({ sitePublic: v.publicId, planId: BigInt(v.plan), operateur: "moov_bf", numero: num,
                                            jetonAppareil: jeton(), soumission: soumission() });
  if (achat.statut !== "cree") throw new Error(achat.statut);
  await attendreStatut(achat.reference, "SUCCEEDED");

  const ctxA = await navigateur.newContext();
  const pa = await ctxA.newPage();
  surveiller(pa, erreursNavigateur);
  await pa.goto(`${TABLEAU}#/connexion`);
  await pa.getByLabel("Adresse e-mail", { exact: true }).fill(emailP5);
  await pa.getByLabel("Mot de passe").fill(MDP_TEST);
  await pa.getByRole("button", { name: "Se connecter" }).click();
  await titre(pa, "Tableau de bord");
  await pa.getByRole("link", { name: "Suivi de l'argent", exact: true }).click();
  await titre(pa, "Suivi de l'argent");
  const synthese = (await pa.locator("dl").first().textContent()) ?? "";
  assert.match(synthese, /Commissions\s*20 F/, `commission de 10 % sur 200 F : « ${synthese} »`);
  assert.match(synthese, /Solde de crédits\s*9 980 F/, `10 000 − 20 : « ${synthese} »`);
  await pa.getByLabel("Numéro du payeur").fill(num);
  await pa.getByRole("button", { name: "Rechercher" }).click();
  await pa.getByRole("cell", { name: /200 F/ }).first().waitFor();
  await auditer(pa, "Suivi de l'argent");
  const csv = (await (await telecharger(pa, pa.getByRole("link", { name: "Relevé CSV", exact: true }))).body());
  assert.deepEqual([...csv.subarray(0, 3)], [0xef, 0xbb, 0xbf], "CSV : BOM UTF-8");
  assert.match(csv.toString("utf8"), /;-?20(;|\r?\n|$)/m);
  const releve = pdfEnTexte(await (await telecharger(pa, pa.getByRole("link", { name: "Relevé PDF", exact: true }))).body());
  assert.match(releve, /Relev/);
  const facture = pdfEnTexte(await (await telecharger(pa, pa.getByRole("link", { name: "Facture PDF", exact: true }))).body());
  assert.match(facture, /provisoire/i, "facture : mention « document provisoire » (ADR 0014 §7)");
  await ctxA.close();

  // Super-admin : TOTP, puis commission par propriétaire au franc près, et rechargement.
  const emailAdmin = `admin-${randomBytes(4).toString("hex")}@exemple.bf`;
  const secret = randomBytes(20);
  await sql(URL_ADMIN, `INSERT INTO app.utilisateur (tenant_id, point_of_sale_id, role, email, mot_de_passe, totp_secret)
                        VALUES (NULL, NULL, 'super_admin', $1, $2, $3)`, [emailAdmin, await empreinteTest(), chiffrerTotp(CLES.marchands, emailAdmin, secret)]);
  assert.ok(base32Encoder(secret).length > 0);
  const ctxS = await navigateur.newContext();
  const ps = await ctxS.newPage();
  surveiller(ps, erreursNavigateur);
  await ps.goto(`${TABLEAU}#/connexion`);
  await ps.getByLabel("Adresse e-mail", { exact: true }).fill(emailAdmin);
  await ps.getByLabel("Mot de passe").fill(MDP_TEST);
  await ps.getByRole("button", { name: "Se connecter" }).click();
  await ps.getByRole("button", { name: "Valider" }).waitFor();
  await auditer(ps, "Double authentification");
  await ps.getByLabel(/[Cc]ode/).first().fill(hotp(secret, pasTotp(Date.now())));
  await ps.getByRole("button", { name: "Valider" }).click();
  await titre(ps, "Administration");
  const rangee = ps.getByRole("row", { name: /parcours cinq/ }).first();
  await rangee.waitFor();
  assert.match((await rangee.textContent()) ?? "", /9 980 F.*200 F.*20 F/, "solde, ventes en ligne, commission au franc près");
  await auditer(ps, "Administration");
  await rangee.getByLabel("Montant à recharger (F)").fill("5000");
  await rangee.getByLabel("Référence du reçu").fill(`recu-${randomBytes(3).toString("hex")}`);
  await rangee.getByRole("button", { name: "Recharger" }).click();
  await ps.getByRole("row", { name: /parcours cinq.*14 980 F/ }).first().waitFor();
  await ctxS.close();
  console.log("ok : parcours 5 — synthèse et recherche du propriétaire, CSV et PDF ; super-admin : TOTP, commission, rechargement");

  const csp = erreursNavigateur.filter((e) => /Content Security Policy|Refused to/i.test(e));
  assert.deepEqual(csp, [], "aucune violation de CSP dans le navigateur");
  console.log(`ok : axe-core sans violation sérieuse ni critique sur ${audits.length} écrans : ${audits.join(", ")}`);
} catch (e) {
  echec = true;
  console.error("ÉCHEC :", e);
  if (erreursNavigateur.length) console.error("console du navigateur :", erreursNavigateur);
} finally {
  await navigateur.close();
  await app.close();
  await fauxPawapay.arreter();
  await base.$disconnect();
}
console.log(echec ? "ÉCHEC" : "SUCCÈS");
process.exit(echec ? 1 : 0);
