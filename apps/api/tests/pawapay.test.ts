// Adaptateur pawaPay v2 (ADR 0020, ticket 3.08) : code d'argent, donc tests de propriétés (règle 4) et faux serveur
// aux formes de la documentation officielle. Le vrai bac à sable reste à jouer avec le jeton de Yacouba.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import fc from "fast-check";
import {
  FournisseurIndisponible, PaiementRefuse, PawapayProvider, SignatureInvalide, depositIdDe, montantPawapay, verifierSignature,
} from "../../../packages/payments/src/index.ts";
import { avecApp, entetes, proprietaire, sql, URL_ADMIN } from "./aide.ts";
import { jeton, soumission } from "./aide-paiement.ts";
import { callbackSigne, FauxPawapay } from "./aide-pawapay.ts";

const JETON = "jeton-de-test-pawapay-0123456789";
const reference = () => `wk_${randomBytes(16).toString("base64url")}`;
let faux: FauxPawapay;
before(async () => { faux = await new FauxPawapay().demarrer(); });
after(async () => { await faux.arreter(); });
const fournisseur = () => new PawapayProvider({ jeton: JETON, environnement: "sandbox" }, { urlBase: faux.url });

test("propriété : depositId est un UUID v4, fonction de la seule référence, distinct pour deux références", () => {
  fc.assert(fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), fc.uint8Array({ minLength: 16, maxLength: 16 }), (a, b) => {
    const ra = `wk_${Buffer.from(a).toString("base64url")}`, rb = `wk_${Buffer.from(b).toString("base64url")}`;
    const ia = depositIdDe(ra);
    assert.match(ia, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(depositIdDe(ra), ia, "idempotent : même référence, même dépôt");
    // Seuls 6 bits (version, variante) sont imposés : deux références qui diffèrent ailleurs donnent deux dépôts.
    const masque = (x: Uint8Array) => Buffer.from(x.map((o, i) => (i === 6 ? o & 0x0f : i === 8 ? o & 0x3f : o))).toString("hex");
    if (masque(a) !== masque(b)) assert.notEqual(depositIdDe(rb), ia);
  }), { numRuns: 500 });
  for (const r of ["wk_court", "xx_" + "A".repeat(22), "wk_" + "A".repeat(23), "wk_" + "!".repeat(22)]) assert.throws(() => depositIdDe(r), r);
});

test("propriété : montant rendu par pawaPay → XOF entier ; toute décimale non nulle ou forme inattendue → -1 (écart)", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 10 ** 12 }), fc.integer({ min: 0, max: 3 }), (n, zeros) => {
    assert.equal(montantPawapay(zeros === 0 ? String(n) : `${n}.${"0".repeat(zeros)}`), n);
  }), { numRuns: 500 });
  fc.assert(fc.property(fc.integer({ min: 0, max: 10 ** 9 }), fc.integer({ min: 1, max: 99 }), (n, c) => {
    assert.equal(montantPawapay(`${n}.${String(c).padStart(2, "0")}`), -1);
  }), { numRuns: 300 });
  for (const v of [100, "", "01", "-5", "1e3", " 100", "100.", null, undefined, "100,00"]) assert.equal(montantPawapay(v), -1, String(v));
});

test("dépôt Orange : corps conforme à la doc (UUID, 226…, ORANGE_BFA, OTP, montant entier en chaîne, référence) ; ACCEPTED puis DUPLICATE_IGNORED → en attente", async () => {
  const ref = reference();
  const d = { reference: ref, montant: 200, devise: "XOF" as const, operateur: "orange_bf" as const, numero: "73394446", otp: "367025" };
  assert.deepEqual(await fournisseur().charge(d), { referenceFournisseur: depositIdDe(ref), statut: "PENDING" });
  const r = faux.requetes.at(-1)!;
  assert.equal(r.autorisation, `Bearer ${JETON}`);
  assert.deepEqual(r.corps, { depositId: depositIdDe(ref), payer: { type: "MMO", accountDetails: { phoneNumber: "22673394446", provider: "ORANGE_BFA" } },
    amount: "200", currency: "XOF", clientReferenceId: ref, customerMessage: "WAKATNET", preAuthorisationCode: "367025" });
  assert.equal((await fournisseur().charge(d)).statut, "PENDING", "rejouée : DUPLICATE_IGNORED, toujours en attente");
  // Moov : PIN sur le téléphone, aucun code transmis.
  await fournisseur().charge({ ...d, reference: reference(), operateur: "moov_bf", otp: undefined });
  const m = faux.requetes.at(-1)!.corps as { payer: { accountDetails: { provider: string } }; preAuthorisationCode?: string };
  assert.equal(m.payer.accountDetails.provider, "MOOV_BFA");
  assert.equal(m.preAuthorisationCode, undefined);
});

test("dépôt : refus et pannes classés (P8) ; Orange sans code refusé avant tout appel", async () => {
  const d = { reference: reference(), montant: 200, devise: "XOF" as const, operateur: "orange_bf" as const, numero: "73394446", otp: "367025" };
  const avec = async (statut: number, corps: unknown) => { faux.prochaineReponse = { statut, corps }; return fournisseur().charge({ ...d, reference: reference() }); };
  await assert.rejects(avec(200, { depositId: null, status: "REJECTED", failureReason: { failureCode: "INVALID_PHONE_NUMBER" } }), PaiementRefuse);
  await assert.rejects(avec(200, { status: "REJECTED", failureReason: { failureCode: "AMOUNT_OUT_OF_BOUNDS" } }), PaiementRefuse);
  await assert.rejects(avec(200, { status: "REJECTED", failureReason: { failureCode: "PROVIDER_TEMPORARILY_UNAVAILABLE" } }), FournisseurIndisponible);
  await assert.rejects(avec(400, { status: "REJECTED", failureReason: { failureCode: "INVALID_PARAMETER" } }), PaiementRefuse);
  await assert.rejects(avec(403, { failureReason: { failureCode: "AUTHORISATION_ERROR" } }), FournisseurIndisponible);
  await assert.rejects(avec(500, { failureReason: { failureCode: "UNKNOWN_ERROR" } }), FournisseurIndisponible, "issue inconnue : verify() tranchera");
  const n = faux.requetes.length;
  await assert.rejects(fournisseur().charge({ ...d, otp: undefined }), PaiementRefuse);
  await assert.rejects(fournisseur().charge({ ...d, otp: "12 34" }), PaiementRefuse);
  assert.equal(faux.requetes.length, n, "aucun appel sans code Orange valable");
  await assert.rejects(new PawapayProvider({ jeton: "mauvais-jeton-0123456789", environnement: "sandbox" }, { urlBase: faux.url }).charge(d), FournisseurIndisponible);
  await assert.rejects(new PawapayProvider({ jeton: JETON, environnement: "sandbox" }, { urlBase: "http://127.0.0.1:1" }).charge(d), FournisseurIndisponible);
});

test("verify : COMPLETED « 200.00 » → réussi 200 XOF ; FAILED ; en cours ; NOT_FOUND → échec sûr ; décimale → écart", async () => {
  const ref = reference();
  await fournisseur().charge({ reference: ref, montant: 200, devise: "XOF", operateur: "moov_bf", numero: "02345678" });
  const dep = faux.depots.get(depositIdDe(ref))!;
  for (const [s, attendu] of [["ACCEPTED", "PENDING"], ["PROCESSING", "PENDING"], ["IN_RECONCILIATION", "PENDING"], ["FAILED", "FAILED"]] as const) {
    dep.status = s;
    assert.equal((await fournisseur().verify(ref)).statut, attendu, s);
  }
  dep.status = "COMPLETED";
  assert.deepEqual(await fournisseur().verify(ref), { reference: ref, referenceFournisseur: depositIdDe(ref), statut: "SUCCEEDED", montant: 200, devise: "XOF" });
  faux.formatMontant = () => "199.50";
  assert.equal((await fournisseur().verify(ref)).montant, -1, "décimale non nulle : le service en fera un écart");
  faux.formatMontant = (m) => `${m}.00`;
});

test("verify : référence inconnue de pawaPay (NOT_FOUND) → échec ; réponse d'un autre dépôt → refusée", async () => {
  const ref = reference();
  assert.deepEqual(await fournisseur().verify(ref), { reference: ref, statut: "FAILED", montant: 0, devise: "XOF" });
  const autre = reference();
  await fournisseur().charge({ reference: autre, montant: 200, devise: "XOF", operateur: "moov_bf", numero: "02345678" });
  faux.depots.get(depositIdDe(autre))!.clientReferenceId = reference();      // référence qui ne correspond pas
  await assert.rejects(fournisseur().verify(autre), FournisseurIndisponible);
});

test("signature RFC 9421 des callbacks : valide (DER ou r||s) ; corps, chemin, hôte, algorithme, date, composants ou clé faux → refusée", () => {
  const cle = FauxPawapay.nouvelleCle("HTTP_EC_P256_KEY:1");
  const cles = [{ id: cle.id, key: cle.pem }];
  const corps = JSON.stringify({ depositId: "x", status: "COMPLETED" });
  const req = { methode: "POST", autorite: "api.exemple.bf", chemin: "/webhooks/pawapay/AAAAAAAAAAAAAAAAAAAAAAAA" };
  const maintenant = Math.floor(Date.now() / 1000);
  const ok = callbackSigne(corps, { autorite: req.autorite, chemin: req.chemin, cle });
  verifierSignature(ok, Buffer.from(corps), req, cles, maintenant);
  verifierSignature(callbackSigne(corps, { autorite: req.autorite, chemin: req.chemin, cle, dsa: "ieee-p1363" }), Buffer.from(corps), req, cles, maintenant);
  verifierSignature(ok, Buffer.from(corps), req, [{ id: "AUTRE_ID", key: cle.pem }], maintenant);   // keyid inconnu : clé connue essayée
  const refuse = (h: Record<string, string>, c = corps, r = req, k = cles, t = maintenant) =>
    assert.throws(() => verifierSignature(h, Buffer.from(c), r, k, t), SignatureInvalide);
  refuse(ok, corps.replace("COMPLETED", "FAILED"));                                   // corps changé : Content-Digest faux
  refuse({ ...ok, "content-digest": `sha-512=:${Buffer.alloc(64).toString("base64")}:` }, corps); // condensat forgé
  refuse(ok, corps, { ...req, chemin: "/webhooks/pawapay/BBBBBBBBBBBBBBBBBBBBBBBB" });  // autre compte marchand
  refuse(ok, corps, { ...req, autorite: "pirate.exemple" });
  refuse(ok, corps, req, [{ id: cle.id, key: FauxPawapay.nouvelleCle("X").pem }]);    // autre clé
  refuse(callbackSigne(corps, { autorite: req.autorite, chemin: req.chemin, cle, alg: "rsa-pss-sha512" }));
  refuse(callbackSigne(corps, { autorite: req.autorite, chemin: req.chemin, cle, composants: ["@method", "@authority", "@path", "signature-date"] }));
  refuse(callbackSigne(corps, { autorite: req.autorite, chemin: req.chemin, cle, cree: maintenant - 2 * 86_400 }));
  refuse(callbackSigne(corps, { autorite: req.autorite, chemin: req.chemin, cle, cree: maintenant + 3600 }));
  // Audit du 13/11/2026 : `expires` présent et dépassé de plus que la tolérance d'horloge (300 s, comme `created`) → refusée ;
  // absent → seule la fenêtre de `created` s'applique.
  refuse(callbackSigne(corps, { autorite: req.autorite, chemin: req.chemin, cle, expires: maintenant - 301 }));
  refuse(callbackSigne(corps, { autorite: req.autorite, chemin: req.chemin, cle, cree: maintenant }), corps, req, cles, maintenant + 361);
  // Relecture R4 (I-2) : un renvoi reçu un peu après `expires` (file d'attente, dérive d'horloge) n'est PAS refusé ; sinon
  // la confirmation attendrait la vérification périodique et le client, lassé, rachèterait.
  verifierSignature(callbackSigne(corps, { autorite: req.autorite, chemin: req.chemin, cle, cree: maintenant - 120 }), Buffer.from(corps), req, cles, maintenant);
  verifierSignature(callbackSigne(corps, { autorite: req.autorite, chemin: req.chemin, cle, expires: maintenant - 1 }), Buffer.from(corps), req, cles, maintenant);
  verifierSignature(callbackSigne(corps, { autorite: req.autorite, chemin: req.chemin, cle, cree: maintenant }), Buffer.from(corps), req, cles, maintenant + 61);
  verifierSignature(callbackSigne(corps, { autorite: req.autorite, chemin: req.chemin, cle, cree: maintenant - 120, expires: null }),
                    Buffer.from(corps), req, cles, maintenant);
  verifierSignature(callbackSigne(corps, { autorite: req.autorite, chemin: req.chemin, cle, expires: maintenant }), Buffer.from(corps), req, cles, maintenant);
  const { signature: _s, "signature-input": _i, ...sansSignature } = ok;
  refuse(sansSignature);
  refuse({ ...ok, signature: `autre=${ok.signature.slice(7)}` });
  refuse({ ...ok, "signature-input": `${ok["signature-input"]}, sig-b=("@method");alg="ecdsa-p256-sha256";created=1` });
});

test("parseWebhook : clés lues chez pawaPay (avec le jeton) ; rotation suivie, relecture bornée à une par 5 min ; référence et depositId liés", async () => {
  const ref = reference();
  const corps = JSON.stringify({ depositId: depositIdDe(ref), status: "COMPLETED", amount: "200.00", currency: "XOF", clientReferenceId: ref });
  const req = { methode: "POST", autorite: "api.exemple.bf", chemin: "/webhooks/pawapay/CCCCCCCCCCCCCCCCCCCCCCCC" };
  let maintenant = Date.now() + 10 * 3_600_000;                                      // cache des tests précédents périmé
  const f = new PawapayProvider({ jeton: JETON, environnement: "sandbox" }, { urlBase: faux.url, maintenant: () => maintenant });
  const lectures = () => faux.requetes.filter((r) => r.chemin === "/v2/public-key/http").length;
  assert.deepEqual(await f.parseWebhook(callbackSigne(corps, { ...req, cle: faux.cle, cree: Math.floor(maintenant / 1000) }), Buffer.from(corps), req),
                   { idEvenement: `${depositIdDe(ref)}:COMPLETED`, reference: ref, referenceFournisseur: depositIdDe(ref) });
  // De faux callbacks à keyid inconnu ne font relire les clés qu'une fois par 5 min (relecture de la revue).
  const avant = lectures();
  const pirate = FauxPawapay.nouvelleCle("CLE_PIRATE");
  for (let i = 0; i < 5; i++) {
    await assert.rejects(f.parseWebhook(callbackSigne(corps, { ...req, cle: pirate, cree: Math.floor(maintenant / 1000) }), Buffer.from(corps), req), SignatureInvalide);
  }
  assert.ok(lectures() - avant <= 1, `relectures : ${lectures() - avant}`);
  // pawaPay change de clé : suivie dès que 5 min ont passé depuis la dernière relecture.
  faux.cle = FauxPawapay.nouvelleCle("HTTP_EC_P256_KEY:2");
  maintenant += 6 * 60_000;
  assert.equal((await f.parseWebhook(callbackSigne(corps, { ...req, cle: faux.cle, cree: Math.floor(maintenant / 1000) }), Buffer.from(corps), req)).reference, ref);
  const incoherent = JSON.stringify({ depositId: depositIdDe(reference()), status: "COMPLETED", clientReferenceId: ref });
  await assert.rejects(f.parseWebhook(callbackSigne(incoherent, { ...req, cle: faux.cle, cree: Math.floor(maintenant / 1000) }), Buffer.from(incoherent), req), SignatureInvalide);
  await assert.rejects(f.parseWebhook({}, Buffer.from(corps), req), SignatureInvalide);
  // Sans clientReferenceId : la référence est vide, le service retrouvera le paiement par depositId.
  const sansRef = JSON.stringify({ depositId: depositIdDe(ref), status: "COMPLETED", amount: "200.00", currency: "XOF" });
  assert.deepEqual(await f.parseWebhook(callbackSigne(sansRef, { ...req, cle: faux.cle, cree: Math.floor(maintenant / 1000) }), Buffer.from(sansRef), req),
                   { idEvenement: `${depositIdDe(ref)}:COMPLETED`, reference: "", referenceFournisseur: depositIdDe(ref) });
});

test("audit du 13/11/2026 : clés publiques en panne → une seule lecture par 5 min, quelle que soit la cause de l'échec", async () => {
  const enPanne = await new FauxPawapay().demarrer();                               // serveur neuf : cache des clés vide
  try {
    enPanne.clesEnPanne = true;
    let maintenant = Date.now();
    const f = new PawapayProvider({ jeton: JETON, environnement: "sandbox" }, { urlBase: enPanne.url, maintenant: () => maintenant });
    const lectures = () => enPanne.requetes.filter((r) => r.chemin === "/v2/public-key/http").length;
    const ref = reference();
    const corps = JSON.stringify({ depositId: depositIdDe(ref), status: "COMPLETED", amount: "200.00", currency: "XOF", clientReferenceId: ref });
    const req = { methode: "POST", autorite: "api.exemple.bf", chemin: "/webhooks/pawapay/DDDDDDDDDDDDDDDDDDDDDDDD" };
    const signe = () => callbackSigne(corps, { ...req, cle: enPanne.cle, cree: Math.floor(maintenant / 1000) });
    // Callbacks bien formés (forme, digest, date justes) : seule la clé manque. Avant le correctif, chacun relançait
    // GET /v2/public-key/http avec le jeton du propriétaire (cache expiré après l'échec).
    for (let i = 0; i < 10; i++) {
      await assert.rejects(f.parseWebhook(signe(), Buffer.from(corps), req), SignatureInvalide);
      maintenant += 20_000;                                                          // 10 × 20 s = 200 s < 5 min
    }
    assert.equal(lectures(), 1, `lectures pendant la panne : ${lectures()}`);
    // Relecture R4 (M-1) : pawaPay INJOIGNABLE (port fermé) et callbacks SIMULTANÉS : tous reçoivent SignatureInvalide (401),
    // jamais l'erreur brute du fournisseur (500), y compris ceux qui attendent la lecture en cours.
    const injoignable = new PawapayProvider({ jeton: JETON, environnement: "sandbox" }, { urlBase: "http://127.0.0.1:1", maintenant: () => maintenant });
    const simultanes = await Promise.allSettled(Array.from({ length: 5 }, () => injoignable.parseWebhook(signe(), Buffer.from(corps), req)));
    for (const x of simultanes) {
      assert.equal(x.status, "rejected");
      assert.ok((x as PromiseRejectedResult).reason instanceof SignatureInvalide, String((x as PromiseRejectedResult).reason));
    }
    // Panne finie : nouvelle lecture permise 5 min après la précédente, et le callback passe.
    enPanne.clesEnPanne = false;
    maintenant += 120_000;
    assert.equal((await f.parseWebhook(signe(), Buffer.from(corps), req)).reference, ref);
    assert.equal(lectures(), 2);
  } finally {
    await enPanne.arreter();
  }
});

test("audit du 13/11/2026 : un callback forgé grossièrement est refusé sans AUCUN appel sortant (forme, composants, algorithme, date, expires, digest)", async () => {
  const neuf = await new FauxPawapay().demarrer();                                  // cache des clés vide : toute lecture se verrait
  try {
    const maintenant = Date.now();
    const f = new PawapayProvider({ jeton: JETON, environnement: "sandbox" }, { urlBase: neuf.url, maintenant: () => maintenant });
    const ref = reference();
    const corps = JSON.stringify({ depositId: depositIdDe(ref), status: "COMPLETED", clientReferenceId: ref });
    const req = { methode: "POST", autorite: "api.exemple.bf", chemin: "/webhooks/pawapay/EEEEEEEEEEEEEEEEEEEEEEEE" };
    const cree = Math.floor(maintenant / 1000);
    const base = { ...req, cle: neuf.cle, cree };
    const ok = callbackSigne(corps, base);
    const { signature: _s, "signature-input": _i, ...sansSignature } = ok;
    const forges: [string, Record<string, string>, string][] = [
      ["sans en-têtes", {}, corps],
      ["non signé", sansSignature, corps],
      ["Signature-Input illisible", { ...ok, "signature-input": "n'importe quoi" }, corps],
      ["étiquette différente", { ...ok, signature: `autre=${ok.signature.slice(7)}` }, corps],
      ["composant manquant", callbackSigne(corps, { ...base, composants: ["@method", "@authority", "@path", "signature-date"] }), corps],
      ["algorithme refusé", callbackSigne(corps, { ...base, alg: "hmac-sha256" }), corps],
      ["trop vieux", callbackSigne(corps, { ...base, cree: cree - 2 * 86_400 }), corps],
      ["dans le futur", callbackSigne(corps, { ...base, cree: cree + 3600 }), corps],
      ["expiré", callbackSigne(corps, { ...base, cree: cree - 600 }), corps],
      ["corps changé (Content-Digest faux)", ok, corps.replace("COMPLETED", "FAILED")],
      ["Content-Digest absent", { ...ok, "content-digest": "" }, corps],
    ];
    for (const [nom, h, c] of forges) await assert.rejects(f.parseWebhook(h, Buffer.from(c), req), SignatureInvalide, nom);
    assert.deepEqual(neuf.requetes.map((r) => r.chemin), [], "aucune requête vers pawaPay pour un callback forgé grossièrement");
    // Le même callback, bien formé, fait lire les clés une fois et passe.
    assert.equal((await f.parseWebhook(ok, Buffer.from(corps), req)).reference, ref);
    assert.deepEqual(neuf.requetes.map((r) => r.chemin), ["/v2/public-key/http"]);
  } finally {
    await neuf.arreter();
  }
});

test("relecture : UNKNOWN_ERROR n'est jamais un refus ; bac à sable refusé sur la plateforme de production ; adresse de test locale seulement", async () => {
  faux.prochaineReponse = { statut: 200, corps: { status: "REJECTED", failureReason: { failureCode: "UNKNOWN_ERROR" } } };
  await assert.rejects(fournisseur().charge({ reference: reference(), montant: 200, devise: "XOF", operateur: "moov_bf", numero: "02345678" }), FournisseurIndisponible);
  const { validerCles, creerFournisseur } = await import("../src/fournisseurs.ts");
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(() => validerCles("pawapay", { jeton: JETON, environnement: "sandbox" }), /bac à sable interdit/);
    assert.throws(() => creerFournisseur("pawapay", { jeton: JETON, environnement: "sandbox" }, null), /bac à sable interdit/);
  } finally {
    if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
  }
  process.env.WAKATNET_PAWAPAY_URL = "https://ailleurs.exemple";
  try {
    assert.throws(() => creerFournisseur("pawapay", { jeton: JETON, environnement: "sandbox" }, null), /faux serveur local/);
  } finally {
    delete process.env.WAKATNET_PAWAPAY_URL;
  }
});

test("de bout en bout : compte marchand pawaPay (bac à sable), achat Orange, callback signé → ticket ; non signé → 401 ; argent réel refusé avant G-ARGENT", async () => {
  process.env.WAKATNET_PAWAPAY_URL = faux.url;
  try {
    await avecApp(async (app) => {
      const p = await proprietaire("pawaPay bout en bout");
      const [plan] = await sql<{ id: string }>(URL_ADMIN,
        "INSERT INTO app.plan (tenant_id, nom, prix_xof, uptime_limit_s) VALUES ($1, '1 heure', 200, 3600) RETURNING id::text", [p.tenant]);
      const [s] = await sql<{ public_id: string }>(URL_ADMIN, "UPDATE app.site SET hotspot_hotes = '{10.5.50.1}' WHERE id = $1 RETURNING public_id", [p.site]);
      await sql(URL_ADMIN, "SELECT app.credits_recharger($1, 10000, $2)", [p.tenant, `pp-${p.tenant}`]);
      const prod = await app.inject({ method: "PUT", url: "/v1/compte-marchand", headers: entetes(p.tenant),
                                      payload: { fournisseur: "pawapay", cles: { jeton: JETON, environnement: "production" } } });
      assert.equal(prod.statusCode, 422);
      assert.match(prod.json().erreur, /G-ARGENT/);
      const r = await app.inject({ method: "PUT", url: "/v1/compte-marchand", headers: entetes(p.tenant),
                                   payload: { fournisseur: "pawapay", cles: { jeton: JETON, environnement: "sandbox" } } });
      assert.equal(r.statusCode, 200, r.body);
      const chemin = new URL(r.json().url_webhook).pathname;
      // Le compte est vérifié chez pawaPay à l'enregistrement : sans callbacks signés, il est refusé.
      faux.callbacksSignes = false;
      const nonSignes = await app.inject({ method: "PUT", url: "/v1/compte-marchand", headers: entetes(p.tenant),
                                           payload: { fournisseur: "pawapay", cles: { jeton: JETON, environnement: "sandbox" } } });
      faux.callbacksSignes = true;
      assert.equal(nonSignes.statusCode, 422);
      assert.match(nonSignes.json().erreur, /callbacks signés/);
      const mauvaisJeton = await app.inject({ method: "PUT", url: "/v1/compte-marchand", headers: entetes(p.tenant),
                                              payload: { fournisseur: "pawapay", cles: { jeton: "jeton-refuse-0123456789abc", environnement: "sandbox" } } });
      assert.equal(mauvaisJeton.statusCode, 422);
      assert.match(chemin, /^\/webhooks\/pawapay\/[A-Za-z0-9_-]{24}$/);
      const achat = await app.paiement!.creer({ sitePublic: s.public_id, planId: BigInt(plan.id), operateur: "orange_bf", numero: "07345678",
                                                otp: "367025", jetonAppareil: jeton(), soumission: soumission() });
      if (achat.statut !== "cree") assert.fail(achat.statut);
      assert.equal(achat.statutPaiement, "PENDING");
      const dep = faux.depots.get(depositIdDe(achat.reference))!;
      assert.deepEqual([dep.provider, dep.phoneNumber, dep.amount, dep.preAuthorisationCode], ["ORANGE_BFA", "22607345678", "200", "367025"]);
      dep.status = "COMPLETED";
      const corps = JSON.stringify(faux.donnees(dep));
      const nonSigne = await app.inject({ method: "POST", url: chemin, headers: { host: "api.test.invalid", "content-type": "application/json" }, payload: corps });
      assert.equal(nonSigne.statusCode, 401);
      const signe = await app.inject({ method: "POST", url: chemin, payload: corps,
        headers: { host: "api.test.invalid", ...callbackSigne(corps, { autorite: "api.test.invalid", chemin, cle: faux.cle }) } });
      assert.equal(signe.statusCode, 200, signe.body);
      assert.equal(signe.json().statut, "SUCCEEDED");
      const [pay] = await sql<{ statut: string; voucher: boolean; montant: string }>(URL_ADMIN,
        "SELECT statut, voucher_id IS NOT NULL AS voucher, montant::text FROM app.payment WHERE reference = $1", [achat.reference]);
      assert.deepEqual(pay, { statut: "SUCCEEDED", voucher: true, montant: "200" });
      // Avec un paiement encore vérifiable, le compte marchand ne change plus (relecture : sinon encaissé sans ticket).
      const second = await app.paiement!.creer({ sitePublic: s.public_id, planId: BigInt(plan.id), operateur: "moov_bf", numero: "02345678",
                                                 jetonAppareil: jeton(), soumission: soumission() });
      if (second.statut !== "cree") assert.fail(second.statut);
      const change = await app.inject({ method: "PUT", url: "/v1/compte-marchand", headers: entetes(p.tenant),
                                        payload: { fournisseur: "pawapay", cles: { jeton: JETON, environnement: "sandbox" } } });
      assert.equal(change.statusCode, 409);
      // Callback sans clientReferenceId : paiement retrouvé par depositId.
      const dep2 = faux.depots.get(depositIdDe(second.reference))!;
      dep2.status = "COMPLETED";
      const { clientReferenceId: _c, ...sansRef } = faux.donnees(dep2);
      const corps2 = JSON.stringify(sansRef);
      const cb2 = await app.inject({ method: "POST", url: chemin, payload: corps2,
        headers: { host: "api.test.invalid", ...callbackSigne(corps2, { autorite: "api.test.invalid", chemin, cle: faux.cle }) } });
      assert.equal(cb2.statusCode, 200, cb2.body);
      assert.equal(cb2.json().statut, "SUCCEEDED");
    });
  } finally {
    delete process.env.WAKATNET_PAWAPAY_URL;
  }
});

/** Propriétaire prêt à vendre par pawaPay (bac à sable, faux serveur) : forfait de 200 F, hôte du hotspot, crédits. */
async function vendeurPawapay(app: Parameters<Parameters<typeof avecApp>[0]>[0], nom: string) {
  const p = await proprietaire(nom);
  const [plan] = await sql<{ id: string }>(URL_ADMIN,
    "INSERT INTO app.plan (tenant_id, nom, prix_xof, uptime_limit_s) VALUES ($1, '1 heure', 200, 3600) RETURNING id::text", [p.tenant]);
  const [s] = await sql<{ public_id: string }>(URL_ADMIN, "UPDATE app.site SET hotspot_hotes = '{10.5.50.1}' WHERE id = $1 RETURNING public_id", [p.site]);
  await sql(URL_ADMIN, "SELECT app.credits_recharger($1, 10000, $2)", [p.tenant, `pp-${p.tenant}`]);
  const r = await app.inject({ method: "PUT", url: "/v1/compte-marchand", headers: entetes(p.tenant),
                               payload: { fournisseur: "pawapay", cles: { jeton: JETON, environnement: "sandbox" } } });
  assert.equal(r.statusCode, 200, r.body);
  return { ...p, plan: plan.id, publicId: s.public_id, chemin: new URL(r.json().url_webhook).pathname };
}

test("audit du 13/11/2026 : PUT /v1/compte-marchand → 5 vérifications chez le fournisseur par heure et par propriétaire ; paiements ouverts → 409 SANS appel au fournisseur", async () => {
  process.env.WAKATNET_PAWAPAY_URL = faux.url;
  try {
    await avecApp(async (app) => {
      const confs = () => faux.requetes.filter((r) => r.chemin === "/v2/active-conf").length;
      const p = await vendeurPawapay(app, "pawaPay limite de vérification");           // 1re vérification
      const faux_jeton = (i: number) => ({ fournisseur: "pawapay", cles: { jeton: `jeton-refuse-${i}-0123456789abcdef`, environnement: "sandbox" } });
      for (let i = 2; i <= 5; i++) {
        const r = await app.inject({ method: "PUT", url: "/v1/compte-marchand", headers: entetes(p.tenant), payload: faux_jeton(i) });
        assert.equal(r.statusCode, 422, `vérification ${i}`);
      }
      const avant = confs();
      for (let i = 6; i <= 9; i++) {
        const r = await app.inject({ method: "PUT", url: "/v1/compte-marchand", headers: entetes(p.tenant), payload: faux_jeton(i) });
        assert.equal(r.statusCode, 429, `vérification ${i} : ${r.body}`);
      }
      assert.equal(confs(), avant, "au-delà de 5 par heure, plus aucun appel à GET /v2/active-conf");
      // Limite PAR propriétaire : un autre n'est pas gêné.
      await vendeurPawapay(app, "pawaPay autre propriétaire");

      // Paiement encore ouvert : 409 avant tout appel au fournisseur (relecture : sinon l'appel serait fait pour rien).
      const q = await vendeurPawapay(app, "pawaPay 409 avant le fournisseur");
      const achat = await app.paiement!.creer({ sitePublic: q.publicId, planId: BigInt(q.plan), operateur: "moov_bf", numero: "02345678",
                                                jetonAppareil: jeton(), soumission: soumission() });
      if (achat.statut !== "cree") assert.fail(achat.statut);
      const n = confs();
      const change = await app.inject({ method: "PUT", url: "/v1/compte-marchand", headers: entetes(q.tenant),
                                        payload: { fournisseur: "pawapay", cles: { jeton: JETON, environnement: "sandbox" } } });
      assert.equal(change.statusCode, 409, change.body);
      assert.equal(confs(), n, "409 décidé sans appeler pawaPay");
    });
  } finally {
    delete process.env.WAKATNET_PAWAPAY_URL;
  }
});

test("audit du 13/11/2026 : charge() sans réponse (paiement CREATED), puis callback SANS clientReferenceId → retrouvé par depositId et confirmé", async () => {
  process.env.WAKATNET_PAWAPAY_URL = faux.url;
  try {
    await avecApp(async (app) => {
      const p = await vendeurPawapay(app, "pawaPay callback après charge expirée");
      // pawaPay a reçu le dépôt, mais sa réponse s'est perdue (ici : 500) : issue inconnue, le paiement reste CREATED.
      faux.prochaineReponse = { statut: 500, corps: { failureReason: { failureCode: "UNKNOWN_ERROR" } } };
      const achat = await app.paiement!.creer({ sitePublic: p.publicId, planId: BigInt(p.plan), operateur: "moov_bf", numero: "02345678",
                                                jetonAppareil: jeton(), soumission: soumission() });
      if (achat.statut !== "cree") assert.fail(achat.statut);
      assert.equal(achat.statutPaiement, "CREATED");
      const depositId = depositIdDe(achat.reference);
      const [ligne] = await sql<{ statut: string; reference_fournisseur: string | null }>(URL_ADMIN,
        "SELECT statut, reference_fournisseur FROM app.payment WHERE reference = $1", [achat.reference]);
      assert.deepEqual(ligne, { statut: "CREATED", reference_fournisseur: depositId }, "depositId noté AVANT charge()");
      faux.depots.set(depositId, { depositId, status: "COMPLETED", amount: "200", currency: "XOF", provider: "MOOV_BFA", phoneNumber: "22602345678" });
      const corps = JSON.stringify(faux.donnees(faux.depots.get(depositId)!));        // sans clientReferenceId
      assert.ok(!corps.includes("clientReferenceId"));
      const cb = await app.inject({ method: "POST", url: p.chemin, payload: corps,
        headers: { host: "api.test.invalid", ...callbackSigne(corps, { autorite: "api.test.invalid", chemin: p.chemin, cle: faux.cle }) } });
      assert.equal(cb.statusCode, 200, cb.body);
      assert.deepEqual(cb.json(), { ok: true, statut: "SUCCEEDED" }, "avant le correctif : « paiement inconnu de ce compte », ignoré");
      const [pay] = await sql<{ statut: string; voucher: boolean }>(URL_ADMIN,
        "SELECT statut, voucher_id IS NOT NULL AS voucher FROM app.payment WHERE reference = $1", [achat.reference]);
      assert.deepEqual(pay, { statut: "SUCCEEDED", voucher: true });
    });
  } finally {
    delete process.env.WAKATNET_PAWAPAY_URL;
  }
});
