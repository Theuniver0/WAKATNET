// WAKATNET — page d'état publique des propriétaires (ADR 0015 §6 ; SPEC §10.3).
// Ticket : .scratch/phase-5-haute-disponibilite/issues/05-supervision.md
// Lit les fichiers d'état écrits par le collecteur (sante.ts) : composants génériques et heure de
// vérification, AUCUNE donnée de propriétaire. Un état de plus de 3 min est « inconnu », jamais « en service ».
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";

const PERIME_MS = 3 * 60_000;
const LIBELLES: Record<string, string> = { authentification: "Connexion des clients Wi-Fi", paiements: "Paiements", replication: "Nœud de secours" };

type Etat = { noeud: string; verifie_le: string; composants: Record<string, boolean> };
type Ligne = { noeud: string; verifie_le: string | null; composants: Record<string, "en_service" | "perturbe" | "inconnu"> };

export async function lireEtats(fichiers: string[], maintenant = new Date()): Promise<Ligne[]> {
  const lignes: Ligne[] = [];
  for (const f of fichiers) {
    let e: Etat | null = null;
    try { e = JSON.parse(await readFile(f, "utf8")) as Etat; } catch { /* absent ou illisible : inconnu */ }
    const frais = e !== null && maintenant.getTime() - Date.parse(e.verifie_le) <= PERIME_MS;
    const composants = Object.fromEntries(Object.keys(LIBELLES).map((k) =>
      [k, !frais || e!.composants[k] === undefined ? "inconnu" : e!.composants[k] ? "en_service" : "perturbe"])) as Ligne["composants"];
    lignes.push({ noeud: e?.noeud ?? "?", verifie_le: e?.verifie_le ?? null, composants });
  }
  return lignes;
}

const echapper = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const MOTS = { en_service: "En service", perturbe: "Perturbé", inconnu: "Inconnu" };

export function routesEtat(app: FastifyInstance, fichiers: string[]): void {
  app.get<{ Querystring: { format?: string } }>("/etat", async (req, rep) => {
    const lignes = await lireEtats(fichiers);
    rep.header("cache-control", "no-store").header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    if (req.query.format === "json" || (req.headers.accept ?? "").includes("application/json")) return rep.send({ noeuds: lignes });
    const corps = lignes.map((l) => `<section><h2>Nœud ${echapper(l.noeud)}</h2><ul>${Object.entries(l.composants)
      .map(([k, v]) => `<li>${echapper(LIBELLES[k])} : <strong>${MOTS[v]}</strong></li>`).join("")}</ul>`
      + `<p>Vérifié le ${l.verifie_le ? echapper(l.verifie_le.replace("T", " ").slice(0, 19)) + " (heure du Burkina)" : "—"}</p></section>`).join("");
    return rep.type("text/html; charset=utf-8").send(`<!doctype html><html lang="fr"><head><meta charset="utf-8">`
      + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>État du service WAKATNET</title></head>`
      + `<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:auto;padding:1rem"><h1>État du service</h1>`
      + (corps || "<p>Aucun nœud déclaré.</p>") + `</body></html>`);
  });
}
