// login.html (ticket 04 ; ADR 0006 §15) : le code est mis en majuscules AVANT le hachage CHAP,
// le MD5 intégré est exact, la page est autonome et légère (SPEC §7.1 : < 100 Ko, aucun fichier externe).
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const PAGE = readFileSync(new URL("../../../routeros/hotspot/login.html", import.meta.url), "utf8");

/** Rendu minimal à la manière du serveur hotspot : $(if x)…$(else)…$(endif) et $(variable). */
function rendre(modele: string, vars: Record<string, string>): string {
  let s = modele.replace(/\$\(if ([a-z-]+)\)([\s\S]*?)(?:\$\(else\)([\s\S]*?))?\$\(endif\)/g,
    (_m, nom: string, alors: string, sinon = "") => (vars[nom] ? alors : sinon));
  s = s.replace(/\$\(([a-z-]+)\)/g, (_m, nom: string) => vars[nom] ?? "");
  return s;
}

/** Octets → littéral JavaScript en échappements octaux, comme $(chap-id) et $(chap-challenge). */
const octal = (b: Buffer) => [...b].map((x) => "\\" + x.toString(8).padStart(3, "0")).join("");

function soumettre(html: string, saisie: string): { username: string; password: string } {
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
  const envoi = { username: { value: "" }, password: { value: "" }, submit() {} };
  const document = { saisie: { code: { value: saisie, focus() {} } }, envoi };
  vm.runInNewContext(script + "\nenvoyer();", { document });
  return { username: envoi.username.value, password: envoi.password.value };
}

test("MD5 intégré exact sur 200 entrées aléatoires d'octets (0 à 255), longueurs 0 à 130", () => {
  const script = /<script>([\s\S]*)<\/script>/.exec(PAGE)![1].replace(/document\.saisie\.code\.focus\(\);/, "");
  const ctx = vm.createContext({});
  vm.runInContext(script.replace(/\$\([^)]*\)/g, ""), ctx);
  for (let i = 0; i < 200; i++) {
    const b = randomBytes(i % 131);
    const chaine = String.fromCharCode(...b);
    assert.equal(vm.runInContext(`md5(${JSON.stringify(chaine)})`, ctx), createHash("md5").update(b).digest("hex"), `longueur ${b.length}`);
  }
});

test("CHAP : md5(chap-id + CODE EN MAJUSCULES + challenge) ; identifiant en majuscules", () => {
  const id = randomBytes(1);
  const defi = randomBytes(16);
  const html = rendre(PAGE, { "chap-id": octal(id), "chap-challenge": octal(defi), "link-login-only": "http://h/login" });
  const r = soumettre(html, " ab3k 9mzq ");
  assert.equal(r.username, "AB3K9MZQ");
  assert.equal(r.password, createHash("md5").update(Buffer.concat([id, Buffer.from("AB3K9MZQ"), defi])).digest("hex"));
});

test("PAP (sans chap-id) : mot de passe = code en majuscules", () => {
  const r = soumettre(rendre(PAGE, { "link-login-only": "http://h/login" }), "ab3k9mzq");
  assert.deepEqual(r, { username: "AB3K9MZQ", password: "AB3K9MZQ" });
});

test("page autonome et légère", () => {
  assert.ok(Buffer.byteLength(PAGE) < 100 * 1024);
  assert.ok(!/(src|href)=["']?(https?:)?\/\//i.test(PAGE), "aucune ressource externe");
  assert.ok(!/<link|@import|url\(/i.test(PAGE));
});
