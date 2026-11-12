// Tâche périodique (SPEC §7.4 P3, P7, P8 ; ADR 0002 ; ADR 0013 §6).
// Ticket : .scratch/phase-3-portail-paiement/issues/05-rapprochement.md
import assert from "node:assert/strict";
import { test } from "node:test";
import { MockProvider } from "../../../packages/payments/src/index.ts";
import { tour } from "../src/taches.ts";
import { avecApp, sql, URL_ADMIN } from "./aide.ts";
import { credits, jeton, numero, soumission, statut, transactionsDe, vendeur, type App } from "./aide-paiement.ts";

const creer = (app: App, v: { publicId: string; plan: string }, sc: string) =>
  app.paiement!.creer({ sitePublic: v.publicId, planId: BigInt(v.plan), operateur: "orange_bf", numero: numero(sc),
                        otp: "123456", jetonAppareil: jeton(), soumission: soumission() });

/** Rend le paiement « dû » pour le rapprochement (au lieu d'attendre 2 min). */
const echeance = (ref: string) => sql(URL_ADMIN,
  "UPDATE app.payment SET prochaine_verif_le = now() - interval '1 second' WHERE reference = $1", [ref]);
const expirer = (ref: string) => sql(URL_ADMIN,
  "UPDATE app.payment SET expire_le = now() - interval '1 second' WHERE reference = $1", [ref]);

test("P3 : webhook jamais reçu → ticket créé par le rapprochement, première vérification à 2 min", async () => {
  await avecApp(async (app, base) => {
    const v = await vendeur(app, "P3");
    const r = await creer(app, v, "02");
    if (r.statut !== "cree") assert.fail(r.statut);
    await new Promise((x) => setTimeout(x, 200));
    assert.equal((await statut(r.reference)).statut, "PENDING", "aucun webhook");
    const [{ d }] = await sql<{ d: number }>(URL_ADMIN,
      "SELECT extract(epoch FROM prochaine_verif_le - cree_le)::int AS d FROM app.payment WHERE reference = $1", [r.reference]);
    assert.equal(d, 120, "première vérification à 2 min : ticket en moins de 5 min");
    assert.equal((await tour(base, app.paiement!)).verifies, 0, "pas encore dû");
    await echeance(r.reference);
    const b = await tour(base, app.paiement!);
    assert.ok(b.verifies >= 1);
    const p = await statut(r.reference);
    assert.equal(p.statut, "SUCCEEDED");
    assert.ok(p.voucher_id);
    assert.equal(await transactionsDe(p.id), 1);
    const [{ d2 }] = await sql<{ d2: number }>(URL_ADMIN,
      "SELECT round(extract(epoch FROM prochaine_verif_le - now()))::int AS d2 FROM app.payment WHERE reference = $1", [r.reference]);
    assert.ok(d2 > 290 && d2 <= 300, `replanifié à 5 min (${d2} s)`);
  });
});

test("P7 : délai du portail dépassé → EXPIRED ; succès ensuite → ticket créé et journalisé", async () => {
  await avecApp(async (app, base) => {
    const v = await vendeur(app, "P7");
    const r = await creer(app, v, "07");
    if (r.statut !== "cree") assert.fail(r.statut);
    await expirer(r.reference);
    assert.ok((await tour(base, app.paiement!)).expires >= 1);
    assert.equal((await statut(r.reference)).statut, "EXPIRED");
    new MockProvider(v.secret, null).confirmer(r.reference);   // le fournisseur confirme… après l'expiration
    await echeance(r.reference);
    await tour(base, app.paiement!);
    const p = await statut(r.reference);
    assert.equal(p.statut, "SUCCEEDED");
    assert.ok(p.voucher_id, "ticket créé quand même (§7.2)");
    const j = await sql(URL_ADMIN, "SELECT 1 FROM app.audit_log WHERE action = 'paiement_succes_apres_expiration' AND objet = $1", [`paiement:${p.id}`]);
    assert.equal(j.length, 1);
  });
});

test("P8 : fournisseur en panne → message clair, jamais confirmé sans verdict ; RADIUS n'en dépend pas (C1, matrice T)", async () => {
  await avecApp(async (app, base) => {
    const v = await vendeur(app, "P8");
    const r = await creer(app, v, "06");
    if (r.statut !== "cree") assert.fail(r.statut);
    assert.match(r.message ?? "", /ne répond pas/);
    assert.equal((await statut(r.reference)).statut, "CREATED");
    await expirer(r.reference);
    await tour(base, app.paiement!);
    assert.equal((await statut(r.reference)).statut, "EXPIRED", "jamais confirmé sans verdict du fournisseur");
  });
});

test("frais papier (ADR 0002) : prélevé à l'activation, une seule fois, jamais sur une vente en ligne", async () => {
  await avecApp(async (app, base) => {
    const v = await vendeur(app, "frais papier", { prix: 300 });
    const [{ c: papier }] = await sql<{ c: string }>(URL_ADMIN, "SELECT app.voucher_creer($1, $2) AS c", [v.tenant, v.plan]);
    const [{ c: inactif }] = await sql<{ c: string }>(URL_ADMIN, "SELECT app.voucher_creer($1, $2) AS c", [v.tenant, v.plan]);
    void inactif;
    const r = await creer(app, v, "00");
    if (r.statut !== "cree") assert.fail(r.statut);
    await new Promise((x) => setTimeout(x, 300));
    const enLigne = await statut(r.reference);
    assert.equal(enLigne.statut, "SUCCEEDED");
    // Activation (premier Start, ticket 04 de la phase 1) du ticket papier ET du ticket vendu en ligne.
    await sql(URL_ADMIN, "UPDATE app.voucher SET activated_at = now() WHERE tenant_id = $1 AND (code = $2 OR id = $3)",
              [v.tenant, papier, enLigne.voucher_id]);
    const avant = await credits(v.tenant);
    await tour(base, app.paiement!);
    await tour(base, app.paiement!);
    assert.equal(await credits(v.tenant), avant - 30n, "10 % de 300 F, une seule fois ; rien sur la vente en ligne ni sur le ticket inactif");
    const [{ id }] = await sql<{ id: string }>(URL_ADMIN, "SELECT id::text FROM app.voucher WHERE tenant_id = $1 AND code = $2", [v.tenant, papier]);
    const [tx] = await sql<{ taux_bps: number; minimum: string }>(URL_ADMIN,
      "SELECT taux_bps, minimum::text FROM ledger.transaction WHERE cle = $1", [`frais_papier:voucher:${id}`]);
    assert.deepEqual(tx, { taux_bps: 1000, minimum: "10" }, "taux et plancher figés");
  });
});

test("frais papier en découvert : le ticket s'active quand même, le frais passe en découvert", async () => {
  await avecApp(async (app, base) => {
    const v = await vendeur(app, "frais découvert", { prix: 50, recharge: 0 });
    const [{ c }] = await sql<{ c: string }>(URL_ADMIN, "SELECT app.voucher_creer($1, $2) AS c", [v.tenant, v.plan]);
    await sql(URL_ADMIN, "UPDATE app.voucher SET activated_at = now() WHERE tenant_id = $1 AND code = $2", [v.tenant, c]);
    await tour(base, app.paiement!);
    assert.equal(await credits(v.tenant), -10n, "plancher de 10 F sur un forfait à 50 F");
  });
});

test("frais papier : jamais rétroactifs, et un frais nul ne bloque pas les suivants (relecture argent I2, I3)", async () => {
  await avecApp(async (app, base) => {
    const v = await vendeur(app, "frais famine", { prix: 300 });
    const [{ id: gratuit }] = await sql<{ id: string }>(URL_ADMIN,
      "INSERT INTO app.plan (tenant_id, nom, prix_xof, uptime_limit_s) VALUES ($1, 'essai', 0, 600) RETURNING id::text", [v.tenant]);
    await sql(URL_ADMIN, "UPDATE app.tenant SET offline_fee_min = 0 WHERE id = $1", [v.tenant]);
    // 600 tickets gratuits activés : frais nul, ils ne doivent plus encombrer chaque tour.
    await sql(URL_ADMIN, "SELECT app.voucher_creer($1, $2) FROM generate_series(1, 600)", [v.tenant, gratuit]);
    await sql(URL_ADMIN, "UPDATE app.voucher SET activated_at = now() WHERE tenant_id = $1", [v.tenant]);
    const [{ c: payant }] = await sql<{ c: string }>(URL_ADMIN, "SELECT app.voucher_creer($1, $2) AS c", [v.tenant, v.plan]);
    const [{ c: ancien }] = await sql<{ c: string }>(URL_ADMIN, "SELECT app.voucher_creer($1, $2) AS c", [v.tenant, v.plan]);
    await sql(URL_ADMIN, "UPDATE app.voucher SET activated_at = now() WHERE tenant_id = $1 AND code = $2", [v.tenant, payant]);
    // Activé AVANT la mise en service des frais de ce propriétaire : jamais facturé.
    await sql(URL_ADMIN, "UPDATE app.voucher SET activated_at = now() - interval '1 day' WHERE tenant_id = $1 AND code = $2", [v.tenant, ancien]);
    const avant = await credits(v.tenant);
    await tour(base, app.paiement!);
    assert.equal(await credits(v.tenant), avant - 30n);
  });
});

test("numéro du payeur en clair purgé à sa date (ADR 0005 §2) ; HMAC et forme masquée conservés", async () => {
  await avecApp(async (app, base) => {
    const v = await vendeur(app, "purge numéro");
    const r = await creer(app, v, "07");
    if (r.statut !== "cree") assert.fail(r.statut);
    await sql(URL_ADMIN, "UPDATE app.payment SET purge_numero_le = now() - interval '1 second' WHERE reference = $1", [r.reference]);
    assert.ok((await tour(base, app.paiement!)).purges >= 1);
    const [p] = await sql<{ clair: string | null; masque: string; hmac: boolean }>(URL_ADMIN,
      "SELECT numero_clair AS clair, numero_masque AS masque, numero_hmac IS NOT NULL AS hmac FROM app.payment WHERE reference = $1", [r.reference]);
    assert.equal(p.clair, null);
    assert.match(p.masque, /^70 •• •• \d{2}$/);
    assert.equal(p.hmac, true);
  });
});

test("fournisseur muet sur verify() : le tour reste borné, replanifie, et traite les autres paiements", async () => {
  await avecApp(async (app, base) => {
    const v = await vendeur(app, "fournisseur muet");
    const muet = await creer(app, v, "08");
    const normal = await creer(app, v, "02");
    if (muet.statut !== "cree" || normal.statut !== "cree") assert.fail("création");
    await sql(URL_ADMIN, "UPDATE app.payment SET prochaine_verif_le = now() - interval '1 hour' WHERE reference = $1", [muet.reference]);
    await echeance(normal.reference);
    const debut = Date.now();
    const b = await tour(base, app.paiement!, () => {}, 30_000);
    assert.ok(Date.now() - debut < 15_000, `tour borné par le délai de verify (${Date.now() - debut} ms)`);
    assert.equal(b.erreurs, 1);
    assert.equal((await statut(normal.reference)).statut, "SUCCEEDED", "le paiement suivant n'est pas affamé");
    const [{ d }] = await sql<{ d: number }>(URL_ADMIN,
      "SELECT round(extract(epoch FROM prochaine_verif_le - now()))::int AS d FROM app.payment WHERE reference = $1", [muet.reference]);
    assert.ok(d > 280, "le paiement muet est replanifié, plus en tête de file");
  });
});

test("propriété : N tours de la tâche → un seul frais par ticket papier activé", async () => {
  const fc = (await import("fast-check")).default;
  await avecApp(async (app, base) => {
    const v = await vendeur(app, "frais propriété", { prix: 300 });
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 3 }), async (tickets, tours) => {
      const avant = await credits(v.tenant);
      for (let i = 0; i < tickets; i++) {
        const [{ c }] = await sql<{ c: string }>(URL_ADMIN, "SELECT app.voucher_creer($1, $2) AS c", [v.tenant, v.plan]);
        await sql(URL_ADMIN, "UPDATE app.voucher SET activated_at = now() WHERE tenant_id = $1 AND code = $2", [v.tenant, c]);
      }
      for (let i = 0; i < tours; i++) await tour(base, app.paiement!);
      assert.equal(await credits(v.tenant), avant - 30n * BigInt(tickets));
    }), { numRuns: 8 });
  });
});
