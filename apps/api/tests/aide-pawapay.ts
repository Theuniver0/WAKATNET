// Faux serveur pawaPay v2 pour les tests (ADR 0020) : formes de requête et de réponse reprises de la documentation
// officielle (docs.pawapay.io/v2, lue le 12/11/2026), et callbacks signés RFC 9421 comme pawaPay les envoie
// (ECDSA P-256 / SHA-256, signature DER, Content-Digest sha-512). Jamais contre le vrai pawaPay.
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export type DepotFaux = { depositId: string; status: string; amount: string; currency: string; clientReferenceId?: string;
                          provider: string; phoneNumber: string; preAuthorisationCode?: string };

export class FauxPawapay {
  readonly depots = new Map<string, DepotFaux>();
  readonly requetes: { methode: string; chemin: string; autorisation: string | undefined; corps: unknown }[] = [];
  /** Réponse forcée au prochain POST /v2/deposits : { statut HTTP, corps }. */
  prochaineReponse: { statut: number; corps: unknown } | null = null;
  /** Configuration active rendue par GET /v2/active-conf (callbacks signés activés par défaut). */
  callbacksSignes = true;
  /** Clés publiques en panne : GET /v2/public-key/http répond 500 (audit du 13/11/2026, relecture bornée). */
  clesEnPanne = false;
  /** Montant rendu par GET (pawaPay rend « 100.00 » pour « 100 » demandé). */
  formatMontant = (m: string) => `${m}.00`;
  cle: { privee: KeyObject; id: string; pem: string };
  url = "";
  private serveur = createServer((req, rep) => void this.traiter(req, rep));

  constructor() {
    this.cle = FauxPawapay.nouvelleCle("HTTP_EC_P256_KEY:1");
  }

  static nouvelleCle(id: string) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    return { privee: privateKey, id, pem: publicKey.export({ type: "spki", format: "pem" }).toString() };
  }

  async demarrer(): Promise<this> {
    await new Promise<void>((r) => this.serveur.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.serveur.address() as AddressInfo).port}`;
    return this;
  }

  arreter(): Promise<void> {
    return new Promise((r) => this.serveur.close(() => r()));
  }

  private async traiter(req: IncomingMessage, rep: import("node:http").ServerResponse): Promise<unknown> {
    let brut = "";
    for await (const d of req) brut += d;
    const chemin = (req.url ?? "").split("?")[0];
    const corps = brut ? JSON.parse(brut) : undefined;
    this.requetes.push({ methode: req.method!, chemin, autorisation: req.headers.authorization, corps });
    const json = (statut: number, v: unknown) => rep.writeHead(statut, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (req.headers.authorization !== "Bearer jeton-de-test-pawapay-0123456789") return json(401, { failureReason: { failureCode: "NO_AUTHENTICATION" } });
    if (req.method === "GET" && chemin === "/v2/public-key/http" && this.clesEnPanne) return json(500, { failureReason: { failureCode: "UNKNOWN_ERROR" } });
    if (req.method === "GET" && chemin === "/v2/public-key/http") return json(200, [{ id: this.cle.id, key: this.cle.pem }]);
    if (req.method === "GET" && chemin === "/v2/active-conf") {
      return json(200, { companyName: "Essai", signatureConfiguration: { signedRequestsOnly: false, signedCallbacks: this.callbacksSignes },
        countries: [{ country: "BFA", prefix: "226", providers: [{ provider: "ORANGE_BFA" }, { provider: "MOOV_BFA" }] }] });
    }
    if (req.method === "POST" && chemin === "/v2/deposits") {
      if (this.prochaineReponse) { const r = this.prochaineReponse; this.prochaineReponse = null; return json(r.statut, r.corps); }
      const c = corps as { depositId: string; amount: string; currency: string; clientReferenceId?: string; preAuthorisationCode?: string;
                           payer: { accountDetails: { phoneNumber: string; provider: string } } };
      if (this.depots.has(c.depositId)) return json(200, { depositId: c.depositId, status: "DUPLICATE_IGNORED", created: new Date().toISOString() });
      this.depots.set(c.depositId, { depositId: c.depositId, status: "ACCEPTED", amount: c.amount, currency: c.currency,
        clientReferenceId: c.clientReferenceId, provider: c.payer.accountDetails.provider, phoneNumber: c.payer.accountDetails.phoneNumber,
        preAuthorisationCode: c.preAuthorisationCode });
      return json(200, { depositId: c.depositId, status: "ACCEPTED", created: new Date().toISOString() });
    }
    const m = /^\/v2\/deposits\/([0-9a-f-]{36})$/.exec(chemin);
    if (req.method === "GET" && m) {
      const d = this.depots.get(m[1]);
      if (!d) return json(200, { status: "NOT_FOUND" });
      return json(200, { status: "FOUND", data: this.donnees(d) });
    }
    if (req.method === "GET" && chemin === "/redirection") return rep.writeHead(302, { location: "https://ailleurs.invalid/" }).end();
    json(404, {});
  }

  /** Objet Deposit tel que GET /v2/deposits/{id} et le callback le rendent. */
  donnees(d: DepotFaux): Record<string, unknown> {
    return {
      depositId: d.depositId, status: d.status, amount: this.formatMontant(d.amount), currency: d.currency, country: "BFA",
      payer: { type: "MMO", accountDetails: { phoneNumber: d.phoneNumber, provider: d.provider } },
      created: new Date().toISOString(), ...(d.clientReferenceId ? { clientReferenceId: d.clientReferenceId } : {}),
      ...(d.status === "COMPLETED" ? { providerTransactionId: "OP-123456" } : {}),
      ...(d.status === "FAILED" ? { failureReason: { failureCode: "PAYMENT_NOT_APPROVED", failureMessage: "non approuvé" } } : {}),
    };
  }
}

/** Callback signé comme pawaPay (doc « signatures ») : composants @method @authority @path signature-date
 *  content-digest content-type ; alg ecdsa-p256-sha256 ; signature DER en base64 ; étiquette sig-pp. */
export function callbackSigne(corps: string, o: { autorite: string; chemin: string; cle: { privee: KeyObject; id: string };
                                                 cree?: number; dsa?: "der" | "ieee-p1363"; alg?: string;
                                                 composants?: string[]; expires?: number | null }): Record<string, string> {
  const cree = o.cree ?? Math.floor(Date.now() / 1000);
  const date = new Date(cree * 1000).toISOString();
  const digest = `sha-512=:${createHash("sha512").update(corps).digest("base64")}:`;
  const type = "application/json; charset=UTF-8";
  const composants = o.composants ?? ["@method", "@authority", "@path", "signature-date", "content-digest", "content-type"];
  const valeurs: Record<string, string> = { "@method": "POST", "@authority": o.autorite, "@path": o.chemin,
                                            "signature-date": date, "content-digest": digest, "content-type": type };
  const params = `(${composants.map((c) => `"${c}"`).join(" ")});alg="${o.alg ?? "ecdsa-p256-sha256"}";keyid="${o.cle.id}";created=${cree}${o.expires === null ? "" : `;expires=${o.expires ?? cree + 60}`}`;
  const base = [...composants.map((c) => `"${c}": ${valeurs[c]}`), `"@signature-params": ${params}`].join("\n");
  const sig = sign("sha256", Buffer.from(base), { key: o.cle.privee, dsaEncoding: o.dsa ?? "der" }).toString("base64");
  return { "content-type": type, "content-digest": digest, "signature-date": date, signature: `sig-pp=:${sig}:`, "signature-input": `sig-pp=${params}` };
}
