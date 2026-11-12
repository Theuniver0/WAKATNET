// WAKATNET — point d'entrée de l'API : node src/serveur.ts (Node 22 officiel, types retirés au chargement).
import { construire } from "./app.ts";
import { ouvrirBase } from "./base.ts";
import { lireConfig } from "./config.ts";

const config = lireConfig();
const base = ouvrirBase(config.urlBase);
const app = construire(config, base);
const port = Number(process.env.WAKATNET_API_PORT ?? "3000");
await app.listen({ host: process.env.WAKATNET_API_HOTE ?? "127.0.0.1", port });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => { await app.close(); await base.$disconnect(); });
}
