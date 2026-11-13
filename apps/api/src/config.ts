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
  /** IPv4 publiques dédiées du portail (WAKATNET_PORTAIL_IPS, séparées par des virgules) : walled garden HTTPS de
   *  chaque routeur (SPEC §6.2, §7.1). Exigées en production : sans elles, un client non connecté n'atteint pas le
   *  portail et ne peut rien acheter. */
  portailIps?: string[];
  /** Nœuds de la plateforme (WAKATNET_NOEUDS, JSON) ; vide : l'enrôlement répond 503. */
  noeuds: Noeud[];
  /** Clés de chiffrement des comptes marchands et du HMAC des numéros (ADR 0013 §8, §9) ;
   *  absentes : les routes de paiement répondent 503. Jamais en base. */
  cles: { marchands: Buffer; hmac: Buffer } | null;
  /** Fichiers construits du tableau de bord (WAKATNET_TABLEAU_DIR) ; absent : apps/dashboard/dist. */
  dossierTableau?: string | null;
  /** Fichiers d'état des nœuds écrits par le collecteur (WAKATNET_ETATS_NOEUDS, séparés par des virgules). */
  etatsNoeuds?: string[];
  /** Envoi d'e-mails (ADR 0019) : Brevo, clé et expéditeur ; absent : aucun envoi, le super-admin valide les adresses. */
  courriel?: { fournisseur: "brevo"; cle: string; de: string; nom: string };
  /** Proxy inverse de confiance (ADR 0016 §2 : nginx local) ; absent : aucune confiance dans X-Forwarded-For. */
  trustProxy?: string;
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
  // Sans clé HMAC, les sources (IP) des échecs de connexion et des demandes de paiement seraient gardées en clair
  // (connexion_echec.source, source_demande.source) : refusé en production (T10 de docs/CONFORMITE.md, ADR 0016 §2).
  if (!env.WAKATNET_CLE_HMAC && env.NODE_ENV === "production") {
    throw new ConfigInvalide("WAKATNET_CLE_HMAC requise en production : sans elle, les IP sources seraient gardées en clair (ADR 0016 §2)");
  }
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
  // Même règle que le walled garden des routeurs (routeros.ts, hoteDns) : vérifiée au démarrage, sinon l'étape 2 échouerait
  // APRÈS la consommation du jeton d'enrôlement (relecture de sécurité n° 2).
  const hotePortail = new URL(urlPortail).hostname;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(hotePortail) || hotePortail.length > 253) {
    throw new ConfigInvalide("WAKATNET_PORTAIL_URL_PUBLIQUE : nom d'hôte DNS complet attendu (portail.domaine)");
  }
  const portailIps = (env.WAKATNET_PORTAIL_IPS ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "");
  for (const a of portailIps) {
    if (!/^(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){3}$/.test(a)) {
      throw new ConfigInvalide("WAKATNET_PORTAIL_IPS : adresses IPv4 séparées par des virgules");
    }
  }
  const dossierTableau = env.WAKATNET_TABLEAU_DIR || undefined;
  const trustProxy = env.WAKATNET_TRUST_PROXY || undefined;
  if (trustProxy !== undefined && !/^[0-9a-f.:/,]+$/i.test(trustProxy)) throw new ConfigInvalide("WAKATNET_TRUST_PROXY : adresses IP séparées par des virgules");
  // Sans lui, derrière nginx, toutes les requêtes viennent de 127.0.0.1 : les limites par source (M2, M7)
  // retomberaient en silence sur une seule source. Refusé en production (relecture de la migration 0031).
  if (trustProxy === undefined && env.NODE_ENV === "production") throw new ConfigInvalide("WAKATNET_TRUST_PROXY requis en production (ADR 0016 §2)");
  if (portailIps.length === 0 && env.NODE_ENV === "production") {
    throw new ConfigInvalide("WAKATNET_PORTAIL_IPS exigée en production : IP dédiée du portail, ouverte dans le walled garden des routeurs");
  }
  // ADR 0019 : WAKATNET_COURRIEL=brevo exige la clé (EnvironmentFile, jamais en argument) et l'expéditeur.
  let courriel: Config["courriel"];
  if (env.WAKATNET_COURRIEL) {
    if (env.WAKATNET_COURRIEL !== "brevo") throw new ConfigInvalide("WAKATNET_COURRIEL : « brevo » seulement (ADR 0019)");
    const cle = env.WAKATNET_BREVO_CLE ?? "", de = env.WAKATNET_COURRIEL_DE ?? "";
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(cle)) throw new ConfigInvalide("WAKATNET_BREVO_CLE manquante ou invalide");
    if (!/^[^@\s]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i.test(de)) throw new ConfigInvalide("WAKATNET_COURRIEL_DE : adresse de l'expéditeur");
    courriel = { fournisseur: "brevo", cle, de, nom: env.WAKATNET_COURRIEL_NOM || "WAKATNET" };
  }
  const etatsNoeuds = (env.WAKATNET_ETATS_NOEUDS ?? "/var/lib/wakatnet/sante/etat.json").split(",").filter(Boolean);
  return { urlBase, urlPublique, urlPortail, portailIps, noeuds: lireNoeuds(env.WAKATNET_NOEUDS), cles, etatsNoeuds, ...(courriel ? { courriel } : {}), ...(trustProxy ? { trustProxy } : {}), ...(dossierTableau ? { dossierTableau } : {}) };
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
