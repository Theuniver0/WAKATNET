// ADR 0019 : adaptateur Brevo (contre un faux serveur local) et réglage par l'environnement.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ConfigInvalide, lireConfig } from "../src/config.ts";
import { ExpediteurBrevo, messageAttente, messageAvis, messageVerification } from "../src/courriel.ts";

const CLE = "xkeysib-" + "a".repeat(40);

async function fauxBrevo(statut: number) {
  const recues: { methode: string; url: string; entetes: Record<string, unknown>; corps: string }[] = [];
  const srv = createServer((req, rep) => {
    let corps = "";
    req.on("data", (d) => (corps += d));
    req.on("end", () => {
      recues.push({ methode: req.method!, url: req.url!, entetes: req.headers, corps });
      rep.writeHead(statut, { "content-type": "application/json" }).end(JSON.stringify({ message: "détail qui citerait l'adresse" }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v3/smtp/email`;
  return { recues, url, fermer: () => new Promise<void>((r) => srv.close(() => r())) };
}

test("Brevo : POST /v3/smtp/email, clé dans l'en-tête api-key, expéditeur, destinataire, sujet et texte", async () => {
  const f = await fauxBrevo(201);
  try {
    const m = messageVerification("proprio@exemple.bf", "https://api.exemple.bf/tableau/#/verifier?j=" + "J".repeat(43));
    await new ExpediteurBrevo({ cle: CLE, de: "ne-pas-repondre@notif.exemple.bf", nom: "WAKATNET" }, f.url).envoyer(m);
    assert.equal(f.recues.length, 1);
    const r = f.recues[0];
    assert.equal(r.methode, "POST");
    assert.equal(r.url, "/v3/smtp/email");
    assert.equal(r.entetes["api-key"], CLE);
    assert.equal(r.entetes["content-type"], "application/json");
    assert.deepEqual(JSON.parse(r.corps), { sender: { email: "ne-pas-repondre@notif.exemple.bf", name: "WAKATNET" },
      to: [{ email: "proprio@exemple.bf" }], subject: m.sujet, textContent: m.texte });
  } finally {
    await f.fermer();
  }
});

test("Brevo : une réponse d'erreur lève une erreur qui ne cite que le code HTTP, jamais le corps ni la clé", async () => {
  const f = await fauxBrevo(401);
  try {
    await assert.rejects(new ExpediteurBrevo({ cle: CLE, de: "a@exemple.bf", nom: "W" }, f.url).envoyer(messageAvis("x@exemple.bf", "https://t/")),
      (e: Error) => e.message === "brevo : réponse 401" && !e.message.includes(CLE));
  } finally {
    await f.fermer();
  }
});

test("réglage : WAKATNET_COURRIEL=brevo exige une clé valable et une adresse d'expéditeur ; absent, aucun envoi", () => {
  const base = { WAKATNET_API_DATABASE_URL: "postgresql://x@127.0.0.1/x" };
  assert.equal(lireConfig(base).courriel, undefined);
  assert.deepEqual(lireConfig({ ...base, WAKATNET_COURRIEL: "brevo", WAKATNET_BREVO_CLE: CLE, WAKATNET_COURRIEL_DE: "ne-pas-repondre@notif.exemple.bf" }).courriel,
    { fournisseur: "brevo", cle: CLE, de: "ne-pas-repondre@notif.exemple.bf", nom: "WAKATNET" });
  assert.throws(() => lireConfig({ ...base, WAKATNET_COURRIEL: "smtp" }), ConfigInvalide);
  assert.throws(() => lireConfig({ ...base, WAKATNET_COURRIEL: "brevo", WAKATNET_COURRIEL_DE: "a@exemple.bf" }), /WAKATNET_BREVO_CLE/);
  assert.throws(() => lireConfig({ ...base, WAKATNET_COURRIEL: "brevo", WAKATNET_BREVO_CLE: CLE, WAKATNET_COURRIEL_DE: "pas une adresse" }), /WAKATNET_COURRIEL_DE/);
});

test("avis « compte en attente » (F2) : rien n'est modifié, mot de passe choisi à la confirmation, aucun lien, renvoi depuis l'écran de connexion", () => {
  const m = messageAttente("proprio@exemple.bf", "https://api.exemple.bf/tableau/");
  assert.equal(m.a, "proprio@exemple.bf");
  assert.doesNotMatch(m.texte, /verifier\?j=/, "aucun lien de confirmation dans l'avis");
  assert.match(m.texte, /https:\/\/api\.exemple\.bf\/tableau\/#\/connexion/);
  assert.match(m.texte, /choisirez votre mot de passe au moment de confirmer/);
  assert.doesNotMatch(m.texte, /dernière demande/);
});
