// WAKATNET — charge HTTP du portail et du paiement (phase 5, ticket 07). Lancé par tests/charge.sh.
// Générateur dans SON processus ; l'API tourne à part (src/serveur.ts, configuration de production,
// MockProvider). Boucle fermée : WAKATNET_CHARGE_CONCURRENCE requêtes en vol, pendant WAKATNET_CHARGE_DUREE_S.
//   1. GET  /p/:site            (page d'accueil du portail, la plus servie)
//   2. GET  /p/:site/forfaits
//   3. POST /p/:site/payer      (création de paiement → MockProvider → webhook signé → ticket)
// Puis : tous les paiements créés sont-ils confirmés par leur webhook ?
import { randomBytes } from "node:crypto";
import { construire } from "../../src/app.ts";
import { ouvrirBase } from "../../src/base.ts";
import { lireCle } from "../../src/chiffrement.ts";
import { config, sql, URL_ADMIN } from "../aide.ts";
import { vendeur, type Vendeur } from "../aide-paiement.ts";

const BASE = process.env.WAKATNET_CHARGE_URL ?? "http://127.0.0.1:3000";
const CONCURRENCE = Number(process.env.WAKATNET_CHARGE_CONCURRENCE ?? "20");
const DUREE_MS = Number(process.env.WAKATNET_CHARGE_DUREE_S ?? "20") * 1000;

// Mêmes clés que le serveur (sinon le compte marchand préparé ici serait indéchiffrable par lui).
const cles = { marchands: lireCle(process.env.WAKATNET_CLE_MARCHANDS, "marchands", 32), hmac: lireCle(process.env.WAKATNET_CLE_HMAC, "hmac") };
const base = ouvrirBase(config().urlBase);
const prep = construire(config({ cles }), base, { journal: false });
const v = await vendeur(prep, "charge HTTP", { recharge: 10_000_000 });
// Paiement : 30 créations par minute et par site au plus (garde anti-abus, migration 0022). La capacité
// se mesure sur le PARC : SITES propriétaires, débit fixe sous cette limite.
const SITES = Number(process.env.WAKATNET_CHARGE_SITES ?? "300");
const DEBIT_PAIEMENT = Number(process.env.WAKATNET_CHARGE_DEBIT_PAIEMENT ?? "100");
const parc: Vendeur[] = [];
for (let i = 0; i < SITES; i++) parc.push(await vendeur(prep, `charge ${i}`, { recharge: 1_000_000 }));
await prep.close();

const quantile = (t: number[], q: number) => t.length ? Math.round(t[Math.min(t.length - 1, Math.floor(q * t.length))] * 10) / 10 : null;
// Numéros tous différents : 70 + compteur + 00 (scénario normal du mock).
let compteurNumero = 0;
const numero = () => `70${String(compteurNumero++ % 10_000).padStart(4, "0")}00`;

async function palier(nom: string, requete: () => Promise<Response>, attendu: number[]) {
  const durees: number[] = [];
  const statuts: Record<string, number> = {};
  const fin = Date.now() + DUREE_MS;
  const debut = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCE }, async () => {
    while (Date.now() < fin) {
      const t0 = performance.now();
      let s = "erreur_reseau";
      try {
        const r = await requete();
        await r.arrayBuffer();
        s = String(r.status);
      } catch { /* compté comme erreur réseau */ }
      durees.push(performance.now() - t0);
      statuts[s] = (statuts[s] ?? 0) + 1;
    }
  }));
  const s = (performance.now() - debut) / 1000;
  durees.sort((a, b) => a - b);
  const erreurs = Object.entries(statuts).filter(([k]) => !attendu.map(String).includes(k)).reduce((n, [, x]) => n + x, 0);
  const res = { palier: nom, concurrence: CONCURRENCE, duree_s: Math.round(s), requetes: durees.length,
    debit_par_s: Math.round(durees.length / s), erreurs, statuts,
    latence_ms: { p50: quantile(durees, 0.5), p95: quantile(durees, 0.95), p99: quantile(durees, 0.99), max: quantile(durees, 1) } };
  console.log(JSON.stringify(res));
  return res;
}

await palier("portail-accueil", () => fetch(`${BASE}/p/${v.publicId}`, { redirect: "manual" }), [200]);
await palier("portail-forfaits", () => fetch(`${BASE}/p/${v.publicId}/forfaits`, { redirect: "manual" }), [200]);
// Limite par site : un site au-delà de 30 créations par minute reçoit 429 (mesuré tel quel, concurrence pleine).
await palier("paiement-limite-par-site", () => fetch(`${BASE}/p/${v.publicId}/payer`, {
  method: "POST", redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", cookie: `wk_app=${randomBytes(32).toString("base64url")}` },
  body: new URLSearchParams({ plan: v.plan, operateur: "moov_bf", numero: numero(), soumission: randomBytes(16).toString("base64url") }),
}), [303, 429]);

// Capacité du parc : débit FIXE (boucle ouverte), réparti sur les sites, sous leur limite.
async function paiementsDebitFixe() {
  const durees: number[] = [];
  const statuts: Record<string, number> = {};
  const envois: Promise<void>[] = [];
  const pas = 1000 / DEBIT_PAIEMENT;
  const debut = performance.now();
  for (let i = 0; performance.now() - debut < DUREE_MS; i++) {
    const cible = debut + i * pas;
    const attente = cible - performance.now();
    if (attente > 0) await new Promise((x) => setTimeout(x, attente));
    const site = parc[i % parc.length];
    envois.push((async () => {
      const t0 = performance.now();
      let st = "erreur_reseau";
      try {
        const r = await fetch(`${BASE}/p/${site.publicId}/payer`, {
          method: "POST", redirect: "manual",
          headers: { "content-type": "application/x-www-form-urlencoded", cookie: `wk_app=${randomBytes(32).toString("base64url")}` },
          body: new URLSearchParams({ plan: site.plan, operateur: "moov_bf", numero: numero(), soumission: randomBytes(16).toString("base64url") }),
        });
        await r.arrayBuffer();
        st = String(r.status);
      } catch { /* erreur réseau */ }
      durees.push(performance.now() - t0);
      statuts[st] = (statuts[st] ?? 0) + 1;
    })());
  }
  await Promise.all(envois);
  durees.sort((a, b) => a - b);
  const res = { palier: "paiement-parc-debit-fixe", sites: parc.length, debit_vise_par_s: DEBIT_PAIEMENT, requetes: durees.length,
    erreurs: Object.entries(statuts).filter(([k]) => k !== "303").reduce((n, [, x]) => n + x, 0), statuts,
    latence_ms: { p50: quantile(durees, 0.5), p95: quantile(durees, 0.95), p99: quantile(durees, 0.99), max: quantile(durees, 1) } };
  console.log(JSON.stringify(res));
  return res;
}
const tenants = parc.map((x) => x.tenant);
const achat = await paiementsDebitFixe();
// Les webhooks du mock arrivent en différé : on laisse 30 s au plus pour que tout soit confirmé.
const fin = Date.now() + 30_000;
let etat: { statut: string; n: number }[] = [];
while (Date.now() < fin) {
  etat = await sql<{ statut: string; n: number }>(URL_ADMIN,
    "SELECT statut, count(*)::int AS n FROM app.payment WHERE tenant_id = ANY($1::bigint[]) GROUP BY 1 ORDER BY 1", [tenants]);
  if (etat.every((e) => e.statut === "SUCCEEDED")) break;
  await new Promise((x) => setTimeout(x, 500));
}
const crees = etat.reduce((n, e) => n + e.n, 0);
console.log(JSON.stringify({ paiements_crees_sur_le_parc: crees, redirections_303: achat.statuts["303"] ?? 0,
  tous_confirmes_par_webhook: etat.every((e) => e.statut === "SUCCEEDED"), statuts_finaux: etat }));
await base.$disconnect();
