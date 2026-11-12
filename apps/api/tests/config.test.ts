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
  assert.equal(cheminMasque("/enroll/abc?x=1"), "/enroll/***?x=1");
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
