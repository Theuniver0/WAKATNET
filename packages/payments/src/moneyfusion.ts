// WAKATNET — adaptateur MoneyFusion (« Fusion Pay »), ADR 0024. Remplace pawaPay et CinetPay (décision de Yacouba du
// 14/11/2026).
// Source : documentation officielle https://docs.moneyfusion.net/fr/webapi (lue le 14/11/2026, fichier « webapi.md »),
// recoupée avec la liste publique GET https://pay.moneyfusion.net/api/v1/withdraw/methods (Burkina Faso : XOF,
// orange-money-burkina, moov-burkina-faso). Tout ce que la documentation ne dit pas est marqué [À CONFIRMER] et
// tranché dans le sens sûr.
//
// Contrat (documentation) :
//   - Paiement : POST <lien API du marchand> {totalPrice, article, personal_Info, numeroSend, nomclient, return_url,
//     webhook_url} → {statut, token, message, url}. Le client paie sur la page HÉBERGÉE `url` (payin.moneyfusion.net) :
//     flux « redirect », pas de code OTP chez nous. Seules les IP déclarées dans l'application du marchand sont acceptées.
//   - Statut : GET https://pay.moneyfusion.net/paiementNotif/{token} → {statut, data: {tokenPay, personal_Info,
//     numeroTransaction, Montant, frais, statut: pending|failure|no paid|paid, moyen, …}}. SANS authentification.
//   - Webhook : POST {event: payin.session.pending|completed|cancelled, tokenPay, personal_Info, Montant, frais, …}.
//     AUCUNE SIGNATURE documentée : il n'est qu'un déclencheur ; seul verify() fait foi (A5).
//
// Choix (relecture argent, règle 4) :
//   - Notre référence voyage dans personal_Info[0].reference et revient au statut : verify() la compare.
//   - Le jeton MoneyFusion (token) est notre referenceFournisseur : verify() en a besoin (le statut ne se lit que par lui).
//   - `Montant` du statut est lu comme le montant payé [À CONFIRMER au premier paiement réel : brut ou net de `frais` ?
//     L'exemple du statut donne Montant 200 pour totalPrice 200, celui du webhook 194 + 6]. S'il était net, chaque
//     paiement finirait en MISMATCH (écart, aucun ticket) : jamais un ticket non payé (A8).
//   - Devise : le statut n'en porte pas. Le compte du marchand doit être au Burkina (XOF) ; « XOF » est donc posé, et
//     cette hypothèse est consignée dans l'ADR 0024 [À CONFIRMER].
//   - « no paid » (paiement non effectué) reste PENDING : il peut désigner un paiement que le client n'a pas encore
//     validé ; l'expiration (§7.2) le clôt, et un succès tardif reste repris.
import {
  FournisseurIndisponible, PaiementRefuse, SignatureInvalide,
  type Capacites, type DemandePaiement, type EtatPaiement, type EvenementWebhook, type FournisseurPaiement, type ResultatPaiement,
} from "./fournisseur.ts";

export type ClesMoneyfusion = { lienApi: string };

/** Lien API du marchand, généré par MoneyFusion (« API de paiement » du tableau de bord) [forme exacte À CONFIRMER] :
 *  HTTPS, sur un hôte moneyfusion.net, sans espace ni paramètre. Il vaut clé : il n'est jamais affiché ni journalisé. */
export const FORME_LIEN_API = /^https:\/\/([a-z0-9-]+\.)*moneyfusion\.net\/[A-Za-z0-9/_.-]{1,512}$/;
export const URL_STATUT = "https://pay.moneyfusion.net/paiementNotif/";
/** Page de paiement hébergée (documentation : https://payin.moneyfusion.net/payment/<token>/<marchand>). */
export const FORME_URL_PAIEMENT = /^https:\/\/payin\.moneyfusion\.net\/[A-Za-z0-9/_.%-]{1,512}$/;
const FORME_JETON = /^[A-Za-z0-9_-]{4,128}$/;
/** Moyens de paiement du Burkina Faso (liste publique des moyens de MoneyFusion, 14/11/2026) [À CONFIRMER : la valeur
 *  de `moyen` au statut d'un paiement entrant ; la documentation montre « orange » sans pays]. */
export const MOYENS_XOF_BURKINA = new Set(["orange-money-burkina", "moov-burkina-faso"]);
const EVENEMENTS = new Set(["payin.session.pending", "payin.session.completed", "payin.session.cancelled"]);
/** Budgets totaux, sous ceux du service (DELAI_CHARGE_MS 15 s, DELAI_VERIFY_MS 10 s) : la requête est ANNULÉE. */
const BUDGET_CHARGE_MS = 12_000;
const BUDGET_VERIFY_MS = 9_000;

type Options = {
  /** Tests seulement (faux serveur local) : remplace l'URL du statut et la forme de la page de paiement. */
  urlStatut?: string;
  formeUrlPaiement?: RegExp;
  /** Adresse de notification de ce compte marchand (route publique /webhooks/moneyfusion/<id>). */
  urlWebhook?: string;
};

export class MoneyfusionProvider implements FournisseurPaiement {
  readonly id = "moneyfusion";
  private readonly lienApi: string;
  private readonly urlStatut: string;
  private readonly formeUrlPaiement: RegExp;
  private readonly urlWebhook?: string;

  constructor(cles: ClesMoneyfusion, options: Options = {}) {
    this.lienApi = cles.lienApi;
    this.urlStatut = options.urlStatut ?? URL_STATUT;
    this.formeUrlPaiement = options.formeUrlPaiement ?? FORME_URL_PAIEMENT;
    this.urlWebhook = options.urlWebhook;
  }

  capacites(): Capacites {
    // Montant minimal non publié [À CONFIRMER] : 100 F, comme les autres agrégateurs du Burkina.
    return { operateurs: ["orange_bf", "moov_bf"], flux: ["redirect"], reversement: false, montantMin: 100 };
  }

  private async json(url: string, init: RequestInit, budget: number): Promise<{ http: number; corps: Record<string, unknown> }> {
    let rep: Response;
    try {
      rep = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(budget) });
    } catch {
      throw new FournisseurIndisponible("MoneyFusion injoignable");
    }
    let corps: unknown = null;
    try { corps = await rep.json(); } catch { /* corps vide ou non JSON */ }
    return { http: rep.status, corps: corps !== null && typeof corps === "object" && !Array.isArray(corps) ? corps as Record<string, unknown> : {} };
  }

  async charge(d: DemandePaiement): Promise<ResultatPaiement> {
    if (d.devise !== "XOF" || !Number.isSafeInteger(d.montant) || d.montant < 100 || d.montant > 2_000_000) {
      throw new PaiementRefuse("montant invalide (100 à 2 000 000 XOF)");
    }
    if (!/^wk_[A-Za-z0-9_-]{22}$/.test(d.reference)) throw new PaiementRefuse("référence invalide");
    if (!/^[0-9]{8}$/.test(d.numero)) throw new PaiementRefuse("numéro invalide");
    if (!d.urlRetour || !/^https?:\/\//.test(d.urlRetour) || d.urlRetour.length > 512) {
      throw new FournisseurIndisponible("MoneyFusion : page de retour non configurée");
    }
    if (!this.urlWebhook) throw new FournisseurIndisponible("MoneyFusion : adresse de notification non configurée");
    const { http, corps } = await this.json(this.lienApi, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        totalPrice: d.montant,
        article: [{ "Forfait WiFi": d.montant }],
        // Notre référence revient au statut et au webhook : verify() la compare (pas de donnée du client ici).
        personal_Info: [{ reference: d.reference }],
        numeroSend: d.numero,
        // Exigé par l'API ; aucun nom n'est demandé au client (minimisation, CONFORMITE §6).
        nomclient: "Client WiFi",
        return_url: d.urlRetour,
        webhook_url: this.urlWebhook,
      }),
    }, BUDGET_CHARGE_MS);
    // Refus de la demande (IP non déclarée, application non approuvée…) : aucune page de paiement n'a été remise au
    // client, donc aucun argent ne peut bouger. Le paiement reste CREATED et expire ; le client voit « réessayez ».
    // Le message de MoneyFusion n'est jamais montré au client.
    if (http >= 400 || corps.statut !== true) {
      const m = typeof corps.message === "string" ? corps.message.slice(0, 120) : "";
      throw new FournisseurIndisponible(`MoneyFusion : demande refusée (HTTP ${http}${m ? `, ${m}` : ""})`);
    }
    const jeton = corps.token, url = corps.url;
    if (typeof jeton !== "string" || !FORME_JETON.test(jeton)) throw new FournisseurIndisponible("MoneyFusion : jeton de paiement absent");
    // La page de paiement vient du fournisseur : jamais une redirection vers un autre domaine (relecture : redirection ouverte).
    if (typeof url !== "string" || !this.formeUrlPaiement.test(url)) throw new FournisseurIndisponible("MoneyFusion : page de paiement inattendue");
    return { referenceFournisseur: jeton, statut: "PENDING", urlPaiement: url };
  }

  async verify(reference: string, referenceFournisseur?: string): Promise<EtatPaiement> {
    if (!/^wk_[A-Za-z0-9_-]{22}$/.test(reference)) throw new TypeError("référence de paiement invalide");
    // Sans jeton : charge() n'a pas encore rendu sa réponse (ou n'a jamais abouti). Ne JAMAIS rendre PENDING ici : un
    // webhook « pending » arrivé pendant charge() ferait passer le paiement à PENDING, et le jeton noté ensuite par
    // charge() serait perdu (paiement_transition ne réécrit pas un statut identique) : client débité, aucun ticket
    // (relecture du 14/11/2026, bloquant n° 1). L'erreur laisse le paiement CREATED ; charge() note alors le jeton.
    if (!referenceFournisseur) throw new FournisseurIndisponible("MoneyFusion : jeton pas encore noté");
    if (!FORME_JETON.test(referenceFournisseur)) throw new FournisseurIndisponible("MoneyFusion : jeton enregistré invalide");
    const { http, corps } = await this.json(`${this.urlStatut}${encodeURIComponent(referenceFournisseur)}`,
      { method: "GET", headers: { accept: "application/json" } }, BUDGET_VERIFY_MS);
    if (http >= 400 || corps.statut !== true || typeof corps.data !== "object" || corps.data === null) {
      throw new FournisseurIndisponible(`MoneyFusion : statut illisible (HTTP ${http})`);
    }
    const d = corps.data as Record<string, unknown>;
    if (d.tokenPay !== referenceFournisseur) throw new FournisseurIndisponible("MoneyFusion : jeton inattendu");
    const notre = referenceDe(d.personal_Info);
    if (notre !== null && notre !== reference) throw new FournisseurIndisponible("MoneyFusion : référence inattendue");
    const s = typeof d.statut === "string" ? d.statut : "";
    let statut: EtatPaiement["statut"];
    if (s === "paid") statut = "SUCCEEDED";
    else if (s === "failure") statut = "FAILED";
    else if (s === "pending" || s === "no paid") statut = "PENDING";
    // Statut inconnu : jamais lu comme un échec (le client a peut-être payé) ; réessayé au tour suivant.
    else throw new FournisseurIndisponible(`MoneyFusion : statut inattendu ${s.slice(0, 40) || "?"}`);
    // A8 : le montant brut du fournisseur est rendu tel quel ; le service le normalise (versXof) ou le marque illisible.
    // Devise : le statut n'en porte pas. On ne pose « XOF » que pour un moyen de paiement du Burkina connu ; sinon « ? »
    // fait passer le paiement en MISMATCH (aucun ticket) : un paiement en GNF ou en XAF ne vaut jamais un forfait en XOF
    // (relecture n° 2). Valeurs exactes de `moyen` au paiement [À CONFIRMER au premier paiement réel].
    const moyen = typeof d.moyen === "string" ? d.moyen : "";
    return { reference, referenceFournisseur, statut, montant: d.Montant as number, devise: MOYENS_XOF_BURKINA.has(moyen) ? "XOF" : "?" };
  }

  /** Aucune signature n'est documentée : le corps n'est qu'un déclencheur de verify(). On n'en garde que le jeton et notre
   *  référence, bornés ; un corps illisible est refusé (401) sans effet. */
  parseWebhook(_enTetes: Record<string, string | string[] | undefined>, corpsBrut: Buffer): EvenementWebhook {
    let j: unknown;
    try { j = JSON.parse(corpsBrut.toString("utf8")); } catch { throw new SignatureInvalide("corps illisible"); }
    if (typeof j !== "object" || j === null || Array.isArray(j)) throw new SignatureInvalide("corps inattendu");
    const o = j as Record<string, unknown>;
    if (typeof o.event !== "string" || !EVENEMENTS.has(o.event)) throw new SignatureInvalide("événement inconnu");
    if (typeof o.tokenPay !== "string" || !FORME_JETON.test(o.tokenPay)) throw new SignatureInvalide("jeton absent");
    const notre = referenceDe(o.personal_Info);
    return { idEvenement: `${o.event}:${o.tokenPay}`, reference: notre ?? "", referenceFournisseur: o.tokenPay };
  }
}

/** personal_Info[0].reference, si c'est une de nos références ; sinon null. */
function referenceDe(v: unknown): string | null {
  if (!Array.isArray(v) || v.length < 1 || typeof v[0] !== "object" || v[0] === null) return null;
  const r = (v[0] as Record<string, unknown>).reference;
  return typeof r === "string" && /^wk_[A-Za-z0-9_-]{22}$/.test(r) ? r : null;
}
