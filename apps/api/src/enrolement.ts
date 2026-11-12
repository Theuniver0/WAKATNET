// WAKATNET — routes de l'enrôlement d'un routeur (SPEC §6.2, ADR 0012 §3 et §4).
// Ticket : .scratch/phase-2-multi-proprietaires/issues/03-api-enrolement.md
//
// Le jeton n'est jamais stocké ni journalisé en clair : seule son empreinte SHA-256 va en base,
// et le chemin /enroll/* est masqué dans les journaux (app.ts). Le secret RADIUS n'apparaît que
// dans la réponse de l'étape 2.
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Base } from "./base.ts";
import { enTantQue } from "./base.ts";
import type { Config } from "./config.ts";
import { commande, desinstallation, etape1, etape2, type Hotspot, type Inventaire } from "./routeros.ts";

export const DUREE_JETON_MIN = 30;
const JETON = /^[A-Za-z0-9_-]{43}$/;
const CLE = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const IDENTIFIANT = /^[1-9][0-9]{0,18}$/;
// Même réponse pour inconnu, expiré ou consommé : aucun indice sur l'existence d'un jeton.
const INTROUVABLE = { erreur: "commande d'enrôlement inconnue, expirée ou déjà utilisée" };

export function empreinte(jeton: string): Buffer {
  return createHash("sha256").update(jeton, "utf8").digest();
}

export class InventaireInvalide extends Error {}

function booleen(v: unknown, champ: string): boolean {
  // :serialize to=json de RouterOS : vrais booléens JSON attendus [LABO] ; « yes »/« no » tolérés.
  if (v === true || v === "true" || v === "yes") return true;
  if (v === false || v === "false" || v === "no") return false;
  throw new InventaireInvalide(`${champ} : booléen attendu`);
}

function entier(v: unknown, champ: string, min: number, max: number): number {
  const n = typeof v === "string" && /^[0-9]{1,5}$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new InventaireInvalide(`${champ} : entier de ${min} à ${max}`);
  return n;
}

function texte(v: unknown, champ: string, max: number): string {
  if (typeof v !== "string" || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) {
    throw new InventaireInvalide(`${champ} : texte de ${max} caractères au plus, sans caractère de contrôle`);
  }
  return v;
}

/** Version « 7.15.3 (stable) » → [7, 15] ; null si illisible. */
export function versionRouterOS(v: string): [number, number] | null {
  const m = /^([0-9]+)\.([0-9]+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Corps de l'étape 1 → clé et inventaire validés. Toute erreur → 422, jeton intact. */
export function lireInscription(corps: unknown): { cle: string; inventaire: Inventaire } {
  if (typeof corps !== "object" || corps === null) throw new InventaireInvalide("corps JSON attendu");
  const c = corps as Record<string, unknown>;
  if (typeof c.cle !== "string" || !CLE.test(c.cle)) throw new InventaireInvalide("cle : clé publique WireGuard invalide");
  const version = texte(c.version, "version", 64);
  const v = versionRouterOS(version);
  if (v === null || v[0] < 7 || (v[0] === 7 && v[1] < 15)) throw new InventaireInvalide("version : RouterOS 7.15 ou plus récent exigé");
  if (!Array.isArray(c.hotspots) || c.hotspots.length === 0 || c.hotspots.length > 32) {
    throw new InventaireInvalide("hotspots : de 1 à 32 serveurs");
  }
  const hotspots: Hotspot[] = c.hotspots.map((h: unknown, i: number) => {
    if (typeof h !== "object" || h === null) throw new InventaireInvalide(`hotspots[${i}] : objet attendu`);
    const x = h as Record<string, unknown>;
    const hs: Hotspot = {
      serveur: texte(x.serveur, `hotspots[${i}].serveur`, 64),
      profil: texte(x.profil, `hotspots[${i}].profil`, 64),
      use_radius: booleen(x.use_radius, `hotspots[${i}].use_radius`),
      html_directory: texte(x.html_directory ?? "", `hotspots[${i}].html_directory`, 128),
      radius_accounting: booleen(x.radius_accounting ?? true, `hotspots[${i}].radius_accounting`),
      radius_interim_update: texte(x.radius_interim_update ?? "received", `hotspots[${i}].radius_interim_update`, 16),
    };
    if (hs.use_radius) throw new InventaireInvalide(`le profil ${hs.profil} utilise déjà RADIUS (ADR 0012 §9)`);
    return hs;
  });
  return {
    cle: c.cle,
    inventaire: {
      identity: texte(c.identity, "identity", 255),
      modele: texte(c.modele, "modele", 64),
      version,
      listen_port: entier(c.listen_port, "listen_port", 1, 65535),
      coa_port: entier(c.coa_port, "coa_port", 1, 65535),
      coa_accept: booleen(c.coa_accept, "coa_accept"),
      hotspots,
    },
  };
}

type Inscrit = { statut: string; router_id: bigint | null; overlay_ip: string | null; secret: string | null };

export function routesEnrolement(app: FastifyInstance, config: Config, base: Base): void {
  // Propriétaire : nouvelle commande d'enrôlement pour un de SES sites.
  app.post<{ Params: { site: string } }>("/v1/sites/:site/enrollments", async (req, rep) => {
    if (!IDENTIFIANT.test(req.params.site)) return rep.code(404).send({ erreur: "site inconnu" });
    const jeton = randomBytes(32).toString("base64url");
    const cree = await enTantQue(base, req.tenantId, async (tx) => {
      // RLS : un site d'un autre propriétaire est invisible ici, donc 404.
      const site = await tx.site.findUnique({ where: { id: BigInt(req.params.site) }, select: { id: true } });
      if (site === null) return null;
      const [ligne] = await tx.$queryRaw<{ id: bigint; expire_le: Date }[]>`
        INSERT INTO app.enrollment_token (tenant_id, site_id, empreinte, expire_le)
        VALUES (${req.tenantId}, ${site.id}, ${empreinte(jeton)}, now() + make_interval(mins => ${DUREE_JETON_MIN}))
        RETURNING id, expire_le`;
      await tx.audit_log.create({
        data: { tenant_id: req.tenantId, acteur: `tenant:${req.tenantId}`, action: "commande_enrolement_creee",
                objet: `site:${site.id}`, details: { jeton_id: ligne.id.toString() } },
      });
      return ligne;
    });
    if (cree === null) return rep.code(404).send({ erreur: "site inconnu" });
    return rep.code(201).send({ commande: commande(config.urlPublique, jeton), expire_le: cree.expire_le.toISOString() });
  });

  // Propriétaire : révocation de SON routeur (ticket 06). Effet immédiat sur le tunnel (wg-agent
  // retire le pair au NOTIFY) et sur la base (client_lookup ne le rend plus) ; FreeRADIUS l'oublie
  // au plus tard à l'expiration du client dynamique (lifetime), sans paquet possible entre-temps
  // puisque le tunnel est fermé. Ses sessions ouvertes sont fermées comme sessions fantômes
  // (ADR 0006 §8). Définitive : un routeur révoqué revient par désinstallation puis nouvel
  // enrôlement (nouvelle clé, nouvelle adresse).
  app.post<{ Params: { id: string } }>("/v1/routers/:id/revoke", async (req, rep) => {
    if (!IDENTIFIANT.test(req.params.id)) return rep.code(404).send({ erreur: "routeur inconnu" });
    const fait = await enTantQue(base, req.tenantId, async (tx) => {
      const r = await tx.router.findUnique({ where: { id: BigInt(req.params.id) }, select: { id: true, actif: true } });
      if (r === null) return null;
      if (r.actif) {
        await tx.router.update({ where: { id: r.id }, data: { actif: false }, select: { id: true } });
        await tx.audit_log.create({
          data: { tenant_id: req.tenantId, acteur: `tenant:${req.tenantId}`, action: "routeur_revoque", objet: `router:${r.id}` },
        });
      }
      return r;
    });
    if (fait === null) return rep.code(404).send({ erreur: "routeur inconnu" });
    return { id: fait.id.toString(), actif: false };
  });

  // Propriétaire : script de désinstallation propre à SON routeur, valeurs d'origine relevées à
  // l'enrôlement (R6, ADR 0012 §4). Ticket 04.
  app.get<{ Params: { id: string } }>("/v1/routers/:id/uninstall.rsc", async (req, rep) => {
    if (!IDENTIFIANT.test(req.params.id)) return rep.code(404).send({ erreur: "routeur inconnu" });
    const r = await enTantQue(base, req.tenantId, (tx) =>
      tx.router.findUnique({ where: { id: BigInt(req.params.id) }, select: { inventaire: true, enrole_le: true } }));
    if (r === null) return rep.code(404).send({ erreur: "routeur inconnu" });
    if (r.enrole_le === null) return rep.code(409).send({ erreur: "routeur déclaré à la main : aucun inventaire, désinstallation à faire à la main" });
    // L'inventaire a été validé par lireInscription à l'enrôlement ; il est relu tel quel.
    return rep.type("text/plain; charset=utf-8").send(desinstallation(r.inventaire as unknown as Inventaire));
  });
}

export function routesRouteur(app: FastifyInstance, config: Config, base: Base): void {
  app.get<{ Params: { jeton: string } }>("/enroll/:jeton", async (req, rep) => {
    if (!JETON.test(req.params.jeton)) return rep.code(404).send(INTROUVABLE);
    const [ligne] = await base.$queryRaw<{ expire_le: Date | null }[]>`
      SELECT app.enroll_token_valide(${empreinte(req.params.jeton)}) AS expire_le`;
    if (ligne.expire_le === null) return rep.code(404).send(INTROUVABLE);
    return rep.type("text/plain; charset=utf-8").send(etape1(config.urlPublique, req.params.jeton, ligne.expire_le));
  });

  app.post<{ Params: { jeton: string } }>("/enroll/:jeton", async (req, rep) => {
    if (!JETON.test(req.params.jeton)) return rep.code(404).send(INTROUVABLE);
    if (config.noeuds.length === 0) return rep.code(503).send({ erreur: "aucun nœud configuré (WAKATNET_NOEUDS)" });
    let inscription: ReturnType<typeof lireInscription>;
    try {
      inscription = lireInscription(req.body);
    } catch (e) {
      if (e instanceof InventaireInvalide) return rep.code(422).send({ erreur: e.message });
      throw e;
    }
    let ligne: Inscrit;
    try {
      [ligne] = await base.$queryRaw<Inscrit[]>`
        SELECT statut, router_id, overlay_ip, secret
          FROM app.enroll_register(${empreinte(req.params.jeton)}, ${inscription.cle},
                                   ${inscription.inventaire.coa_port}::integer, ${JSON.stringify(inscription.inventaire)}::jsonb)`;
    } catch (e) {
      // Course entre deux jetons différents portant la même clé : la contrainte UNIQUE tranche.
      if (/wg_public_key/.test(String(e))) return rep.code(409).send({ erreur: "cette clé WireGuard est déjà enrôlée" });
      throw e;
    }
    if (ligne.statut === "introuvable") return rep.code(404).send(INTROUVABLE);
    if (ligne.statut === "cle_utilisee") return rep.code(409).send({ erreur: "cette clé WireGuard est déjà enrôlée" });
    if (ligne.statut !== "enrole") return rep.code(503).send({ erreur: "plus aucune adresse libre dans l'overlay" });
    req.log.info({ routeur: ligne.router_id!.toString(), overlay_ip: ligne.overlay_ip }, "routeur enrôlé");
    return rep.type("text/plain; charset=utf-8").send(etape2({
      overlayIp: ligne.overlay_ip!, secret: ligne.secret!, noeuds: config.noeuds, inventaire: inscription.inventaire,
    }));
  });
}
