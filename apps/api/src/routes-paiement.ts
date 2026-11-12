// WAKATNET — routes du compte marchand (propriétaire) et des webhooks (publique).
// Tickets : .scratch/phase-3-portail-paiement/issues/03-paiements-mock.md ; ADR 0013 §1, §8.
import type { FastifyInstance } from "fastify";
import type { Base } from "./base.ts";
import { enTantQue } from "./base.ts";
import { FournisseurInconnu, validerCles } from "./fournisseurs.ts";
import type { ServicePaiement } from "./paiement.ts";

const ID_WEBHOOK = /^[A-Za-z0-9_-]{24}$/;
const ID_FOURNISSEUR = /^[a-z][a-z0-9_]{1,31}$/;

/** Propriétaire : enregistre (ou remplace) ses clés ; elles ne sont JAMAIS rendues ensuite. */
export function routesCompteMarchand(app: FastifyInstance, config: { urlPublique: string }, base: Base,
                                     service: ServicePaiement | null): void {
  app.put<{ Body: { fournisseur?: unknown; cles?: unknown } }>("/v1/compte-marchand", async (req, rep) => {
    if (service === null) return rep.code(503).send({ erreur: "paiement non configuré (clés de chiffrement absentes)" });
    const { fournisseur, cles } = req.body ?? {};
    if (typeof fournisseur !== "string") return rep.code(422).send({ erreur: "fournisseur attendu" });
    let valides;
    try {
      valides = validerCles(fournisseur, cles);
    } catch (e) {
      if (e instanceof FournisseurInconnu) return rep.code(422).send({ erreur: e.message });
      throw e;
    }
    const chiffre = service.chiffrerCles(req.tenantId, valides);
    let webhook: string;
    try {
      webhook = await enTantQue(base, req.tenantId, async (tx) => {
        const [r] = await tx.$queryRaw<{ w: string }[]>`SELECT app.compte_marchand_enregistrer(${fournisseur}, ${chiffre}) AS w`;
        return r.w;
      });
    } catch (e) {
      if (/paiements encore ouverts/.test(String(e))) {
        return rep.code(409).send({ erreur: "changement de fournisseur impossible tant que des paiements sont ouverts (24 h au plus)" });
      }
      throw e;
    }
    return { fournisseur, url_webhook: `${config.urlPublique}/webhooks/${fournisseur}/${webhook}` };
  });
}

/** Public : un webhook ne fait que déclencher verify() ; sa signature est vérifiée, son corps conservé. */
export function routesWebhook(app: FastifyInstance, service: ServicePaiement | null): void {
  app.register(async (brut) => {
    // Corps BRUT (Buffer) : la signature porte sur les octets reçus (§10.1).
    brut.removeAllContentTypeParsers();
    brut.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 64 * 1024 }, (_req, corps, fait) => fait(null, corps));
    brut.post<{ Params: { fournisseur: string; webhook: string } }>("/webhooks/:fournisseur/:webhook", async (req, rep) => {
      if (service === null) return rep.code(503).send({ erreur: "paiement non configuré" });
      if (!ID_FOURNISSEUR.test(req.params.fournisseur) || !ID_WEBHOOK.test(req.params.webhook)) {
        return rep.code(404).send({ erreur: "inconnu" });
      }
      const corps = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const r = await service.webhook(req.params.fournisseur, req.params.webhook, req.headers, corps);
      return rep.code(r.code).send(r.corps);
    });
  });
}
