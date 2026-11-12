// Tableau de bord servi sous /tableau/ (ADR 0014 §5) : CSP stricte, repli sur index.html,
// aucun accès disque par requête. Ticket : .scratch/phase-4-exploitation/issues/08-tableau-de-bord.md
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { avecApp, config } from "./aide.ts";

function dist(): string {
  const d = mkdtempSync(join(tmpdir(), "wakatnet-tableau-"));
  mkdirSync(join(d, "assets"));
  writeFileSync(join(d, "index.html"), '<!doctype html><script type="module" src="/tableau/assets/index-abc.js"></script>');
  writeFileSync(join(d, "assets", "index-abc.js"), "console.log(1)");
  writeFileSync(join(d, "assets", "style-abc.css"), "body{}");
  writeFileSync(join(d, "secret.txt"), "jamais servi : extension inconnue");
  return d;
}

test("/tableau/ : index, assets immuables, CSP stricte sans unsafe-inline, repli du routeur", async () => {
  await avecApp(async (app) => {
    const i = await app.inject({ url: "/tableau/" });
    assert.equal(i.statusCode, 200);
    assert.match(String(i.headers["content-type"]), /^text\/html/);
    const csp = String(i.headers["content-security-policy"]);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.equal(i.headers["cache-control"], "no-store");
    assert.equal(i.headers["x-content-type-options"], "nosniff");

    const a = await app.inject({ url: "/tableau/assets/index-abc.js" });
    assert.equal(a.statusCode, 200);
    assert.match(String(a.headers["content-type"]), /^text\/javascript/);
    assert.match(String(a.headers["cache-control"]), /immutable/);
    assert.equal((await app.inject({ url: "/tableau/assets/style-abc.css" })).headers["content-type"], "text/css; charset=utf-8");

    assert.equal((await app.inject({ url: "/tableau/lots" })).body, i.body, "chemin sans extension : index.html");
    assert.equal((await app.inject({ url: "/tableau" })).statusCode, 308);
    for (const u of ["/tableau/assets/absent.js", "/tableau/secret.txt", "/tableau/../package.json",
                     "/tableau/%2e%2e/%2e%2e/package.json", "/tableau/assets/..%2f..%2findex.html"]) {
      const r = await app.inject({ url: u });
      assert.ok(r.statusCode === 404 || (r.statusCode === 200 && r.body === i.body), `${u} : ${r.statusCode}`);
      assert.doesNotMatch(r.body, /jamais servi|"name"/);
    }
  }, config({ dossierTableau: dist() }));
});

test("/tableau/ sans fichiers construits : 503, le reste de l'API répond", async () => {
  await avecApp(async (app) => {
    const r = await app.inject({ url: "/tableau/" });
    assert.equal(r.statusCode, 503);
    assert.ok(r.headers["content-security-policy"]);
    assert.equal((await app.inject({ url: "/v1/moi" })).statusCode, 401, "le reste de l'API répond");
  }, config({ dossierTableau: join(tmpdir(), "wakatnet-inexistant") }));
});
