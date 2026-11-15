// Adaptateur MoneyFusion (ADR 0024) : code d'argent, donc faux serveur aux formes de la documentation officielle et cas
// limites (règle 4). Aucun bac à sable n'existe : le premier essai réel se fera après G-ARGENT, avec de petits montants.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { FournisseurIndisponible, MoneyfusionProvider, PaiementRefuse, SignatureInvalide } from "../../../packages/payments/src/index.ts";
import { creerFournisseur, FournisseurInconnu, validerCles } from "../src/fournisseurs.ts";
import { avecApp, entetes, proprietaire, sql, URL_ADMIN } from "./aide.ts";
import { FauxMoneyfusion } from "./aide-moneyfusion.ts";

const reference = () => `wk_${randomBytes(16).toString("base64url")}`;
let faux: FauxMoneyfusion;
before(async () => { faux = await new FauxMoneyfusion().demarrer(); });
after(async () => { await faux.arreter(); });
const WEBHOOK = "https://api.test.invalid/webhooks/moneyfusion/AAAAAAAAAAAAAAAAAAAAAAAA";
const fournisseur = (lien = faux.lien()) => new MoneyfusionProvider({ lienApi: lien }, {
  urlWebhook: WEBHOOK, urlStatut: `${faux.url}/paiementNotif/`, formeUrlPaiement: new RegExp(`^${faux.url.replace(/[.]/g, "\\.")}/payment/[a-f0-9]+$`) });
const demande = (ref = reference()) => ({ reference: ref, montant: 200, devise: "XOF" as const, operateur: "orange_bf" as const,
                                          numero: "73394446", urlRetour: `https://portail.test.invalid/p/S/achat/${ref}` });

async function avecEnv<T>(env: Record<string, string | undefined>, f: () => Promise<T> | T): Promise<T> {
  const avant = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await f(); } finally {
    for (const [k, v] of Object.entries(avant)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("paiement : corps conforme à la documentation (totalPrice, article, personal_Info avec notre référence, numéro, retour, webhook) ; jeton et page rendus", async () => {
  const d = demande();
  const r = await fournisseur().charge(d);
  assert.equal(r.statut, "PENDING");
  assert.match(r.referenceFournisseur, /^[a-f0-9]{20}$/);
  assert.equal(r.urlPaiement, `${faux.url}/payment/${r.referenceFournisseur}`);
  const q = faux.requetes.at(-1)!;
  assert.equal(q.methode, "POST");
  assert.deepEqual(q.corps, { totalPrice: 200, article: [{ "Forfait WiFi": 200 }], personal_Info: [{ reference: d.reference }],
    numeroSend: "73394446", nomclient: "Client WiFi", return_url: d.urlRetour, webhook_url: WEBHOOK });
});

test("paiement : valeurs refusées avant tout appel ; refus et pannes de MoneyFusion → indisponible (aucune page remise, aucun argent ne bouge)", async () => {
  const n = faux.requetes.length;
  for (const m of [99, 200.5, 2_000_001]) await assert.rejects(fournisseur().charge({ ...demande(), montant: m }), PaiementRefuse, String(m));
  await assert.rejects(fournisseur().charge({ ...demande(), reference: "wk_court" }), PaiementRefuse);
  await assert.rejects(fournisseur().charge({ ...demande(), numero: "7339444" }), PaiementRefuse);
  await assert.rejects(fournisseur().charge({ ...demande(), urlRetour: undefined }), FournisseurIndisponible, "page de retour exigée");
  await assert.rejects(new MoneyfusionProvider({ lienApi: faux.lien() }).charge(demande()), FournisseurIndisponible, "webhook exigé");
  assert.equal(faux.requetes.length, n, "aucun appel pour une demande invalide");
  // IP non déclarée (message documenté) : refus de MoneyFusion.
  faux.prochaineReponse = { statut: 200, corps: { statut: false, message: "IP non autorisée ou application non approuvée (127.0.0.1)" } };
  await assert.rejects(fournisseur().charge(demande()), /IP non autorisée/);
  faux.prochaineReponse = { statut: 500, corps: {} };
  await assert.rejects(fournisseur().charge(demande()), FournisseurIndisponible);
  // Redirection ouverte : une page de paiement hors du domaine attendu n'est jamais rendue au portail.
  faux.prochaineReponse = { statut: 200, corps: { statut: true, token: "abcdef12", message: "ok", url: "https://piege.exemple/payment/abcdef12" } };
  await assert.rejects(fournisseur().charge(demande()), /page de paiement inattendue/);
  faux.prochaineReponse = { statut: 200, corps: { statut: true, token: "a b\"c", message: "ok", url: `${faux.url}/payment/abc` } };
  await assert.rejects(fournisseur().charge(demande()), /jeton/);
  await assert.rejects(new MoneyfusionProvider({ lienApi: "http://127.0.0.1:1/api/x" }, { urlWebhook: WEBHOOK }).charge(demande()), FournisseurIndisponible, "injoignable");
});

test("statut : paid → SUCCEEDED avec Montant ; failure → FAILED ; pending et « no paid » → en attente ; inconnu, jeton ou référence étrangers → indisponible (jamais un échec à tort)", async () => {
  const f = fournisseur();
  const d = demande();
  const { referenceFournisseur: t } = await f.charge(d);
  const p = faux.paiements.get(t)!;
  assert.deepEqual(await f.verify(d.reference, t), { reference: d.reference, referenceFournisseur: t, statut: "PENDING", montant: 200, devise: "XOF" });
  p.statut = "no paid"; assert.equal((await f.verify(d.reference, t)).statut, "PENDING");
  p.statut = "failure"; assert.equal((await f.verify(d.reference, t)).statut, "FAILED");
  // Relecture n° 2 : la devise n'est « XOF » que pour un moyen du Burkina ; autre moyen → « ? » → MISMATCH (A8).
  p.moyen = "orange";
  p.statut = "paid"; assert.deepEqual(await f.verify(d.reference, t), { reference: d.reference, referenceFournisseur: t, statut: "SUCCEEDED", montant: 200, devise: "?" },
    "moyen « orange » sans pays (exemple de la documentation) : devise inconnue, donc écart et jamais un ticket");
  for (const m of ["orange-gn", "mtn-cm", ""]) { p.moyen = m; assert.equal((await f.verify(d.reference, t)).devise, "?", m); }
  p.moyen = "moov-burkina-faso";
  assert.equal((await f.verify(d.reference, t)).devise, "XOF");
  p.statut = "rembourse"; await assert.rejects(f.verify(d.reference, t), /statut inattendu/);
  p.statut = "paid";
  await assert.rejects(f.verify(reference(), t), /référence inattendue/, "statut d'un AUTRE paiement : jamais appliqué au nôtre");
  await assert.rejects(f.verify(d.reference, "inconnu123"), FournisseurIndisponible, "404 : indisponible, pas FAILED");
  await assert.rejects(f.verify(d.reference, "a/../b"), /jeton enregistré invalide/);
  await assert.rejects(f.verify(d.reference, undefined), /jeton pas encore noté/,
    "relecture, bloquant n° 1 : sans jeton, jamais PENDING (le jeton noté ensuite par charge() serait perdu)");
});

test("webhook : non signé, il ne garde que le jeton et notre référence ; corps illisible ou inattendu → refusé sans effet", () => {
  const f = fournisseur();
  const ref = reference();
  const corps = (o: unknown) => Buffer.from(JSON.stringify(o));
  assert.deepEqual(f.parseWebhook({}, corps({ event: "payin.session.completed", tokenPay: "abc12345", personal_Info: [{ reference: ref }], Montant: 1 })),
    { idEvenement: "payin.session.completed:abc12345", reference: ref, referenceFournisseur: "abc12345" });
  assert.equal((f.parseWebhook({}, corps({ event: "payin.session.pending", tokenPay: "abc12345", personal_Info: [{ reference: "pas-a-nous" }] }))).reference, "",
    "référence étrangère : le service cherche par le jeton, pour CE compte");
  for (const c of [Buffer.from("{"), corps([]), corps({ event: "autre", tokenPay: "abc12345" }), corps({ event: "payin.session.completed" }),
                   corps({ event: "payin.session.completed", tokenPay: "x\"y" })]) {
    assert.throws(() => f.parseWebhook({}, c), SignatureInvalide);
  }
});

test("compte marchand : vrai lien refusé avant G-ARGENT (pas de bac à sable) ; forme du lien ; faux serveur local seulement, jamais en production", async () => {
  const vrai = "https://www.pay.moneyfusion.net/WAKATNET/abc123def/pay/";
  await avecEnv({ WAKATNET_MONEYFUSION_URL: undefined, WAKATNET_ARGENT_REEL: undefined }, () => {
    assert.throws(() => validerCles("moneyfusion", { lien_api: vrai }), /G-ARGENT/);
    assert.throws(() => creerFournisseur("moneyfusion", { lien_api: vrai }, null), /G-ARGENT/, "même un compte déjà enregistré");
  });
  await avecEnv({ WAKATNET_MONEYFUSION_URL: undefined, WAKATNET_ARGENT_REEL: "1" }, () => {
    assert.deepEqual(validerCles("moneyfusion", { lien_api: vrai }), { lien_api: vrai });
    for (const l of ["http://pay.moneyfusion.net/x", "https://moneyfusion.net.piege.exemple/x", "https://pay.moneyfusion.net/a b", 42, undefined]) {
      assert.throws(() => validerCles("moneyfusion", { lien_api: l }), FournisseurInconnu, String(l));
    }
  });
  await avecEnv({ WAKATNET_MONEYFUSION_URL: "https://ailleurs.exemple" }, () => {
    assert.throws(() => validerCles("moneyfusion", { lien_api: "https://ailleurs.exemple/api/x" }), /faux serveur local/);
  });
  await avecEnv({ WAKATNET_MONEYFUSION_URL: faux.url, NODE_ENV: "production" }, () => {
    assert.throws(() => validerCles("moneyfusion", { lien_api: faux.lien() }), /faux serveur local/);
  });
  await avecEnv({ WAKATNET_MONEYFUSION_URL: faux.url }, () => {
    assert.throws(() => validerCles("moneyfusion", { lien_api: vrai }), /faux serveur de test/, "un vrai lien ne part jamais vers le faux serveur");
  });
  for (const ancien of ["pawapay", "cinetpay"]) assert.throws(() => validerCles(ancien, {}), /fournisseur inconnu/, `${ancien} retiré`);
});

test("bout en bout : portail → page MoneyFusion → retour ; webhook seul sans effet (A5), puis payé → ticket ; montant différent → écart ; rapprochement sans webhook", async () => {
  await avecEnv({ WAKATNET_MONEYFUSION_URL: faux.url }, () => avecApp(async (app) => {
    const p = await proprietaire("MoneyFusion bout en bout");
    const [plan] = await sql<{ id: string }>(URL_ADMIN,
      "INSERT INTO app.plan (tenant_id, nom, prix_xof, uptime_limit_s) VALUES ($1, '1 heure', 200, 3600) RETURNING id::text", [p.tenant]);
    const [s] = await sql<{ public_id: string }>(URL_ADMIN, "UPDATE app.site SET hotspot_hotes = '{10.5.50.1}' WHERE id = $1 RETURNING public_id", [p.site]);
    await sql(URL_ADMIN, "SELECT app.credits_recharger($1, 10000, $2)", [p.tenant, `mf-${p.tenant}`]);
    const r = await app.inject({ method: "PUT", url: "/v1/compte-marchand", headers: entetes(p.tenant),
                                 payload: { fournisseur: "moneyfusion", cles: { lien_api: faux.lien() } } });
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(Array.isArray(r.json().ips_serveurs) && r.json().ips_serveurs.length > 0, "IP des nœuds à déclarer chez MoneyFusion");
    assert.equal(r.json().url_portail, "https://portail.test.invalid");
    assert.ok(!r.body.includes("/api/"), "le lien API n'est jamais rendu");
    const chemin = new URL(r.json().url_webhook).pathname;
    assert.match(chemin, /^\/webhooks\/moneyfusion\/[A-Za-z0-9_-]{24}$/);

    // Portail : formulaire sans code OTP, puis redirection vers la page hébergée de MoneyFusion.
    const f = await app.inject({ url: `/p/${s.public_id}/payer?plan=${plan.id}` });
    assert.equal(f.statusCode, 200);
    assert.ok(!f.body.includes('name="otp"'), "plus de code OTP sur le portail");
    const cookie = String(f.headers["set-cookie"]).split(";")[0];
    const soum = /name="soumission" value="([A-Za-z0-9_-]+)"/.exec(f.body)![1];
    const achat = await app.inject({ method: "POST", url: `/p/${s.public_id}/payer`, headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ l: "http://10.5.50.1/login", plan: plan.id, soumission: soum, operateur: "orange_bf", numero: "07345678" }).toString() });
    assert.equal(achat.statusCode, 303, achat.body);
    const t = /\/payment\/([a-f0-9]+)$/.exec(String(achat.headers.location))![1];
    assert.equal(String(achat.headers.location), `${faux.url}/payment/${t}`);
    const pf = faux.paiements.get(t)!;
    const ref = (pf.corps.personal_Info as { reference: string }[])[0].reference;
    assert.equal(pf.corps.return_url, `https://portail.test.invalid/p/${s.public_id}/achat/${ref}?l=${encodeURIComponent("http://10.5.50.1/login")}`);
    const [ligne] = await sql<{ statut: string; rf: string }>(URL_ADMIN, "SELECT statut, reference_fournisseur AS rf FROM app.payment WHERE reference = $1", [ref]);
    assert.deepEqual(ligne, { statut: "PENDING", rf: t }, "jeton noté avant que le client ne paie");

    // Webhook « completed » alors que MoneyFusion dit encore « pending » : aucun effet (A5 : seul le statut fait foi).
    const faussement = await app.inject({ method: "POST", url: chemin, headers: { "content-type": "application/json" }, payload: faux.webhook(t) });
    assert.equal(faussement.statusCode, 200, faussement.body);
    assert.equal(faussement.json().statut, "PENDING");
    assert.equal((await app.inject({ method: "POST", url: chemin, headers: { "content-type": "application/json" }, payload: "pas du json" })).statusCode, 401);

    // Relecture n° 3 : faux événement portant un AUTRE jeton pour ce paiement → 401, rien conservé ; paiement inconnu →
    // rien conservé non plus.
    const evenements = async () => (await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM app.payment_event WHERE fournisseur = 'moneyfusion'"))[0].n;
    const avant = await evenements();
    const autreJeton = JSON.stringify({ event: "payin.session.completed", tokenPay: "deadbeef1234", personal_Info: [{ reference: ref }] });
    assert.equal((await app.inject({ method: "POST", url: chemin, headers: { "content-type": "application/json" }, payload: autreJeton })).statusCode, 401);
    const inconnu = JSON.stringify({ event: "payin.session.completed", tokenPay: "deadbeef1234", personal_Info: [{ reference: `wk_${"Z".repeat(22)}` }] });
    assert.equal((await app.inject({ method: "POST", url: chemin, headers: { "content-type": "application/json" }, payload: inconnu })).json().ignore, "paiement inconnu de ce compte");
    assert.equal(await evenements(), avant, "aucun corps conservé pour ces deux webhooks");

    pf.statut = "paid";
    const vrai = await app.inject({ method: "POST", url: chemin, headers: { "content-type": "application/json" }, payload: faux.webhook(t) });
    assert.equal(vrai.json().statut, "SUCCEEDED", vrai.body);
    const [paye] = await sql<{ statut: string; voucher: boolean; montant: string }>(URL_ADMIN,
      "SELECT statut, voucher_id IS NOT NULL AS voucher, montant::text FROM app.payment WHERE reference = $1", [ref]);
    assert.deepEqual(paye, { statut: "SUCCEEDED", voucher: true, montant: "200" });

    // Second achat : MoneyFusion confirme un AUTRE montant (net de frais, par exemple) → écart, aucun ticket (A8).
    const second = await app.paiement!.creer({ sitePublic: s.public_id, planId: BigInt(plan.id), operateur: "moov_bf", numero: "02345678",
      jetonAppareil: randomBytes(32), soumission: randomBytes(16).toString("base64url"), urlRetour: (x) => `https://portail.test.invalid/p/${s.public_id}/achat/${x}` });
    if (second.statut !== "cree") assert.fail(second.statut);
    assert.ok(second.urlPaiement);
    const t2 = /\/payment\/([a-f0-9]+)$/.exec(second.urlPaiement!)![1];
    Object.assign(faux.paiements.get(t2)!, { statut: "paid", Montant: 195 });
    // Sans webhook : la tâche périodique relit le jeton en base et interroge MoneyFusion.
    assert.equal(await app.paiement!.rapprocher(second.reference, BigInt(p.tenant)), "MISMATCH");
    const [ecart] = await sql<{ voucher: boolean }>(URL_ADMIN, "SELECT voucher_id IS NOT NULL AS voucher FROM app.payment WHERE reference = $1", [second.reference]);
    assert.equal(ecart.voucher, false);
  }));
});
