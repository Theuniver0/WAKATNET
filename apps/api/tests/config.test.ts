// ADR 0012 §7 : l'identité de développement ne peut pas tourner en production.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cheminMasque } from "../src/app.ts";
import { readFileSync } from "node:fs";
import { ConfigInvalide, lireConfig, lireRacinesTls } from "../src/config.ts";

// Racine d'essai (certificat public seul, clé détruite) : tests seulement.
const RACINE = `${import.meta.dirname}/racines-essai/racine.pem`;
const RACINES = { WAKATNET_RACINES_TLS: RACINE };

const URL = { WAKATNET_API_DATABASE_URL: "postgresql://x@h/d" };

// Clés de test seulement (32 octets nuls en base64) : aucune valeur réelle.
const CLES = { WAKATNET_CLE_MARCHANDS: Buffer.alloc(32).toString("base64"), WAKATNET_CLE_HMAC: Buffer.alloc(32).toString("base64") };

test("URL de base absente, URL publique invalide : refus de démarrer", () => {
  assert.throws(() => lireConfig({}), ConfigInvalide);
  assert.throws(() => lireConfig({ ...URL, WAKATNET_API_URL_PUBLIQUE: "http://api.x" }), ConfigInvalide);
  assert.throws(() => lireConfig({ ...URL, WAKATNET_API_URL_PUBLIQUE: "https://api.x/chemin" }), ConfigInvalide);
});

test("le jeton d'enrôlement est masqué dans le chemin journalisé", () => {
  assert.equal(cheminMasque("/enroll/abcDEF123-_"), "/enroll/***");
  assert.equal(cheminMasque("/enroll/abc?x=1"), "/enroll/***");
  assert.equal(cheminMasque("/entretien/abcDEF123-_"), "/entretien/***", "jeton d'entretien (ADR 0023) jamais journalisé");
  // Revue de sécurité M5 : aucune chaîne de requête dans le journal (page demandée par le client du hotspot).
  assert.equal(cheminMasque("/p/ABCDEFGHIJKLMNOP?l=http%3A%2F%2F10.5.50.1%2Flogin&o=http%3A%2F%2Fexemple.bf%2F"), "/p/ABCDEFGHIJKLMNOP");
  assert.equal(cheminMasque("/v1/sites"), "/v1/sites");
  assert.equal(cheminMasque("/webhooks/mock/abcdefghijklmnopqrstuvwx"), "/webhooks/mock/***");
});

test("WAKATNET_NOEUDS : un ou deux nœuds bien formés, sinon refus de démarrer", () => {
  const n = { nom: "A", overlay: "10.213.0.1", cle: "A".repeat(43) + "=", endpoint: "192.0.2.10", port: 51820 };
  assert.deepEqual(lireConfig({ ...URL, WAKATNET_NOEUDS: JSON.stringify([n]) }).noeuds, [n]);
  assert.deepEqual(lireConfig(URL).noeuds, []);
  for (const mauvais of ["pas du json", "[]", JSON.stringify([n, n, n]),
                         JSON.stringify([{ ...n, overlay: "10.213.1.1" }]),
                         JSON.stringify([{ ...n, cle: "A".repeat(44) }]),
                         JSON.stringify([{ ...n, endpoint: "noeud-a.exemple" }]),
                         JSON.stringify([{ ...n, port: 0 }]), JSON.stringify([{ ...n, nom: "a" }])]) {
    assert.throws(() => lireConfig({ ...URL, WAKATNET_NOEUDS: mauvais }), ConfigInvalide, mauvais);
  }
});

test("WAKATNET_TRUST_PROXY (ADR 0016 §2) : adresses seulement ; absent, aucune confiance", async () => {
  const URL = { WAKATNET_API_DATABASE_URL: "postgresql://x@127.0.0.1/x" };
  assert.equal(lireConfig(URL).trustProxy, undefined);
  assert.equal(lireConfig({ ...URL, WAKATNET_TRUST_PROXY: "127.0.0.1" }).trustProxy, "127.0.0.1");
  assert.throws(() => lireConfig({ ...URL, WAKATNET_TRUST_PROXY: "true" }), ConfigInvalide);
  // En production, son absence ramènerait toutes les requêtes à une seule source (M2, M7) : refusé.
  assert.throws(() => lireConfig({ ...URL, NODE_ENV: "production", ...CLES }), /WAKATNET_TRUST_PROXY requis en production/);
  assert.equal(lireConfig({ ...URL, NODE_ENV: "production", WAKATNET_TRUST_PROXY: "127.0.0.1", WAKATNET_PORTAIL_IPS: "203.0.113.10", ...CLES, ...RACINES }).trustProxy, "127.0.0.1");
});

test("WAKATNET_CLE_HMAC requise en production : sans elle, les IP sources resteraient en clair (T10, ADR 0016 §2)", () => {
  const URL = { WAKATNET_API_DATABASE_URL: "postgresql://x@127.0.0.1/x", WAKATNET_TRUST_PROXY: "127.0.0.1" };
  // Hors production, l'absence reste admise (routes de paiement en 503, sources en clair : tests, développement).
  assert.equal(lireConfig(URL).cles, null);
  assert.throws(() => lireConfig({ ...URL, NODE_ENV: "production" }), /WAKATNET_CLE_HMAC requise en production/);
  assert.throws(() => lireConfig({ ...URL, NODE_ENV: "production", WAKATNET_CLE_HMAC: "" }), /WAKATNET_CLE_HMAC requise en production/);
  assert.throws(() => lireConfig({ ...URL, NODE_ENV: "production", WAKATNET_CLE_MARCHANDS: CLES.WAKATNET_CLE_MARCHANDS }),
                /WAKATNET_CLE_HMAC/);
  assert.ok(lireConfig({ ...URL, NODE_ENV: "production", WAKATNET_TRUST_PROXY: "127.0.0.1", WAKATNET_PORTAIL_IPS: "203.0.113.10", ...CLES, ...RACINES }).cles?.hmac.length === 32);
});

test("WAKATNET_PORTAIL_IPS (walled garden, SPEC §7.1) : IPv4 séparées par des virgules ; exigée en production", () => {
  assert.deepEqual(lireConfig({ ...URL, WAKATNET_PORTAIL_IPS: " 203.0.113.10, 198.51.100.20 " }).portailIps, ["203.0.113.10", "198.51.100.20"]);
  assert.deepEqual(lireConfig(URL).portailIps, []);
  for (const mauvais of ["203.0.113.256", "portail.x", "203.0.113.10/24", "2001:db8::1"]) {
    assert.throws(() => lireConfig({ ...URL, WAKATNET_PORTAIL_IPS: mauvais }), ConfigInvalide, mauvais);
  }
  assert.throws(() => lireConfig({ ...URL, NODE_ENV: "production", WAKATNET_TRUST_PROXY: "127.0.0.1", ...CLES }), /WAKATNET_PORTAIL_IPS exigée en production/);
});

test("relecture n° 2 : nom d'hôte du portail vérifié au démarrage (règle du walled garden)", () => {
  for (const mauvais of ["https://portail", "https://-x.bf", "https://portail.:8443", "https://a..b"]) {
    assert.throws(() => lireConfig({ ...URL, WAKATNET_PORTAIL_URL_PUBLIQUE: mauvais }), ConfigInvalide, mauvais);
  }
  assert.equal(lireConfig({ ...URL, WAKATNET_PORTAIL_URL_PUBLIQUE: "https://portail.wakatnet.bf:8443" }).urlPortail, "https://portail.wakatnet.bf:8443");
});

test("WAKATNET_RACINES_TLS (ADR 0003 : pas de magasin de racines avant RouterOS 7.19) : racines auto-signées valides ; exigée en production", () => {
  const PROD = { ...URL, NODE_ENV: "production", WAKATNET_TRUST_PROXY: "127.0.0.1", WAKATNET_PORTAIL_IPS: "203.0.113.10", ...CLES };
  assert.throws(() => lireConfig(PROD), /WAKATNET_RACINES_TLS exigée en production/);
  const [r] = lireConfig({ ...PROD, ...RACINES }).racinesTls!;
  assert.match(r.empreinte, /^[0-9a-f]{64}$/, "empreinte au format du routeur (/certificate fingerprint)");
  assert.equal(lireConfig(URL).racinesTls, undefined, "hors production : facultative");
  const pem = readFileSync(RACINE, "utf8");
  const feuille = readFileSync(`${import.meta.dirname}/racines-essai/feuille.pem`, "utf8");
  assert.throws(() => lireRacinesTls(pem + pem), /en double/);
    assert.throws(() => lireRacinesTls(feuille), /n'est pas une racine/, "certificat signé par une autre autorité");
  assert.throws(() => lireRacinesTls(pem.repeat(4)), /1 à 3/);
  assert.throws(() => lireRacinesTls(pem.replace(/\n[A-Za-z0-9+/]{8}/, "\nAAAAAAAA")), /illisible|n'est pas une racine/, "base64 abîmé : refus clair");
  assert.throws(() => lireRacinesTls(pem + "\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"), /rien d'autre/, "jamais de clé à côté");
  assert.throws(() => lireRacinesTls(""), /1 à 3/);
  assert.throws(() => lireRacinesTls(pem, new Date("2047-01-01")), /validité/);
  assert.throws(() => lireConfig({ ...URL, WAKATNET_RACINES_TLS: "/inexistant/racines.pem" }), /illisible/);
});
