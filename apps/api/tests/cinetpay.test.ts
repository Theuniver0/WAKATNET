// Adaptateur CinetPay v1, paiement direct (ADR 0022) : code d'argent, donc tests de propriétés (règle 4) et faux serveur
// aux formes du SDK officiel cinetpay-js 0.1.1. Le vrai bac à sable reste à jouer avec les clés de Yacouba.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import fc from "fast-check";
import { CinetpayProvider, CompteInvalide, FournisseurIndisponible, MONTANT_AU_STATUT_CONFIRME, PaiementRefuse, SignatureInvalide,
         montantCinetpay } from "../../../packages/payments/src/index.ts";
import { creerFournisseur, validerCles, FournisseurInconnu } from "../src/fournisseurs.ts";
import { avecApp, entetes, proprietaire, sql, URL_ADMIN } from "./aide.ts";
import { jeton, soumission } from "./aide-paiement.ts";
import { CLE_TEST, FauxCinetpay, MDP_TEST } from "./aide-cinetpay.ts";

const reference = () => `wk_${randomBytes(16).toString("base64url")}`;
const WEBHOOK = "https://api.wakatnet.invalid/webhooks/cinetpay/ABCDEFGHIJKLMNOPQRSTUVWX";
let faux: FauxCinetpay;
before(async () => { faux = await new FauxCinetpay().demarrer(); });
after(async () => { await faux.arreter(); });
const fournisseur = (o: { cle?: string; urlWebhook?: string | null } = {}) => new CinetpayProvider(
  { cleApi: o.cle ?? CLE_TEST, motDePasseApi: MDP_TEST, environnement: "sandbox" },
  { urlBase: faux.url, ...(o.urlWebhook === null ? {} : { urlWebhook: o.urlWebhook ?? WEBHOOK, urlRetour: "https://api.wakatnet.invalid" }) });
const demande = (o: Partial<Parameters<CinetpayProvider["charge"]>[0]> = {}) => ({
  reference: reference(), montant: 200, devise: "XOF" as const, operateur: "orange_bf" as const, numero: "07345678", otp: "367025", ...o });

test("propriété : montant rendu par CinetPay → XOF entier (nombre, « 100 », « 100.00 ») ; absent, décimal ou étrange → -1 (écart)", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 10 ** 12 }), fc.integer({ min: 0, max: 3 }), (n, zeros) => {
    assert.equal(montantCinetpay(n), n);
    assert.equal(montantCinetpay(zeros === 0 ? String(n) : `${n}.${"0".repeat(zeros)}`), n);
  }), { numRuns: 500 });
  fc.assert(fc.property(fc.integer({ min: 0, max: 10 ** 9 }), fc.integer({ min: 1, max: 99 }), (n, c) => {
    assert.equal(montantCinetpay(`${n}.${String(c).padStart(2, "0")}`), -1);
    assert.equal(montantCinetpay(n + c / 100), -1);
  }), { numRuns: 300 });
  for (const v of [-5, 1.5, Number.MAX_SAFE_INTEGER + 2, "", "01", "-5", "1e3", " 100", "100.", null, undefined, "100,00", {}]) {
    assert.equal(montantCinetpay(v), -1, String(v));
  }
});

test("paiement Orange : connexion OAuth, corps du SDK (OM_BF, OTP, +226, direct_pay, notify_url, référence) → en attente ; rejoué → TRANSACTION_EXIST, en attente", async () => {
  const d = demande();
  const r = await fournisseur().charge(d);
  assert.equal(r.statut, "PENDING");
  const t = faux.transactions.get(d.reference)!;
  assert.equal(r.referenceFournisseur, t.transaction_id);
  const login = faux.requetes.find((x) => x.chemin === "/v1/oauth/login")!;
  assert.deepEqual(login.corps, { api_key: CLE_TEST, api_password: MDP_TEST });
  const p = faux.requetes.at(-1)!;
  assert.match(p.autorisation ?? "", /^Bearer /);
  assert.deepEqual(p.corps, { currency: "XOF", merchant_transaction_id: d.reference, amount: 200, lang: "fr", designation: "WAKATNET",
    client_email: "client@wakatnet.invalid", client_first_name: "Client", client_last_name: "WAKATNET",
    success_url: "https://api.wakatnet.invalid", failed_url: "https://api.wakatnet.invalid", notify_url: WEBHOOK,
    channel: "OTP", payment_method: "OM_BF", client_phone_number: "+22607345678", direct_pay: true, otp_code: "367025" });
  assert.equal((await fournisseur().charge(d)).statut, "PENDING", "rejouée : TRANSACTION_EXIST, toujours en attente");
  // Moov : notification poussée, aucun code transmis.
  await fournisseur().charge(demande({ operateur: "moov_bf", otp: undefined, numero: "02345678" }));
  const m = faux.requetes.at(-1)!.corps as Record<string, unknown>;
  assert.deepEqual([m.payment_method, m.channel, m.otp_code, m.client_phone_number], ["MOOV_BF", "PUSH", undefined, "+22602345678"]);
});

test("paiement : refus et pannes classés (P8) ; montant, référence, code Orange et URL de notification contrôlés AVANT tout appel", async () => {
  const avec = async (statut: number, corps: unknown) => { faux.prochaineReponse = { statut, corps }; return fournisseur().charge(demande()); };
  await assert.rejects(avec(200, { code: 2004, status: "OTP_ERROR", description: "code faux" }), PaiementRefuse);
  await assert.rejects(avec(200, { code: 2005, status: "INSUFFICIENT_BALANCE" }), PaiementRefuse);
  await assert.rejects(avec(400, { code: 1004, status: "INVALID_PARAMS" }), PaiementRefuse);
  await assert.rejects(avec(200, { code: 200, status: "OK", transaction_id: "cp-x", details: { code: 2001, status: "INITIATED", must_be_redirected: true } }),
                       PaiementRefuse, "redirection exigée : impossible depuis le portail");
  await assert.rejects(avec(200, { code: -1, status: "OPERATION_ERROR" }), FournisseurIndisponible, "issue inconnue : verify() tranchera");
  await assert.rejects(avec(500, {}), FournisseurIndisponible);
  await assert.rejects(avec(403, { code: 2011, status: "NOT_ALLOWED" }), FournisseurIndisponible, "IP non autorisée : compte à revoir");
  const n = faux.requetes.length;
  for (const d of [demande({ otp: undefined }), demande({ otp: "12" }), demande({ otp: "abcd" }), demande({ montant: 99 }), demande({ montant: 201 }),
                   demande({ montant: 2_500_005 }), demande({ reference: "wk_court" }), demande({ numero: "1234567" })]) {
    await assert.rejects(fournisseur().charge(d), PaiementRefuse, JSON.stringify(d));
  }
  await assert.rejects(fournisseur({ urlWebhook: null }).charge(demande()), FournisseurIndisponible);
  assert.equal(faux.requetes.length, n, "aucun appel pour une demande invalide");
  await assert.rejects(fournisseur({ cle: "sk_test_mauvaise-cle-000000" }).charge(demande()), FournisseurIndisponible, "identifiants refusés : panne du compte");
  await assert.rejects(new CinetpayProvider({ cleApi: CLE_TEST, motDePasseApi: MDP_TEST, environnement: "sandbox" },
    { urlBase: "http://127.0.0.1:1", urlWebhook: WEBHOOK, urlRetour: "https://x.invalid" }).charge(demande()), FournisseurIndisponible);
});

test("jeton d'accès : une connexion pour plusieurs appels ; jeton périmé (1003) → une reconnexion, un nouvel essai", async () => {
  const f = fournisseur();
  await f.charge(demande());
  const avant = faux.connexions;
  await f.charge(demande());
  await f.charge(demande({ operateur: "moov_bf", otp: undefined }));
  assert.equal(faux.connexions, avant, "jeton en cache");
  faux.jetons.clear();                                                  // tous révoqués : 1003 EXPIRED_TOKEN
  assert.equal((await f.charge(demande())).statut, "PENDING");
  assert.equal(faux.connexions, avant + 1, "une seule reconnexion");
});

test("verify : SUCCESS avec montant → réussi ; refus → échec ; en cours ; NOT_FOUND → échec sûr ; montant absent → -1 (écart) ; statut inconnu → réessayé", async () => {
  const d = demande({ operateur: "moov_bf", otp: undefined });
  await fournisseur().charge(d);
  const t = faux.transactions.get(d.reference)!;
  for (const [s, attendu] of [["INITIATED", "PENDING"], ["PENDING", "PENDING"], ["FAILED", "FAILED"], ["EXPIRED", "FAILED"],
                               ["OTP_ERROR", "FAILED"], ["INSUFFICIENT_BALANCE", "FAILED"]] as const) {
    t.status = s;
    assert.equal((await fournisseur().verify(d.reference)).statut, attendu, s);
  }
  t.status = "SUCCESS";
  const sansMontant = await fournisseur().verify(d.reference);
  assert.deepEqual([sansMontant.statut, sansMontant.montant, sansMontant.devise], ["SUCCEEDED", -1, "?"],
                   "forme du SDK (sans montant) : A8, le service en fera un écart");
  faux.montantDansStatut = true;                                       // hypothèse [À CONFIRMER] : montant au statut
  try {
    assert.deepEqual(await fournisseur().verify(d.reference),
                     { reference: d.reference, referenceFournisseur: t.transaction_id, statut: "SUCCEEDED", montant: 200, devise: "XOF" });
  } finally {
    faux.montantDansStatut = false;
  }
  const inconnue = reference();
  assert.deepEqual(await fournisseur().verify(inconnue), { reference: inconnue, statut: "FAILED", montant: 0, devise: "XOF" }, "jamais reçue : échec sûr");
  faux.prochainStatut = { statut: 200, corps: { code: 200, status: "SUCCESS", merchant_transaction_id: reference(), amount: 200, currency: "XOF" } };
  await assert.rejects(fournisseur().verify(d.reference), FournisseurIndisponible, "réponse d'une autre transaction refusée");
  faux.prochainStatut = { statut: 200, corps: { code: 200, status: "REFUNDED_MAYBE" } };
  await assert.rejects(fournisseur().verify(d.reference), FournisseurIndisponible, "statut inconnu : jamais lu comme un échec");
  faux.prochainStatut = { statut: 502, corps: {} };
  await assert.rejects(fournisseur().verify(d.reference), FournisseurIndisponible);
  // Relecture n° 4 : un 404 sans corps JSON NOT_FOUND est une panne, jamais un échec (le client repaierait).
  faux.prochain404Html = true;
  await assert.rejects(fournisseur().verify(d.reference), FournisseurIndisponible);
  faux.prochainStatut = { statut: 404, corps: { code: 404 } };
  await assert.rejects(fournisseur().verify(d.reference), FournisseurIndisponible, "404 sans status NOT_FOUND : panne");
  faux.prochainStatut = { statut: 200, corps: { code: 200, status: "PENDING", merchant_transaction_id: null } };
  assert.equal((await fournisseur().verify(d.reference)).statut, "PENDING", "relecture n° 10 : null vaut absent");
});

test("relecture n° 3 : connexion lente → paiement NON envoyé (délai global sous celui du service) ; aucune requête au-delà", async () => {
  const f = new CinetpayProvider({ cleApi: CLE_TEST, motDePasseApi: `${MDP_TEST}-lent`, environnement: "sandbox" },
                                 { urlBase: faux.url, urlWebhook: WEBHOOK, urlRetour: "https://api.wakatnet.invalid" });
  faux.latenceConnexionMs = 7_000;                                      // 12 s de budget − 7 s < 6 s de marge d'envoi
  try {
    const d = demande();
    const t0 = Date.now();
    const connexionsAvant = faux.connexions;
    await assert.rejects(f.charge(d), (e: unknown) => e instanceof FournisseurIndisponible && /trop lente/.test(e.message));
    assert.equal(faux.connexions, connexionsAvant + 1, "connexion réussie, mais trop tard pour envoyer");
    assert.ok(Date.now() - t0 < 15_000, "rendu avant le délai du service (15 s)");
    assert.equal(faux.transactions.has(d.reference), false, "aucun paiement envoyé : aucun argent ne bouge");
  } finally {
    faux.latenceConnexionMs = 0;
  }
});

test("relecture n° 7 : mauvais mot de passe jamais validé par le jeton d'un bon ; verifierCompte se connecte lui-même", async () => {
  await fournisseur().charge(demande());                                // jeton du bon couple en cache
  const mauvais = new CinetpayProvider({ cleApi: CLE_TEST, motDePasseApi: "mauvais-mot-de-passe", environnement: "sandbox" }, { urlBase: faux.url });
  await assert.rejects(mauvais.verifierCompte(), CompteInvalide);
  const avant = faux.connexions;
  await fournisseur().verifierCompte();
  assert.equal(faux.connexions, avant + 1);
});

test("parseWebhook : corps du SDK → déclencheur ; référence ou identifiant mal formés refusés ; aucun appel sortant", async () => {
  const d = demande();
  await fournisseur().charge(d);
  const t = faux.transactions.get(d.reference)!;
  const n = faux.requetes.length;
  const f = fournisseur();
  assert.deepEqual(f.parseWebhook({}, Buffer.from(faux.notification(t))),
                   { idEvenement: `cinetpay:${t.transaction_id}`, reference: d.reference, referenceFournisseur: t.transaction_id });
  const { merchant_transaction_id: _r, ...sansRef } = JSON.parse(faux.notification(t)) as Record<string, unknown>;
  assert.equal(f.parseWebhook({}, Buffer.from(JSON.stringify(sansRef))).reference, "", "sans référence : retrouvé par transaction_id");
  for (const corps of ["", "[]", "null", "{}", JSON.stringify({ ...sansRef, notify_token: "" }), JSON.stringify({ ...sansRef, transaction_id: "a b" }),
                       JSON.stringify({ ...sansRef, merchant_transaction_id: "autre" }), JSON.stringify({ ...sansRef, transaction_id: 5 })]) {
    assert.throws(() => f.parseWebhook({}, Buffer.from(corps)), SignatureInvalide, corps);
  }
  assert.equal(faux.requetes.length, n, "aucun appel sortant à la lecture d'un webhook");
});

test("clés : préfixe lié à l'environnement ; argent réel refusé avant G-ARGENT ; bac à sable refusé en production ; adresse de test locale seulement", () => {
  assert.deepEqual(validerCles("cinetpay", { cle_api: CLE_TEST, mot_de_passe_api: MDP_TEST, environnement: "sandbox" }),
                   { cle_api: CLE_TEST, mot_de_passe_api: MDP_TEST, environnement: "sandbox" });
  assert.throws(() => validerCles("cinetpay", { cle_api: "sk_live_0123456789abcdef", mot_de_passe_api: MDP_TEST, environnement: "sandbox" }), /ne correspond pas/);
  assert.throws(() => validerCles("cinetpay", { cle_api: "sk_live_0123456789abcdef", mot_de_passe_api: MDP_TEST, environnement: "production" }), /G-ARGENT/);
  // Relecture n° 1 : même G-ARGENT franchie, production refusée tant que le montant au statut n'est pas confirmé.
  assert.equal(MONTANT_AU_STATUT_CONFIRME, false);
  process.env.WAKATNET_ARGENT_REEL = "1";
  try {
    assert.throws(() => validerCles("cinetpay", { cle_api: "sk_live_0123456789abcdef", mot_de_passe_api: MDP_TEST, environnement: "production" }),
                  /montant du statut non confirmé/);
    assert.throws(() => creerFournisseur("cinetpay", { cle_api: "sk_live_0123456789abcdef", mot_de_passe_api: MDP_TEST, environnement: "production" }, null),
                  /montant du statut non confirmé/);
  } finally {
    delete process.env.WAKATNET_ARGENT_REEL;
  }
  assert.throws(() => validerCles("cinetpay", { cle_api: "pk_0123456789", mot_de_passe_api: MDP_TEST, environnement: "sandbox" }), FournisseurInconnu);
  assert.throws(() => validerCles("cinetpay", { cle_api: CLE_TEST, mot_de_passe_api: "court", environnement: "sandbox" }), FournisseurInconnu);
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(() => validerCles("cinetpay", { cle_api: CLE_TEST, mot_de_passe_api: MDP_TEST, environnement: "sandbox" }), /bac à sable interdit/);
    assert.throws(() => creerFournisseur("cinetpay", { cle_api: CLE_TEST, mot_de_passe_api: MDP_TEST, environnement: "sandbox" }, null), /bac à sable interdit/);
  } finally {
    if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
  }
  process.env.WAKATNET_CINETPAY_URL = "https://ailleurs.invalid";
  try {
    assert.throws(() => creerFournisseur("cinetpay", { cle_api: CLE_TEST, mot_de_passe_api: MDP_TEST, environnement: "sandbox" }, null), /faux serveur local/);
  } finally {
    delete process.env.WAKATNET_CINETPAY_URL;
  }
});

test("de bout en bout : compte marchand CinetPay (bac à sable) ; forme du SDK (sans montant) → écart sans ticket ; HYPOTHÈSE montant au statut → ticket ; rejeu sans appel", async () => {
  process.env.WAKATNET_CINETPAY_URL = faux.url;
  try {
    await avecApp(async (app) => {
      const p = await proprietaire("CinetPay bout en bout");
      const [plan] = await sql<{ id: string }>(URL_ADMIN,
        "INSERT INTO app.plan (tenant_id, nom, prix_xof, uptime_limit_s) VALUES ($1, '1 heure', 200, 3600) RETURNING id::text", [p.tenant]);
      const [s] = await sql<{ public_id: string }>(URL_ADMIN, "UPDATE app.site SET hotspot_hotes = '{10.5.50.1}' WHERE id = $1 RETURNING public_id", [p.site]);
      await sql(URL_ADMIN, "SELECT app.credits_recharger($1, 10000, $2)", [p.tenant, `cp-${p.tenant}`]);
      const mauvaise = await app.inject({ method: "PUT", url: "/v1/compte-marchand", headers: entetes(p.tenant),
        payload: { fournisseur: "cinetpay", cles: { cle_api: "sk_test_cle-refusee-0000000", mot_de_passe_api: MDP_TEST, environnement: "sandbox" } } });
      assert.equal(mauvaise.statusCode, 422, "identifiants refusés par CinetPay à l'enregistrement");
      const r = await app.inject({ method: "PUT", url: "/v1/compte-marchand", headers: entetes(p.tenant),
        payload: { fournisseur: "cinetpay", cles: { cle_api: CLE_TEST, mot_de_passe_api: MDP_TEST, environnement: "sandbox" } } });
      assert.equal(r.statusCode, 200, r.body);
      const chemin = new URL(r.json().url_webhook).pathname;
      assert.match(chemin, /^\/webhooks\/cinetpay\/[A-Za-z0-9_-]{24}$/);

      const acheter = async (numero: string) => {
        const a = await app.paiement!.creer({ sitePublic: s.public_id, planId: BigInt(plan.id), operateur: "orange_bf", numero,
                                              otp: "367025", jetonAppareil: jeton(), soumission: soumission() });
        if (a.statut !== "cree") assert.fail(a.statut);
        assert.equal(a.statutPaiement, "PENDING");
        return a.reference;
      };
      const ref = await acheter("07345678");
      const t = faux.transactions.get(ref)!;
      assert.equal((t.corps.notify_url as string).endsWith(chemin), true, "notify_url = webhook de ce compte marchand");
      t.status = "SUCCESS";
      faux.montantDansStatut = true;                                   // hypothèse [À CONFIRMER] au bac à sable (ADR 0022)
      const cb = await app.inject({ method: "POST", url: chemin, headers: { "content-type": "application/json" }, payload: faux.notification(t) });
      assert.equal(cb.statusCode, 200, cb.body);
      assert.equal(cb.json().statut, "SUCCEEDED");
      const [pay] = await sql<{ statut: string; voucher: boolean; refF: string }>(URL_ADMIN,
        "SELECT statut, voucher_id IS NOT NULL AS voucher, reference_fournisseur AS \"refF\" FROM app.payment WHERE reference = $1", [ref]);
      faux.montantDansStatut = false;
      assert.deepEqual(pay, { statut: "SUCCEEDED", voucher: true, refF: t.transaction_id });
      // Relecture n° 8 : webhook rejoué sur un paiement final → aucun appel à CinetPay.
      const avantRejeu = faux.requetes.length;
      const rejeu = await app.inject({ method: "POST", url: chemin, headers: { "content-type": "application/json" }, payload: faux.notification(t) });
      assert.deepEqual([rejeu.statusCode, rejeu.json().statut], [200, "SUCCEEDED"]);
      assert.equal(faux.requetes.length, avantRejeu, "état final : aucun appel sortant");

      // Référence inventée : 200 sans effet, et AUCUN appel sortant (paiement inconnu de ce compte).
      const n = faux.requetes.length;
      const faux2 = await app.inject({ method: "POST", url: chemin, headers: { "content-type": "application/json" },
        payload: JSON.stringify({ notify_token: "x", transaction_id: "cp-invente", merchant_transaction_id: reference() }) });
      assert.equal(faux2.statusCode, 200);
      assert.equal(faux.requetes.length, n, "aucun appel à CinetPay pour une référence inventée");

      // A8 : succès sans montant au statut → écart (MISMATCH), aucun ticket.
      const ref2 = await acheter("07345679");
      const t2 = faux.transactions.get(ref2)!;
      t2.status = "SUCCESS";
      {
        const { merchant_transaction_id: _m, ...sansRef } = JSON.parse(faux.notification(t2)) as Record<string, unknown>;
        const cb2 = await app.inject({ method: "POST", url: chemin, headers: { "content-type": "application/json" }, payload: JSON.stringify(sansRef) });
        assert.equal(cb2.statusCode, 200, cb2.body);
        assert.equal(cb2.json().statut, "MISMATCH", "forme du SDK : retrouvé par transaction_id, montant non confirmé → écart");
      }
      const [pay2] = await sql<{ statut: string; voucher: boolean }>(URL_ADMIN,
        "SELECT statut, voucher_id IS NOT NULL AS voucher FROM app.payment WHERE reference = $1", [ref2]);
      assert.deepEqual(pay2, { statut: "MISMATCH", voucher: false });
    });
  } finally {
    delete process.env.WAKATNET_CINETPAY_URL;
  }
});
