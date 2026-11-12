// ADR 0012 §7 : l'identité de développement ne peut pas tourner en production.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cheminMasque } from "../src/app.ts";
import { ConfigInvalide, lireConfig } from "../src/config.ts";

const URL = { WAKATNET_API_DATABASE_URL: "postgresql://x@h/d" };

test("URL de base absente, URL publique invalide : refus de démarrer", () => {
  assert.throws(() => lireConfig({}), ConfigInvalide);
  assert.throws(() => lireConfig({ ...URL, WAKATNET_API_URL_PUBLIQUE: "http://api.x" }), ConfigInvalide);
  assert.throws(() => lireConfig({ ...URL, WAKATNET_API_URL_PUBLIQUE: "https://api.x/chemin" }), ConfigInvalide);
});

test("le jeton d'enrôlement est masqué dans le chemin journalisé", () => {
  assert.equal(cheminMasque("/enroll/abcDEF123-_"), "/enroll/***");
  assert.equal(cheminMasque("/enroll/abc?x=1"), "/enroll/***");
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
});
