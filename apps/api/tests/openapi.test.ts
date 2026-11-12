// Le contrat OpenAPI (ADR 0012 §4) décrit exactement les routes servies, ni plus ni moins.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { construire } from "../src/app.ts";
import { ouvrirBase } from "../src/base.ts";
import { config } from "./aide.ts";

test("chaque route servie est dans openapi.yaml, et réciproquement", async () => {
  const texte = readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8");
  const contrat = new Set<string>();
  let chemin = "";
  for (const ligne of texte.split("\n")) {
    const p = /^  (\/[^:]+):$/.exec(ligne);
    if (p) { chemin = p[1].replace(/\{([^}]+)\}/g, ":$1"); continue; }
    const m = /^    (get|post|put|patch|delete):/.exec(ligne);
    if (m && chemin) contrat.add(`${m[1].toUpperCase()} ${chemin}`);
  }
  const base = ouvrirBase(config().urlBase);
  const app = construire(config(), base, { journal: false });
  const servies = new Set<string>();
  app.addHook("onRoute", (r) => {
    for (const m of [r.method].flat()) if (m !== "HEAD") servies.add(`${m} ${r.url}`);
  });
  await app.ready();
  await app.close();
  await base.$disconnect();
  assert.deepEqual([...servies].sort(), [...contrat].sort());
});
