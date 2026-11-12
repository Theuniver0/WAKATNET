// Paiement (SPEC §7.2, §7.4 P1, P2, P4, P5, P8, P9 ; ADR 0013 ; A5, A7).
// Tickets : .scratch/phase-3-portail-paiement/issues/03-paiements-mock.md, 04-confirmation-credits.md
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { MockProvider } from "../../../packages/payments/src/index.ts";
import { avecApp, routeur, sql, URL_ADMIN } from "./aide.ts";
import { attendreStatut, credits, jeton, numero, soumission, statut, transactionsDe, vendeur, type App } from "./aide-paiement.ts";

const creer = (app: App, v: { publicId: string; plan: string }, scenario: string, s = soumission()) =>
  app.paiement!.creer({ sitePublic: v.publicId, planId: BigInt(v.plan), operateur: "moov_bf", numero: numero(scenario),
                        jetonAppareil: jeton(), soumission: s });

test("cas normal : SUCCEEDED, ticket à copie figée, commission de 10 % au grand livre, une seule fois", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "paiement normal");
    const avant = await credits(v.tenant);
    const r = await creer(app, v, "00");
    assert.equal(r.statut, "cree");
    if (r.statut !== "cree") return;
    await attendreStatut(r.reference, "SUCCEEDED");
    const p = await statut(r.reference);
    const [t] = await sql<{ f_prix_xof: string; f_uptime_limit_s: number; tenant_id: string }>(URL_ADMIN,
      "SELECT f_prix_xof::text, f_uptime_limit_s, tenant_id::text FROM app.voucher WHERE id = $1", [p.voucher_id]);
    assert.deepEqual(t, { f_prix_xof: "200", f_uptime_limit_s: 3600, tenant_id: v.tenant });
    assert.equal(await credits(v.tenant), avant - 20n);
    assert.equal(await transactionsDe(p.id), 1);
    const [tx] = await sql<{ taux_bps: number; nature: string }>(URL_ADMIN,
      "SELECT taux_bps, nature FROM ledger.transaction WHERE objet = $1", [`paiement:${p.id}`]);
    assert.deepEqual(tx, { taux_bps: 1000, nature: "commission" }, "taux figé dans l'écriture (A3)");
  });
});

test("P1 : même webhook reçu 5 fois → un ticket, un jeu d'écritures, un événement", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "P1");
    const r = await creer(app, v, "03");
    if (r.statut !== "cree") assert.fail(r.statut);
    await attendreStatut(r.reference, "SUCCEEDED");
    await new Promise((x) => setTimeout(x, 200));   // laisser passer les 5 livraisons
    const p = await statut(r.reference);
    assert.equal(await transactionsDe(p.id), 1);
    const [e] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.payment_event WHERE payment_id = $1", [p.id]);
    assert.equal(e.n, 1);
    const [vc] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.voucher WHERE tenant_id = $1", [v.tenant]);
    assert.equal(vc.n, 1);
  });
});

test("P2 : webhook reçu AVANT la réponse de charge() → SUCCEEDED, jamais ramené à PENDING", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "P2");
    const r = await creer(app, v, "04");
    if (r.statut !== "cree") assert.fail(r.statut);
    assert.equal(r.statutPaiement, "SUCCEEDED");
    assert.equal((await statut(r.reference)).statut, "SUCCEEDED");
  });
});

test("P4 : montant différent → MISMATCH, pas de ticket, pas d'écriture, alerte", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "P4");
    const avant = await credits(v.tenant);
    const r = await creer(app, v, "05");
    if (r.statut !== "cree") assert.fail(r.statut);
    await attendreStatut(r.reference, "MISMATCH");
    const p = await statut(r.reference);
    assert.equal(p.voucher_id, null);
    assert.equal(await transactionsDe(p.id), 0);
    assert.equal(await credits(v.tenant), avant);
    const a = await sql(URL_ADMIN, "SELECT 1 FROM app.audit_log WHERE action = 'alerte_paiement_mismatch' AND objet = $1", [`paiement:${p.id}`]);
    assert.equal(a.length, 1);
    // MISMATCH est final : un nouveau verify() ne le change pas.
    assert.equal(await app.paiement!.rapprocher(r.reference, BigInt(v.tenant)), "MISMATCH");
  });
});

test("P5 : signature invalide → 401, aucun effet ; webhook inconnu → 404", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "P5");
    const r = await creer(app, v, "07");               // reste PENDING : seul un webhook valide le ferait bouger
    if (r.statut !== "cree") assert.fail(r.statut);
    const mock = new MockProvider(v.secret, null);
    mock.confirmer(r.reference);                     // le fournisseur dit SUCCEEDED…
    const corps = mock.corps(r.reference);
    const avant = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.payment_event");
    for (const enTetes of [{}, { "x-mock-signature": "0".repeat(64) }, { "x-mock-signature": new MockProvider("un-autre-secret-x", null).signer(corps) }]) {
      const x = await app.inject({ method: "POST", url: `/webhooks/mock/${v.webhook}`, headers: { "content-type": "application/json", ...enTetes }, payload: corps });
      assert.equal(x.statusCode, 401);
    }
    // Corps altéré, signature de l'original.
    const altere = Buffer.concat([corps, Buffer.from(" ")]);
    assert.ok(!altere.equals(corps));
    assert.equal((await app.inject({ method: "POST", url: `/webhooks/mock/${v.webhook}`,
      headers: { "content-type": "application/json", "x-mock-signature": mock.signer(corps) }, payload: altere })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: `/webhooks/mock/${"x".repeat(24)}`,
      headers: { "content-type": "application/json", "x-mock-signature": mock.signer(corps) }, payload: corps })).statusCode, 404);
    assert.equal((await statut(r.reference)).statut, "PENDING", "…mais rien n'a bougé sans webhook authentifié");
    const apres = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.payment_event");
    assert.equal(apres[0].n, avant[0].n);
    // Le même webhook, bien signé : SUCCEEDED.
    const ok = await app.inject({ method: "POST", url: `/webhooks/mock/${v.webhook}`,
      headers: { "content-type": "application/json", "x-mock-signature": mock.signer(corps) }, payload: corps });
    assert.equal(ok.statusCode, 200);
    assert.equal((await statut(r.reference)).statut, "SUCCEEDED");
  });
});

test("webhook d'un AUTRE compte marchand portant ma référence : ignoré", async () => {
  await avecApp(async (app) => {
    const A = await vendeur(app, "croisé A");
    const B = await vendeur(app, "croisé B");
    const r = await creer(app, A, "07");
    if (r.statut !== "cree") assert.fail(r.statut);
    const mockB = new MockProvider(B.secret, null);
    const corps = mockB.corps(r.reference);
    const x = await app.inject({ method: "POST", url: `/webhooks/mock/${B.webhook}`,
      headers: { "content-type": "application/json", "x-mock-signature": mockB.signer(corps) }, payload: corps });
    assert.equal(x.statusCode, 200);
    assert.equal(x.json().ignore, "paiement inconnu de ce compte");
    assert.equal((await statut(r.reference)).statut, "PENDING");
  });
});

test("P9 : double soumission (successive et concurrente) → un seul paiement", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "P9");
    const s = soumission();
    const tous = await Promise.all(Array.from({ length: 5 }, () => creer(app, v, "07", s)));
    const encore = await creer(app, v, "07", s);
    const refs = new Set([...tous, encore].map((x) => ("reference" in x ? x.reference : x.statut)));
    assert.equal(refs.size, 1);
    const [n] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.payment WHERE tenant_id = $1", [v.tenant]);
    assert.equal(n.n, 1);
  });
});

test("refus de l'opérateur → FAILED, sans ticket ; fournisseur en panne → CREATED et message clair (P8)", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "refus et panne");
    const r1 = await creer(app, v, "01");
    if (r1.statut !== "cree") assert.fail(r1.statut);
    assert.equal(r1.statutPaiement, "FAILED");
    assert.equal((await statut(r1.reference)).voucher_id, null);
    const r2 = await creer(app, v, "06");
    if (r2.statut !== "cree") assert.fail(r2.statut);
    assert.equal(r2.statutPaiement, "CREATED");
    assert.match(r2.message ?? "", /ne répond pas/);
  });
});

test("vente en ligne refusée : sans compte marchand, propriétaire suspendu, au-delà du découvert ; tickets existants toujours acceptés", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "plafond", { recharge: 0 });
    // Ticket vendu AVANT : il doit rester accepté par RADIUS quoi qu'il arrive aux crédits (ADR 0001).
    const [code] = await sql<{ c: string }>(URL_ADMIN, "SELECT app.voucher_creer($1, $2) AS c", [v.tenant, v.plan]);
    const r = await routeur(v.tenant, v.site);
    await sql(URL_ADMIN, "INSERT INTO radius.router_secret (router_id, secret) VALUES ($1, repeat('s', 32))", [r]);
    const [{ ip }] = await sql<{ ip: string }>(URL_ADMIN, "SELECT host(overlay_ip) AS ip FROM app.router WHERE id = $1", [r]);
    // Découvert : plafond 0 et solde négatif après une vente.
    await sql(URL_ADMIN, "UPDATE app.tenant SET plafond_decouvert = 0 WHERE id = $1", [v.tenant]);
    const p = await creer(app, v, "00");             // solde 0 ≥ −0 : vente permise
    if (p.statut !== "cree") assert.fail(p.statut);
    await attendreStatut(p.reference, "SUCCEEDED");
    assert.equal(await credits(v.tenant), -20n, "la commission passe en découvert : le client a payé");
    assert.equal((await creer(app, v, "00")).statut, "vente_suspendue");
    const [d] = await sql<{ decision: string }>(URL_ADMIN, "SELECT decision FROM radius.authorize($1, $2, '', '')", [code.c, ip]);
    assert.equal(d.decision, "Accept", "ticket existant accepté au plafond (test dû depuis le ticket 1.2)");
    await sql(URL_ADMIN, "UPDATE app.tenant SET plafond_decouvert = 3000, suspendu = true WHERE id = $1", [v.tenant]);
    assert.equal((await creer(app, v, "00")).statut, "vente_suspendue");
    const sans = await vendeur(app, "sans compte", { recharge: 0 });
    await sql(URL_ADMIN, "DELETE FROM app.compte_marchand WHERE tenant_id = $1", [sans.tenant]);
    assert.equal((await creer(app, sans, "00")).statut, "sans_compte_marchand");
  });
});

test("compte marchand : clés jamais rendues ni stockées en clair ; même identifiant de webhook au remplacement", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "clés");
    const [m] = await sql<{ cles: Buffer; webhook_id: string }>(URL_ADMIN, "SELECT cles, webhook_id FROM app.compte_marchand WHERE tenant_id = $1", [v.tenant]);
    assert.ok(!m.cles.includes(Buffer.from(v.secret)), "secret en clair dans la base");
    const r = await app.inject({ method: "PUT", url: "/v1/compte-marchand", headers: { "x-wakatnet-tenant": v.tenant },
                                 payload: { fournisseur: "mock", cles: { secret_webhook: "y".repeat(20) } } });
    assert.ok(!r.body.includes("y".repeat(20)));
    assert.ok(r.json().url_webhook.endsWith(m.webhook_id));
    for (const corps of [{ fournisseur: "inconnu", cles: {} }, { fournisseur: "mock", cles: { secret_webhook: "court" } }]) {
      assert.equal((await app.inject({ method: "PUT", url: "/v1/compte-marchand", headers: { "x-wakatnet-tenant": v.tenant }, payload: corps })).statusCode, 422);
    }
  });
});

test("propriété : statut confirmé ⇔ ticket ⇔ une commission ; soldes = Σ commissions", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "propriété paiements", { recharge: 1_000_000 });
    const avant = await credits(v.tenant);
    const refs: string[] = [];
    await fc.assert(fc.asyncProperty(fc.constantFrom("00", "01", "03", "04", "05"), async (sc) => {
      const r = await creer(app, v, sc);
      if (r.statut === "cree") refs.push(r.reference);
    }), { numRuns: 40 });
    await new Promise((x) => setTimeout(x, 500));
    let confirmes = 0;
    for (const ref of refs) {
      const p = await statut(ref);
      const n = await transactionsDe(p.id);
      if (p.statut === "SUCCEEDED") { confirmes++; assert.ok(p.voucher_id); assert.equal(n, 1); }
      else { assert.equal(p.voucher_id, null); assert.equal(n, 0); }
    }
    assert.equal(await credits(v.tenant), avant - 20n * BigInt(confirmes));
    const [vc] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.voucher WHERE tenant_id = $1", [v.tenant]);
    assert.equal(vc.n, confirmes, "aucun ticket sans paiement confirmé");
  });
});

test("changement de fournisseur refusé tant que des paiements sont ouverts (relecture argent I4)", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "changement fournisseur");
    const r = await creer(app, v, "07");
    if (r.statut !== "cree") assert.fail(r.statut);
    // Seul « mock » existe : la garde est éprouvée en SQL, sous wk_api, avec un autre nom.
    const { URL_API } = await import("./aide.ts");
    const pg = (await import("pg")).default;
    const c = new pg.Client({ connectionString: URL_API });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('wakatnet.tenant_id', $1, true)", [v.tenant]);
      await assert.rejects(c.query("SELECT app.compte_marchand_enregistrer('autre', $1)", [Buffer.alloc(40)]), /paiements encore ouverts/);
      await c.query("ROLLBACK");
    } finally {
      await c.end();
    }
  });
});

test("MockProvider : refusé sans autorisation explicite (relecture argent M4)", () => {
  const avant = process.env.WAKATNET_MOCK;
  delete process.env.WAKATNET_MOCK;
  try {
    assert.throws(() => new MockProvider("x".repeat(20), null), /interdit/);
  } finally {
    process.env.WAKATNET_MOCK = avant;
  }
});

test("A8 : versXof n'accepte que des entiers XOF sûrs", async () => {
  const { versXof } = await import("../../../packages/payments/src/index.ts");
  assert.equal(versXof(1000), 1000);
  assert.equal(versXof("1000"), 1000);
  assert.equal(versXof(0), 0);
  for (const mauvais of [1000.5, -1, "1000.5", "1e3", " 1000", "01000", "", null, undefined, Number.MAX_SAFE_INTEGER + 1, NaN, "abc", {}]) {
    assert.throws(() => versXof(mauvais), TypeError, String(mauvais));
  }
});

test("A8 : montant illisible du fournisseur (décimal) → MISMATCH, ni ticket ni écriture", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "A8 illisible");
    const r = await creer(app, v, "09");
    if (r.statut !== "cree") assert.fail(r.statut);
    await attendreStatut(r.reference, "MISMATCH");
    const p = await statut(r.reference);
    assert.equal(p.voucher_id, null);
    assert.equal(await transactionsDe(p.id), 0);
  });
});

test("forfait FIGÉ à l'achat : modifié avant la confirmation, le ticket donne ce qui a été payé", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "forfait figé");
    const r = await creer(app, v, "07");
    if (r.statut !== "cree") assert.fail(r.statut);
    await sql(URL_ADMIN, "UPDATE app.plan SET prix_xof = 999, uptime_limit_s = 60 WHERE id = $1", [v.plan]);
    new MockProvider(v.secret, null).confirmer(r.reference);
    assert.equal(await app.paiement!.rapprocher(r.reference, BigInt(v.tenant)), "SUCCEEDED");
    const [t] = await sql<{ f_prix_xof: string; f_uptime_limit_s: number }>(URL_ADMIN,
      "SELECT v.f_prix_xof::text, v.f_uptime_limit_s FROM app.voucher v JOIN app.payment p ON p.voucher_id = v.id WHERE p.reference = $1", [r.reference]);
    assert.deepEqual(t, { f_prix_xof: "200", f_uptime_limit_s: 3600 });
  });
});

test("limites de demandes : 3 par numéro et par site sur 10 min, 5 par appareil", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "limites demandes");
    const num = numero("07");
    const essais = [];
    for (let i = 0; i < 4; i++) {
      essais.push(await app.paiement!.creer({ sitePublic: v.publicId, planId: BigInt(v.plan), operateur: "moov_bf", numero: num,
                                              jetonAppareil: jeton(), soumission: soumission() }));
    }
    assert.deepEqual(essais.map((e) => e.statut), ["cree", "cree", "cree", "trop_de_demandes"]);
    const j = jeton();
    const parAppareil = [];
    for (let i = 0; i < 6; i++) {
      parAppareil.push((await app.paiement!.creer({ sitePublic: v.publicId, planId: BigInt(v.plan), operateur: "moov_bf",
                                                    numero: numero("07"), jetonAppareil: j, soumission: soumission() })).statut);
    }
    assert.deepEqual(parAppareil, ["cree", "cree", "cree", "cree", "cree", "trop_de_demandes"]);
  });
});

test("rechargement : idempotent sur sa référence ; alerte « crédits bas » une seule fois sous 20 %", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "rechargement", { recharge: 0, prix: 1000 });
    for (let i = 0; i < 3; i++) await sql(URL_ADMIN, "SELECT app.credits_recharger($1, 500, $2)", [v.tenant, `ref-idem-${v.tenant}`]);
    assert.equal(await credits(v.tenant), 500n, "trois appels, un seul rechargement");
    // 1 vente à 1 000 F : commission 100 F, solde 400 F = 80 % : pas d'alerte ; 4 ventes de plus : 0 F.
    for (let i = 0; i < 5; i++) {
      const r = await creer(app, v, "00");
      if (r.statut !== "cree") assert.fail(r.statut);
      await attendreStatut(r.reference, "SUCCEEDED");
    }
    assert.equal(await credits(v.tenant), 0n);
    const a = await sql(URL_ADMIN, "SELECT 1 FROM app.audit_log WHERE tenant_id = $1 AND action = 'alerte_credits_bas'", [v.tenant]);
    assert.equal(a.length, 1);
  });
});

test("erreurs internes : jamais de détail dans la réponse (portail en HTML, ailleurs en JSON)", async () => {
  const { construire } = await import("../src/app.ts");
  const { ouvrirBase } = await import("../src/base.ts");
  const { config } = await import("./aide.ts");
  const base = ouvrirBase(config().urlBase);
  const app = construire(config(), base, { journal: false });
  app.get("/p/essai-erreur/x", async () => { throw new Error("Can't reach database server at 10.0.0.9:5432 secret-interne"); });
  app.get("/v1/essai-erreur", async () => { throw new Error("Raw query failed secret-interne"); });
  try {
    for (const url of ["/p/essai-erreur/x", "/v1/essai-erreur"]) {
      const r = await app.inject({ url, headers: { "x-wakatnet-tenant": "1" } });
      assert.ok(r.statusCode >= 400);
      assert.ok(!r.body.includes("secret-interne") && !r.body.includes("10.0.0.9"), r.body);
    }
    assert.match((await app.inject({ url: "/p/essai-erreur/x" })).headers["content-type"] as string, /text\/html/);
  } finally {
    await app.close();
    await base.$disconnect();
  }
});
