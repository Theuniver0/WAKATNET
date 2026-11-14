// Faux serveur MoneyFusion pour les tests (ADR 0024) : formes de requête et de réponse reprises de la documentation
// officielle (https://docs.moneyfusion.net/fr/webapi, lue le 14/11/2026). Jamais contre le vrai MoneyFusion.
//   POST /api/<lien du marchand>  → {statut, token, message, url}   (le lien API est l'URL complète)
//   GET  /paiementNotif/<token>    → {statut, data: {tokenPay, personal_Info, Montant, frais, statut, moyen, …}, message}
//   GET  /payment/<token>          → page de paiement hébergée (le client y est redirigé)
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type PaiementFaux = { token: string; corps: Record<string, unknown>; statut: string; Montant: unknown; frais: number; moyen: string };

export class FauxMoneyfusion {
  readonly paiements = new Map<string, PaiementFaux>();
  readonly requetes: { methode: string; chemin: string; corps: unknown }[] = [];
  /** Réponse forcée au prochain POST de paiement : { statut HTTP, corps }. */
  prochaineReponse: { statut: number; corps: unknown } | null = null;
  url = "";
  private serveur = createServer((req, rep) => void this.traiter(req, rep));

  /** Lien API d'un marchand sur ce faux serveur (le chemin tient lieu de clé). */
  lien(cle = randomBytes(12).toString("hex")): string { return `${this.url}/api/${cle}`; }

  async demarrer(): Promise<this> {
    await new Promise<void>((r) => this.serveur.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.serveur.address() as AddressInfo).port}`;
    return this;
  }

  async arreter(): Promise<void> {
    this.serveur.closeAllConnections();
    await new Promise<void>((r) => this.serveur.close(() => r()));
  }

  /** Corps du webhook tel que MoneyFusion l'envoie (événement documenté), pour un paiement connu. */
  webhook(token: string, event = "payin.session.completed"): string {
    const p = this.paiements.get(token)!;
    return JSON.stringify({ event, personal_Info: p.corps.personal_Info, tokenPay: token, numeroSend: p.corps.numeroSend,
      nomclient: p.corps.nomclient, numeroTransaction: "0101010101", Montant: p.Montant, frais: p.frais,
      return_url: p.corps.return_url, webhook_url: p.corps.webhook_url, createdAt: new Date().toISOString() });
  }

  private async traiter(req: IncomingMessage, rep: ServerResponse): Promise<void> {
    const morceaux: Buffer[] = [];
    for await (const m of req) morceaux.push(m as Buffer);
    const brut = Buffer.concat(morceaux).toString("utf8");
    let corps: unknown = null;
    try { corps = brut ? JSON.parse(brut) : null; } catch { corps = brut; }
    const chemin = (req.url ?? "").split("?")[0];
    this.requetes.push({ methode: req.method ?? "", chemin, corps });
    const json = (statut: number, c: unknown) => { rep.writeHead(statut, { "content-type": "application/json" }); rep.end(JSON.stringify(c)); };
    if (req.method === "POST" && chemin.startsWith("/api/")) {
      if (this.prochaineReponse) { const r = this.prochaineReponse; this.prochaineReponse = null; return json(r.statut, r.corps); }
      const c = corps as Record<string, unknown>;
      const token = randomBytes(10).toString("hex");
      // Moyen d'un compte du Burkina [valeur réelle À CONFIRMER] ; la documentation montre « orange ».
      this.paiements.set(token, { token, corps: c, statut: "pending", Montant: c.totalPrice, frais: 5, moyen: "orange-money-burkina" });
      return json(200, { statut: true, token, message: "paiement en cours", url: `${this.url}/payment/${token}` });
    }
    const m = /^\/paiementNotif\/([A-Za-z0-9_-]+)$/.exec(chemin);
    if (req.method === "GET" && m) {
      const p = this.paiements.get(m[1]);
      if (!p) return json(404, { statut: false, message: "paiement introuvable" });
      return json(200, { statut: true, message: "details paiement", data: {
        _id: "65df163b11ab882694573060", tokenPay: p.token, numeroSend: p.corps.numeroSend, nomclient: p.corps.nomclient,
        personal_Info: p.corps.personal_Info, numeroTransaction: "0101010101", Montant: p.Montant, frais: p.frais,
        statut: p.statut, moyen: p.moyen, return_url: p.corps.return_url, createdAt: new Date().toISOString() } });
    }
    json(404, { statut: false, message: "inconnu" });
  }
}
