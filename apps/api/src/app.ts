// WAKATNET — construction de l'application Fastify (sans écoute réseau : tests par inject).
// Ticket : .scratch/phase-2-multi-proprietaires/issues/02-socle-applicatif.md
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Config } from "./config.ts";
import { enTantQue, type Base } from "./base.ts";
import { routesEnrolement, routesRouteur } from "./enrolement.ts";
import { routesImport } from "./import.ts";
import { ServicePaiement } from "./paiement.ts";
import { routesPortail } from "./portail.ts";
import { routesCompteMarchand, routesWebhook } from "./routes-paiement.ts";
import { routesAdmin } from "./admin.ts";
import { garde, routesAuth } from "./auth.ts";
import { routesExploitation } from "./exploitation.ts";
import { DOSSIER_TABLEAU_DEFAUT, routesTableau } from "./tableau.ts";
import { routesEtat } from "./etat.ts";

declare module "fastify" {
  interface FastifyRequest {
    tenantId: bigint;
  }
  interface FastifyInstance {
    paiement: ServicePaiement | null;
  }
}


/** Chemin journalisable : le jeton d'enrôlement (ADR 0012 §3) n'apparaît jamais dans un journal, ni la
 *  chaîne de requête (revue de sécurité M5 : page demandée par le client du hotspot, recherches). */
export function cheminMasque(url: string): string {
  return url.split("?")[0].replace(/^\/enroll\/[^/?#]*/, "/enroll/***").replace(/^(\/webhooks\/[^/?#]+)\/[^/?#]*/, "$1/***");
}

export function construire(config: Config, base: Base,
                           options: { journal?: boolean; flux?: NodeJS.WritableStream; service?: ServicePaiement } = {}): FastifyInstance {
  const service = options.service ?? (config.cles ? new ServicePaiement(base, config.cles) : null);
  const app = Fastify({
    logger: options.journal === false ? false : {
      ...(options.flux ? { stream: options.flux } : {}),
      serializers: {
        req: (req: FastifyRequest) => ({ method: req.method, url: cheminMasque(req.url) }),
      },
    },
    // Les identifiants sont des bigint : jamais de nombre JSON au-delà de 2^53.
    bodyLimit: 64 * 1024,
    // Derrière nginx (ADR 0016 §2) : req.ip = X-Forwarded-For posé par le seul proxy local de confiance.
    ...(config.trustProxy ? { trustProxy: config.trustProxy } : {}),
  });
  app.decorateRequest("tenantId", 0n);
  app.decorateRequest("utilisateur", null);

  // Erreurs : journalisées en entier, rendues sans détail (texte de la base, adresse, fournisseur).
  // Sur le portail, une page HTML ; ailleurs, un JSON générique (revue de fin de phase 3).
  app.setErrorHandler((err, req, rep) => {
    const sc = (err as { statusCode?: unknown }).statusCode;
    const code = typeof sc === "number" && sc >= 400 && sc < 500 ? sc : 500;
    if (code === 500) req.log.error({ err }, "erreur interne");
    if (req.url.startsWith("/p/")) {
      return rep.code(code).type("text/html; charset=utf-8").header("cache-control", "no-store")
        .send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Erreur</title></head><body style="font-family:system-ui,sans-serif;padding:1rem"><h1>Service momentanément indisponible</h1><p>Réessayez dans quelques instants.</p></body></html>`);
    }
    return rep.code(code).send({ erreur: code === 500 ? "erreur interne" : "requête invalide" });
  });

  // Tableau de bord (ADR 0014 §5) : fichiers statiques, même origine, CSP stricte.
  routesTableau(app, config.dossierTableau === undefined ? DOSSIER_TABLEAU_DEFAUT : config.dossierTableau);

  // Page d'état publique (ADR 0015 §6) : composants génériques, aucune donnée de propriétaire.
  routesEtat(app, config.etatsNoeuds ?? []);

  // Comptes : inscription, connexion, session, TOTP (ADR 0014 §1 à §3).
  routesAuth(app, base, config.cles?.marchands ?? null, config.cles?.hmac ?? null);

  // Routes du propriétaire (et, route par route, du gérant ou du vendeur) : session obligatoire.
  app.register(async (proprietaire) => {
    proprietaire.addHook("onRequest", garde(base, "proprietaire"));

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
    routesCompteMarchand(proprietaire, config, base, service);
    routesExploitation(proprietaire, base, config.cles?.hmac ?? null);
  });

  // Super-admin : rôle ET double authentification validée dans la session (ADR 0014 §3, §4).
  routesAdmin(app, base);

  // Routes du routeur : le jeton d'enrôlement tient lieu d'identité (ADR 0012 §7).
  app.register(async (routeur) => routesRouteur(routeur, config, base));

  // Webhooks des fournisseurs : publics, signés, corps brut (ADR 0013 §1).
  routesWebhook(app, service);
  if (service && service.livreur === null) {
    // MockProvider : ses webhooks reviennent sur la route publique, comme ceux d'un vrai fournisseur.
    service.livreur = (fournisseur, webhookId) => async (enTetes, corps) => {
      await app.inject({ method: "POST", url: `/webhooks/${fournisseur}/${webhookId}`, headers: enTetes, payload: corps });
    };
  }
  app.decorate("paiement", service);

  // Portail captif : public, servi sur l'IP dédiée du portail en production (ADR 0013 §10).
  routesPortail(app, base, service, config.cles?.hmac ?? null);

  return app;
}
