// WAKATNET — point d'entrée de l'API : node src/serveur.ts (Node 22 officiel, types retirés au chargement).
import { construire } from "./app.ts";
import { ouvrirBase } from "./base.ts";
import { lireConfig } from "./config.ts";
import { ExpediteurBrevo } from "./courriel.ts";

const config = lireConfig();
const base = ouvrirBase(config.urlBase);
// ADR 0019 : expéditeur réel seulement si WAKATNET_COURRIEL est réglé ; sinon, validation par le super-admin.
const expediteur = config.courriel ? new ExpediteurBrevo(config.courriel) : undefined;
const app = construire(config, base, expediteur ? { expediteur } : {});
const port = Number(process.env.WAKATNET_API_PORT ?? "3000");
await app.listen({ host: process.env.WAKATNET_API_HOTE ?? "127.0.0.1", port });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => { await app.close(); await base.$disconnect(); });
}
