// WAKATNET — routes du compte marchand (propriétaire) et des webhooks (publique).
// Tickets : .scratch/phase-3-portail-paiement/issues/03-paiements-mock.md ; ADR 0013 §1, §8.
import type { FastifyInstance } from "fastify";
import type { Base } from "./base.ts";
import { enTantQue } from "./base.ts";
import { CompteInvalide, FournisseurIndisponible } from "../../../packages/payments/src/index.ts";
import { creerFournisseur, FournisseurInconnu, validerCles } from "./fournisseurs.ts";
import type { ServicePaiement } from "./paiement.ts";

const ID_WEBHOOK = /^[A-Za-z0-9_-]{24}$/;
const ID_FOURNISSEUR = /^[a-z][a-z0-9_]{1,31}$/;

/** Propriétaire : enregistre (ou remplace) ses clés ; elles ne sont JAMAIS rendues ensuite. */
export function routesCompteMarchand(app: FastifyInstance, config: { urlPublique: string; urlPortail?: string; noeuds?: { endpoint: string }[] }, base: Base,
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
    const ouvert = () => rep.code(409).send({ erreur: "changement de compte marchand impossible tant que des paiements sont ouverts (24 h au plus)" });
    // Si l'adaptateur sait vérifier le compte chez le fournisseur (verifierCompte), il le fait avant l'enregistrement.
    // Audit du 13/11/2026 (migration 0037) : AVANT tout appel au fournisseur, le refus pour paiements ouverts (409),
    // puis la limite de 5 vérifications par heure et par propriétaire (sinon de faux jetons feraient appeler le
    // fournisseur en boucle). compte_marchand_enregistrer refait le contrôle des paiements sous verrou.
    try {
      const f = creerFournisseur(fournisseur, valides, null);
      const verifier = typeof f.verifierCompte === "function";
      const avant = await enTantQue(base, req.tenantId, async (tx) => {
        const [r] = await tx.$queryRaw<{ s: string }[]>`SELECT app.compte_marchand_avant_verification(${verifier}) AS s`;
        return r.s;
      });
      if (avant === "paiements_ouverts") return ouvert();
      if (avant === "trop_de_verifications") {
        return rep.code(429).send({ erreur: "trop de vérifications de compte marchand : réessayez dans une heure" });
      }
      if (avant !== "ok") throw new Error(`compte marchand : contrôle inattendu ${avant}`);
      await f.verifierCompte?.();
    } catch (e) {
      if (e instanceof CompteInvalide) return rep.code(422).send({ erreur: e.message });
      if (e instanceof FournisseurIndisponible) return rep.code(503).send({ erreur: "fournisseur injoignable : réessayez dans quelques minutes" });
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
      if (/paiements encore ouverts/.test(String(e))) return ouvert();
      throw e;
    }
    // MoneyFusion (ADR 0024) : l'application du marchand n'accepte que les IP déclarées et un site public. On rend ce qu'il
    // doit y saisir : les IP publiques des nœuds (d'où partent les appels) et l'adresse du portail (page de retour).
    return { fournisseur, url_webhook: `${config.urlPublique}/webhooks/${fournisseur}/${webhook}`,
             ips_serveurs: (config.noeuds ?? []).map((n) => n.endpoint), url_portail: config.urlPortail ?? null };
  });
}

/** Public : un webhook ne fait que déclencher verify() ; sa signature est vérifiée s'il en a une (MoneyFusion n'en a pas :
 *  ADR 0024), son corps conservé. */
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
      // Requête telle que reçue (méthode, hôte, chemin) : à la disposition d'un adaptateur dont la signature les couvre.
      const r = await service.webhook(req.params.fournisseur, req.params.webhook, req.headers, corps,
                                      { methode: req.method, autorite: String(req.headers.host ?? ""), chemin: req.url.split("?")[0] });
      return rep.code(r.code).send(r.corps);
    });
  });
}
