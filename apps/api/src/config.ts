// WAKATNET — configuration de l'API, lue dans l'environnement (EnvironmentFile en production).
// Ticket : .scratch/phase-2-multi-proprietaires/issues/02-socle-applicatif.md
// ADR 0014 §1 : l'identité de développement de l'ADR 0012 §7 est retirée (sessions).

export type Noeud = {
  /** Lettre du nœud (A, B). */
  nom: string;
  /** Adresse du nœud dans l'overlay (10.213.0.1, 10.213.0.2). */
  overlay: string;
  /** Clé publique WireGuard du nœud (base64). */
  cle: string;
  /** IP publique fixe du nœud (SPEC §6.1 : pas de nom DNS sur le chemin critique). */
  endpoint: string;
  port: number;
};

export type Config = {
  /** URL de connexion du rôle wk_api (mot de passe compris : jamais journalisée). */
  urlBase: string;
  /** Origine publique de l'API, telle que le routeur la joint (https://api.DOMAINE). */
  urlPublique: string;
  /** Origine publique du portail (IP dédiée, ADR 0013 §10). */
  urlPortail: string;
  /** Nœuds de la plateforme (WAKATNET_NOEUDS, JSON) ; vide : l'enrôlement répond 503. */
  noeuds: Noeud[];
  /** Clés de chiffrement des comptes marchands et du HMAC des numéros (ADR 0013 §8, §9) ;
   *  absentes : les routes de paiement répondent 503. Jamais en base. */
  cles: { marchands: Buffer; hmac: Buffer } | null;
  /** Fichiers construits du tableau de bord (WAKATNET_TABLEAU_DIR) ; absent : apps/dashboard/dist. */
  dossierTableau?: string | null;
};

import { lireCle } from "./chiffrement.ts";

export class ConfigInvalide extends Error {}

export function lireConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const urlBase = env.WAKATNET_API_DATABASE_URL;
  if (!urlBase) throw new ConfigInvalide("WAKATNET_API_DATABASE_URL manquant");
  const urlPublique = env.WAKATNET_API_URL_PUBLIQUE ?? "https://api.wakatnet.invalid";
  if (!/^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/.test(urlPublique)) {
    throw new ConfigInvalide("WAKATNET_API_URL_PUBLIQUE : https://hôte[:port], sans chemin");
  }
  let cles: Config["cles"] = null;
  if (env.WAKATNET_CLE_MARCHANDS || env.WAKATNET_CLE_HMAC) {
    try {
      cles = { marchands: lireCle(env.WAKATNET_CLE_MARCHANDS, "WAKATNET_CLE_MARCHANDS", 32),
               hmac: lireCle(env.WAKATNET_CLE_HMAC, "WAKATNET_CLE_HMAC") };
    } catch (e) {
      throw new ConfigInvalide((e as Error).message);
    }
  }
  const urlPortail = env.WAKATNET_PORTAIL_URL_PUBLIQUE ?? "https://portail.wakatnet.invalid";
  if (!/^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/.test(urlPortail)) {
    throw new ConfigInvalide("WAKATNET_PORTAIL_URL_PUBLIQUE : https://hôte[:port], sans chemin");
  }
  const dossierTableau = env.WAKATNET_TABLEAU_DIR || undefined;
  return { urlBase, urlPublique, urlPortail, noeuds: lireNoeuds(env.WAKATNET_NOEUDS), cles, ...(dossierTableau ? { dossierTableau } : {}) };
}

const IPV4 = /^(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){3}$/;

/** WAKATNET_NOEUDS : [{"nom":"A","overlay":"10.213.0.1","cle":"…","endpoint":"IP publique","port":51820}, …] */
function lireNoeuds(texte: string | undefined): Noeud[] {
  if (!texte) return [];
  let brut: unknown;
  try {
    brut = JSON.parse(texte);
  } catch {
    throw new ConfigInvalide("WAKATNET_NOEUDS : JSON illisible");
  }
  if (!Array.isArray(brut) || brut.length === 0 || brut.length > 2) throw new ConfigInvalide("WAKATNET_NOEUDS : un ou deux nœuds");
  return brut.map((n, i) => {
    const ok = typeof n === "object" && n !== null
      && typeof n.nom === "string" && /^[A-Z]$/.test(n.nom)
      && typeof n.overlay === "string" && /^10\.213\.0\.[1-9][0-9]{0,2}$/.test(n.overlay) && IPV4.test(n.overlay)
      && typeof n.cle === "string" && /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(n.cle)
      && typeof n.endpoint === "string" && IPV4.test(n.endpoint)
      && Number.isInteger(n.port) && n.port > 0 && n.port < 65536;
    if (!ok) throw new ConfigInvalide(`WAKATNET_NOEUDS : nœud ${i} invalide`);
    return { nom: n.nom, overlay: n.overlay, cle: n.cle, endpoint: n.endpoint, port: n.port };
  });
}
