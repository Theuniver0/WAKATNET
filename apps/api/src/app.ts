// WAKATNET — construction de l'application Fastify (sans écoute réseau : tests par inject).
// Ticket : .scratch/phase-2-multi-proprietaires/issues/02-socle-applicatif.md
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Config } from "./config.ts";
import { enTantQue, type Base } from "./base.ts";
import { routesEnrolement, routesRouteur } from "./enrolement.ts";
import { routesImport } from "./import.ts";
import { estIdentifiant } from "./identifiant.ts";

declare module "fastify" {
  interface FastifyRequest {
    tenantId: bigint;
  }
}


/** Chemin journalisable : le jeton d'enrôlement (ADR 0012 §3) n'apparaît jamais dans un journal. */
export function cheminMasque(url: string): string {
  return url.replace(/^\/enroll\/[^/?#]*/, "/enroll/***");
}

export function construire(config: Config, base: Base,
                           options: { journal?: boolean; flux?: NodeJS.WritableStream } = {}): FastifyInstance {
  const app = Fastify({
    logger: options.journal === false ? false : {
      ...(options.flux ? { stream: options.flux } : {}),
      serializers: {
        req: (req: FastifyRequest) => ({ method: req.method, url: cheminMasque(req.url) }),
      },
    },
    // Les identifiants sont des bigint : jamais de nombre JSON au-delà de 2^53.
    bodyLimit: 64 * 1024,
  });
  app.decorateRequest("tenantId", 0n);

  // Routes du propriétaire : identité de développement seulement (ADR 0012 §7).
  app.register(async (proprietaire) => {
    proprietaire.addHook("onRequest", async (req, rep) => {
      if (!config.authDev) return rep.code(401).send({ erreur: "authentification indisponible avant la phase 4" });
      const valeur = req.headers["x-wakatnet-tenant"];
      if (!estIdentifiant(valeur)) {
        return rep.code(401).send({ erreur: "identité absente" });
      }
      const tenant = await base.tenant.findUnique({ where: { id: BigInt(valeur) }, select: { suspendu: true } });
      if (tenant === null) return rep.code(401).send({ erreur: "identité absente" });
      if (tenant.suspendu) return rep.code(403).send({ erreur: "propriétaire suspendu" });
      req.tenantId = BigInt(valeur);
    });

    proprietaire.get("/v1/sites", async (req) => {
      const sites = await enTantQue(base, req.tenantId, (tx) =>
        tx.site.findMany({ select: { id: true, nom: true }, orderBy: { id: "asc" } }));
      return sites.map((s) => ({ id: s.id.toString(), nom: s.nom }));
    });

    proprietaire.get("/v1/routers", async (req) => {
      const routeurs = await enTantQue(base, req.tenantId, (tx) =>
        tx.router.findMany({
          select: { id: true, site_id: true, overlay_ip: true, shortname: true, actif: true, enrole_le: true },
          orderBy: { id: "asc" },
        }));
      return routeurs.map((r) => ({
        id: r.id.toString(), site_id: r.site_id.toString(), overlay_ip: r.overlay_ip,
        nom: r.shortname, actif: r.actif, enrole_le: r.enrole_le,
      }));
    });

    routesEnrolement(proprietaire, config, base);
    routesImport(proprietaire, base);
  });

  // Routes du routeur : le jeton d'enrôlement tient lieu d'identité (ADR 0012 §7).
  app.register(async (routeur) => routesRouteur(routeur, config, base));

  return app;
}
