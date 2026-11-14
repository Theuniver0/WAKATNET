// WAKATNET — essai de l'adaptateur CinetPay contre le VRAI bac à sable (ADR 0022, « [À CONFIRMER] au bac à sable »).
// À lancer par Yacouba sur son poste, avec ses clés de TEST :
//
//     node --experimental-strip-types --no-warnings packages/payments/essais/cinetpay-bac-a-sable.ts
//
// Les clés sont demandées à l'invite, sans écho : jamais en argument, jamais dans une variable d'environnement, jamais
// écrites. Seules les clés `sk_test_` sont acceptées, et seule l'adresse du bac à sable est appelée. Chaque paiement est de
// 100 F CFA sur un numéro de test. Le rapport (rapport-cinetpay-<date>.json) ne contient que la FORME des réponses
// (clés, statut, code, montant, devise) : jetons, identifiants, numéros et adresses y sont masqués. C'est lui qu'on
// renvoie pour trancher les points de l'ADR 0022.
//
// Auto-essai sans réseau : WAKATNET_ESSAI_FAUX=1 lance le faux serveur des tests (apps/api/tests/aide-cinetpay.ts).
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { CinetpayProvider, URL_CINETPAY, type ClesCinetpay } from "../src/cinetpay.ts";

/** Clés gardées telles quelles dans le rapport ; toute autre chaîne est remplacée par sa seule longueur. */
const EN_CLAIR = new Set(["status", "code", "message", "currency", "amount", "payment_method", "channel", "must_be_redirected",
                          "description", "lang"]);

function forme(v: unknown, cle = ""): unknown {
  if (Array.isArray(v)) return v.slice(0, 5).map((x) => forme(x));
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, forme(x, k)]));
  }
  if (typeof v === "string") return EN_CLAIR.has(cle) ? v.slice(0, 120) : `<chaîne de ${v.length} caractères>`;
  if (typeof v === "number") return EN_CLAIR.has(cle) ? v : "<nombre>";
  return v;
}

function decrire(e: unknown): string {
  return e instanceof Error ? `${e.constructor.name} : ${e.message}` : String(e);
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
let masquer = false;
// Sans écho pendant la saisie d'une clé : l'invite est écrite à part (demander), readline n'affiche rien d'autre.
(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = function (s: string) {
  if (!masquer) process.stdout.write(s);
};
// File des lignes reçues : une entrée redirigée (auto-essai) arrive d'un bloc, avant les questions.
const lignes: string[] = [];
const enAttente: ((l: string) => void)[] = [];
let fermee = false;
rl.on("line", (l) => { const f = enAttente.shift(); if (f) f(l); else lignes.push(l); });
rl.on("close", () => { fermee = true; for (const f of enAttente.splice(0)) f(""); });
const demander = (q: string, cache = false) => new Promise<string>((ok) => {
  masquer = cache;
  process.stdout.write(q);
  const fin = (r: string) => { masquer = false; if (cache) process.stdout.write("\n"); ok(r.trim()); };
  const l = lignes.shift();
  if (l !== undefined) fin(l); else if (fermee) fin(""); else enAttente.push(fin);
});
const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reference = () => `wk_${randomBytes(16).toString("base64url").slice(0, 22)}`;

const rapport: Record<string, unknown> = { outil: "cinetpay-bac-a-sable", le: new Date().toISOString(), etapes: [] as unknown[] };
const noter = (etape: string, donnees: Record<string, unknown>) => {
  (rapport.etapes as unknown[]).push({ etape, ...donnees });
  console.log(`- ${etape} : ${JSON.stringify(donnees).slice(0, 300)}`);
};

async function principal(): Promise<void> {
  let urlBase = URL_CINETPAY.sandbox;
  let cles: ClesCinetpay;
  let faux: { url: string; arreter?: () => Promise<void> } | undefined;
  if (process.env.WAKATNET_ESSAI_FAUX === "1") {
    const { FauxCinetpay, CLE_TEST, MDP_TEST } = await import("../../../apps/api/tests/aide-cinetpay.ts");
    const f = await new FauxCinetpay().demarrer();
    faux = f as unknown as { url: string };
    urlBase = f.url;
    cles = { cleApi: CLE_TEST, motDePasseApi: MDP_TEST, environnement: "sandbox" };
    rapport.auto_essai = true;
  } else {
    const cleApi = await demander("Clé d'API de TEST (sk_test_…, saisie masquée) : ", true);
    const motDePasseApi = await demander("Mot de passe d'API de TEST (saisie masquée) : ", true);
    if (!cleApi.startsWith("sk_test_")) throw new Error("clé de test attendue (sk_test_…) : rien n'a été envoyé");
    cles = { cleApi, motDePasseApi, environnement: "sandbox" };
  }
  rapport.url = urlBase;
  // Le webhook ne peut pas arriver ici : verify() fait foi, comme en production.
  const p = new CinetpayProvider(cles, { urlBase, urlWebhook: "https://notification.wakatnet.invalid/webhook", urlRetour: "https://retour.wakatnet.invalid/" });

  // Connexion seule, puis un jeton pour les lectures brutes (forme exacte des réponses).
  try { await p.verifierCompte(); noter("connexion", { resultat: "acceptée" }); } catch (e) { noter("connexion", { erreur: decrire(e) }); return; }
  const login = await fetch(`${urlBase}/v1/oauth/login`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ api_key: cles.cleApi, api_password: cles.motDePasseApi }), redirect: "error" });
  const jl = await login.json() as Record<string, unknown>;
  noter("forme de la connexion", { http: login.status, corps: forme(jl) });
  const jeton = typeof jl.access_token === "string" ? jl.access_token : "";
  const lire = async (ref: string) => {
    const r = await fetch(`${urlBase}/v1/payment/${encodeURIComponent(ref)}`, { headers: { authorization: `Bearer ${jeton}`, accept: "application/json" }, redirect: "error" });
    let j: unknown = null; try { j = await r.json(); } catch { /* corps non JSON */ }
    const o = (j ?? {}) as Record<string, unknown>;
    return { http: r.status, corps: forme(j), statut_en_tete: o.status ?? null, statut_sous_details: (o.details as Record<string, unknown> | undefined)?.status ?? null,
             montant_present: "amount" in o, devise_presente: "currency" in o };
  };

  // Référence jamais envoyée : forme exacte du « NOT_FOUND » (ADR 0022, relecture n° 4).
  noter("statut d'une référence inconnue", await lire(reference()));

  const operations: { operateur: "orange_bf" | "moov_bf"; nom: string }[] = [{ operateur: "orange_bf", nom: "Orange" }, { operateur: "moov_bf", nom: "Moov" }];
  for (const o of operations) {
    const numero = await demander(`Numéro de TEST ${o.nom} à 8 chiffres (vide : sauter ${o.nom}) : `);
    if (!numero) { noter(`paiement ${o.nom}`, { saute: true }); continue; }
    const essais = o.operateur === "orange_bf" ? 2 : 1;   // Orange : deux achats de 100 F à la suite (code 606, R6)
    for (let i = 1; i <= essais; i++) {
      const otp = o.operateur === "orange_bf" ? await demander(`Code OTP Orange de test pour l'achat ${i} (vide : sauter) : `) : undefined;
      if (o.operateur === "orange_bf" && !otp) { noter(`paiement ${o.nom} n° ${i}`, { saute: true }); continue; }
      const ref = reference();
      try {
        const r = await p.charge({ reference: ref, montant: 100, devise: "XOF", numero, operateur: o.operateur, ...(otp ? { otp } : {}) } as Parameters<CinetpayProvider["charge"]>[0]);
        noter(`paiement ${o.nom} n° ${i} : charge()`, { statut: r.statut, identifiant_cinetpay_rendu: r.referenceFournisseur !== "" });
      } catch (e) { noter(`paiement ${o.nom} n° ${i} : charge()`, { erreur: decrire(e) }); }
      for (const delai of [0, 20_000, 60_000]) {
        if (delai) { console.log(`  (attente ${delai / 1000} s : confirmez sur le téléphone de test si on vous le demande)`); await attendre(faux ? 10 : delai); }
        noter(`paiement ${o.nom} n° ${i} : statut brut à ${delai / 1000} s`, await lire(ref));
      }
      try { noter(`paiement ${o.nom} n° ${i} : verify()`, { ...(await p.verify(ref)), reference: "<masquée>", referenceFournisseur: "<masquée>" }); }
      catch (e) { noter(`paiement ${o.nom} n° ${i} : verify()`, { erreur: decrire(e) }); }
    }
  }
}

try {
  await principal();
} catch (e) {
  noter("arrêt", { erreur: decrire(e) });
} finally {
  rl.close();
  const fichier = `rapport-cinetpay-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(fichier, JSON.stringify(rapport, null, 2) + "\n", { mode: 0o600 });
  console.log(`\nRapport : ${fichier} (aucune clé, aucun jeton, aucun numéro). À renvoyer pour trancher l'ADR 0022.`);
  process.exit(0);
}
