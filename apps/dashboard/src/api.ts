// Appels à l'API : même origine, cookie de session, en-tête anti-CSRF sur toute requête qui modifie (ADR 0014 §1).

export class ErreurApi extends Error {
  readonly statut: number;
  constructor(statut: number, message: string) {
    super(message);
    this.statut = statut;
  }
}

let surSessionPerdue: () => void = () => {};
/** Appelé quand l'API répond 401 hors écran de connexion : retour à la connexion. */
export function surSession(f: () => void): void {
  surSessionPerdue = f;
}

const MESSAGES: Record<number, string> = {
  401: "Votre session a expiré. Reconnectez-vous.",
  403: "Vous n'avez pas le droit de faire cela.",
  404: "Élément introuvable.",
  409: "Cette action est en conflit avec l'état actuel.",
  422: "Les informations saisies ne sont pas valides.",
  429: "Trop d'essais. Patientez un moment.",
  503: "Service momentanément indisponible.",
};

type Options = { corps?: unknown; sans401?: boolean };

export async function appel<T>(methode: "GET" | "POST" | "PUT", chemin: string, o: Options = {}): Promise<T> {
  const entetes: Record<string, string> = { Accept: "application/json" };
  if (methode !== "GET") entetes["X-Wakatnet-Requete"] = "1";
  let corps: string | undefined;
  if (o.corps !== undefined) {
    entetes["Content-Type"] = "application/json";
    corps = JSON.stringify(o.corps);
  }
  let r: Response;
  try {
    r = await fetch(chemin, { method: methode, credentials: "same-origin", headers: entetes, body: corps });
  } catch {
    throw new ErreurApi(0, "Connexion impossible. Vérifiez votre accès Internet.");
  }
  if (!r.ok) {
    let message = MESSAGES[r.status] ?? "Une erreur est survenue.";
    try {
      const j: unknown = await r.json();
      if (typeof j === "object" && j !== null && "erreur" in j && typeof j.erreur === "string") message = j.erreur;
    } catch {
      /* corps non JSON : message par défaut */
    }
    if (r.status === 401 && !o.sans401) surSessionPerdue();
    throw new ErreurApi(r.status, message);
  }
  const texte = await r.text();
  return (texte === "" ? null : JSON.parse(texte)) as T;
}

export const lire = <T,>(chemin: string): Promise<T> => appel<T>("GET", chemin);
export const envoyer = <T,>(chemin: string, corps?: unknown, o: { sans401?: boolean } = {}): Promise<T> =>
  appel<T>("POST", chemin, { corps: corps ?? {}, sans401: o.sans401 });
export const modifier = <T,>(chemin: string, corps: unknown): Promise<T> => appel<T>("PUT", chemin, { corps });

export const messageDe = (e: unknown): string => (e instanceof Error ? e.message : "Une erreur est survenue.");

// Types des réponses (lus dans apps/api/src, l'OpenAPI ne les décrit pas).
export type Role = "proprietaire" | "gerant" | "vendeur" | "super_admin";
export type Moi = { id: string; role: Role; email: string; tenant_id: string | null; point_of_sale_id: string | null; totp_ok: boolean };
export type Site = { id: string; nom: string };
export type Routeur = { id: string; site_id: string; overlay_ip: string; nom: string; actif: boolean; enrole_le: string | null };
export type Forfait = {
  id: string; nom: string; prix_xof: number; uptime_limit_s: number | null; validity_s: number | null;
  data_limit_bytes: number | null; rate_limit: string | null; devices: number; bind_mac: boolean; site_id: string | null; actif: boolean;
};
export type PointDeVente = { id: string; nom: string };
export type Lot = {
  id: string; forfait: string; point_de_vente_id: string; point_de_vente: string; quantite: number; cree_le: string; remis_le: string | null;
  etats: { genere: number; remis: number; active: number; expire: number };
};
export type StatPapier = { point_de_vente_id: string; point_de_vente: string; utilisateur: string; tickets: number; actives: number; valeur_activee_xof: number };
export type SyntheseArgent = {
  ventes_en_ligne: number; ventes_en_ligne_xof: number; tickets_papier_actives: number; tickets_papier_xof: number;
  commissions_xof: number; frais_papier_xof: number; recharges_xof: number; solde_credits_xof: number; plafond_decouvert_xof: number;
};
export type Paiement = { reference: string; statut: string; montant_xof: number; numero: string; le: string; site: string };
export type Proprietaire = {
  id: string; nom: string; suspendu: boolean; commission_bps: number; plafond_decouvert_xof: number; solde_credits_xof: number;
  ventes_en_ligne_xof: number; commissions_xof: number; frais_papier_xof: number;
};
