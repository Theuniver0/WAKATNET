// Faux serveur CinetPay v1 pour les tests (ADR 0022) : formes de requête et de réponse reprises du SDK officiel
// cinetpay-js 0.1.1 (lu le 13/11/2026). Jamais contre le vrai CinetPay. Ce que le SDK ne montre pas (montant dans la
// réponse de statut) est réglable : `montantDansStatut`.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const CLE_TEST = "sk_test_cle-de-test-cinetpay-0123";
export const MDP_TEST = "mot-de-passe-de-test-cinetpay";

export type TransactionFausse = { merchant_transaction_id: string; transaction_id: string; status: string; amount: number;
                                  currency: string; notify_token: string; corps: Record<string, unknown> };

export class FauxCinetpay {
  readonly transactions = new Map<string, TransactionFausse>();
  readonly requetes: { methode: string; chemin: string; autorisation: string | undefined; corps: unknown }[] = [];
  /** Réponse forcée au prochain POST /v1/payment : { statut HTTP, corps }. */
  prochaineReponse: { statut: number; corps: unknown } | null = null;
  /** Réponse forcée au prochain GET /v1/payment/… */
  prochainStatut: { statut: number; corps: unknown } | null = null;
  /** Le statut contient-il amount et currency ? Le SDK n'en lit aucun : FAUX par défaut (forme du SDK, relecture n° 2).
   *  Vrai seulement dans les cas qui le disent : hypothèse [À CONFIRMER] au bac à sable (ADR 0022). */
  montantDansStatut = false;
  /** Latence de POST /v1/oauth/login (délai global de charge(), relecture n° 3). */
  latenceConnexionMs = 0;
  /** Prochain GET /v1/payment/… : 404 sans corps JSON (répartiteur, pare-feu ; relecture n° 4). */
  prochain404Html = false;
  /** Jetons délivrés ; un jeton révoqué rend 1003 EXPIRED_TOKEN. */
  readonly jetons = new Set<string>();
  connexions = 0;
  url = "";
  private serveur = createServer((req, rep) => void this.traiter(req, rep));

  async demarrer(): Promise<this> {
    await new Promise<void>((r) => this.serveur.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.serveur.address() as AddressInfo).port}`;
    return this;
  }

  arreter(): Promise<void> {
    return new Promise((r) => this.serveur.close(() => r()));
  }

  /** Corps du webhook v1 tel que le SDK le lit (parseNotification). */
  notification(t: TransactionFausse): string {
    return JSON.stringify({ notify_token: t.notify_token, merchant_transaction_id: t.merchant_transaction_id, transaction_id: t.transaction_id,
                            user: { name: "Client", email: "client@wakatnet.invalid", phone_number: "+22607345678" } });
  }

  private async traiter(req: IncomingMessage, rep: ServerResponse): Promise<unknown> {
    let brut = "";
    for await (const d of req) brut += d;
    const chemin = (req.url ?? "").split("?")[0];
    const corps = brut ? JSON.parse(brut) as Record<string, unknown> : undefined;
    this.requetes.push({ methode: req.method!, chemin, autorisation: req.headers.authorization, corps });
    const json = (statut: number, v: unknown) => rep.writeHead(statut, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (req.method === "POST" && chemin === "/v1/oauth/login") {
      this.connexions++;
      if (this.latenceConnexionMs > 0) await new Promise((r) => setTimeout(r, this.latenceConnexionMs));
      // Second mot de passe valable : un couple distinct, donc sans jeton en cache (test du délai global).
      if (corps?.api_key !== CLE_TEST || (corps?.api_password !== MDP_TEST && corps?.api_password !== `${MDP_TEST}-lent`)) {
        return json(401, { code: 1005, status: "INVALID_CREDENTIALS", description: "identifiants invalides" });
      }
      const j = randomBytes(24).toString("base64url");
      this.jetons.add(j);
      return json(200, { code: 200, status: "OK", access_token: j, token_type: "Bearer" });
    }
    const jeton = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!jeton) return json(401, { code: 1002, status: "INVALID_TOKEN" });
    if (!this.jetons.has(jeton)) return json(401, { code: 1003, status: "EXPIRED_TOKEN" });
    if (req.method === "POST" && chemin === "/v1/payment") {
      if (this.prochaineReponse) { const r = this.prochaineReponse; this.prochaineReponse = null; return json(r.statut, r.corps); }
      const c = corps!;
      const ref = String(c.merchant_transaction_id);
      if (this.transactions.has(ref)) return json(200, { code: 1200, status: "TRANSACTION_EXIST", description: "transaction existante" });
      const t: TransactionFausse = { merchant_transaction_id: ref, transaction_id: `cp-${randomBytes(8).toString("hex")}`, status: "INITIATED",
        amount: Number(c.amount), currency: String(c.currency), notify_token: randomBytes(16).toString("hex"), corps: c };
      this.transactions.set(ref, t);
      return json(200, { code: 200, status: "OK", payment_token: randomBytes(8).toString("hex"), notify_token: t.notify_token,
        transaction_id: t.transaction_id, merchant_transaction_id: ref, payment_url: "",
        details: { code: 2001, status: "INITIATED", message: "en attente du client", must_be_redirected: false } });
    }
    const m = /^\/v1\/payment\/([^/]+)$/.exec(chemin);
    if (req.method === "GET" && m) {
      if (this.prochainStatut) { const r = this.prochainStatut; this.prochainStatut = null; return json(r.statut, r.corps); }
      if (this.prochain404Html) { this.prochain404Html = false; return rep.writeHead(404, { "content-type": "text/html" }).end("<html>404</html>"); }
      const id = decodeURIComponent(m[1]);
      const t = this.transactions.get(id) ?? [...this.transactions.values()].find((x) => x.transaction_id === id);
      if (!t) return json(404, { code: 404, status: "NOT_FOUND", description: "transaction introuvable" });
      return json(200, { code: 200, status: t.status, merchant_transaction_id: t.merchant_transaction_id, transaction_id: t.transaction_id,
        user: { name: "Client", email: "", phone_number: "" },
        ...(this.montantDansStatut ? { amount: t.amount, currency: t.currency } : {}) });
    }
    json(404, { code: 404, status: "NOT_FOUND" });
  }
}
