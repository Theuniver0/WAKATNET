// WAKATNET — tableau de bord servi par l'API sous /tableau/ (ADR 0014 §5) : même origine, donc
// SameSite=Strict et aucune configuration CORS. CSP stricte : aucun script ni style en ligne.
// Ticket : .scratch/phase-4-exploitation/issues/08-tableau-de-bord.md
//
// Les fichiers construits (apps/dashboard/dist, `npm run build -w apps/dashboard`) sont lus UNE
// fois au démarrage ; une requête ne sert que ce qui est en mémoire : aucun chemin de requête ne
// touche le disque (pas de traversée de répertoire possible).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";

export const CSP_TABLEAU = ["default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "font-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join("; ");

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", woff2: "font/woff2", json: "application/json",
};

export const DOSSIER_TABLEAU_DEFAUT = fileURLToPath(new URL("../../dashboard/dist", import.meta.url));

type Fichier = { corps: Buffer; type: string };

function charger(dossier: string): Map<string, Fichier> {
  const fichiers = new Map<string, Fichier>();
  const parcourir = (d: string) => {
    for (const nom of readdirSync(d)) {
      const p = join(d, nom);
      if (statSync(p).isDirectory()) { parcourir(p); continue; }
      const type = TYPES[nom.split(".").pop() ?? ""];
      if (type) fichiers.set(relative(dossier, p).split(sep).join("/"), { corps: readFileSync(p), type });
    }
  };
  parcourir(dossier);
  return fichiers;
}

function entetes(rep: FastifyReply, immuable: boolean): FastifyReply {
  return rep.header("content-security-policy", CSP_TABLEAU).header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer").header("x-frame-options", "DENY")
    .header("cache-control", immuable ? "public, max-age=31536000, immutable" : "no-store");
}

/** `dossier` null : tableau non livré sur ce nœud (503). */
export function routesTableau(app: FastifyInstance, dossier: string | null): void {
  const fichiers = dossier && existsSync(join(dossier, "index.html")) ? charger(dossier) : null;
  app.get("/tableau", async (_req, rep) => rep.redirect("/tableau/", 308));
  app.get("/tableau/*", async (req, rep) => {
    if (!fichiers) return entetes(rep, false).code(503).type("text/plain; charset=utf-8").send("tableau de bord non construit");
    const chemin = (req.params as { "*": string })["*"];
    const f = fichiers.get(chemin);
    if (f) return entetes(rep, chemin.startsWith("assets/")).type(f.type).send(f.corps);
    if (chemin.startsWith("assets/") || /\.[a-z0-9]+$/i.test(chemin)) return entetes(rep, false).code(404).send({ erreur: "introuvable" });
    const index = fichiers.get("index.html")!;                       // routeur sur le # : toute autre page → index
    return entetes(rep, false).type(index.type).send(index.corps);
  });
}
