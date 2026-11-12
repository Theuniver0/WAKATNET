// Aides des tests de paiement : propriétaire prêt à vendre (forfait, compte marchand mock, crédits).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { construire } from "../src/app.ts";
import { proprietaire, sql, URL_ADMIN, entetes } from "./aide.ts";

export type App = ReturnType<typeof construire>;
export type Vendeur = { tenant: string; site: string; publicId: string; plan: string; secret: string; webhook: string };

export async function vendeur(app: App, nom: string, { prix = 200, recharge = 10_000 } = {}): Promise<Vendeur> {
  const p = await proprietaire(nom);
  const [plan] = await sql<{ id: string }>(URL_ADMIN,
    "INSERT INTO app.plan (tenant_id, nom, prix_xof, uptime_limit_s) VALUES ($1, '1 heure', $2, 3600) RETURNING id::text", [p.tenant, prix]);
  // Hôte de connexion du hotspot, normalement relevé à l'enrôlement (ADR 0013 §10).
  const [s] = await sql<{ public_id: string }>(URL_ADMIN,
    "UPDATE app.site SET hotspot_hotes = '{10.5.50.1}' WHERE id = $1 RETURNING public_id", [p.site]);
  const secret = randomBytes(24).toString("base64url");
  const r = await app.inject({ method: "PUT", url: "/v1/compte-marchand", headers: entetes(p.tenant),
                               payload: { fournisseur: "mock", cles: { secret_webhook: secret } } });
  assert.equal(r.statusCode, 200, r.body);
  const webhook = /\/webhooks\/mock\/([A-Za-z0-9_-]{24})$/.exec(r.json().url_webhook)![1];
  if (recharge > 0) await sql(URL_ADMIN, "SELECT app.credits_recharger($1, $2, $3)", [p.tenant, recharge, `test-${p.tenant}-${randomBytes(4).toString("hex")}`]);
  return { tenant: p.tenant, site: p.site, publicId: s.public_id, plan: plan.id, secret, webhook };
}

export const soumission = () => randomBytes(16).toString("base64url");
export const jeton = () => randomBytes(32);

/** Numéro de test : le scénario du MockProvider est dans ses deux derniers chiffres. */
export const numero = (scenario: string) => `70${(randomBytes(2).readUInt16BE(0) % 10000).toString().padStart(4, "0")}${scenario}`;

export async function statut(reference: string): Promise<{ statut: string; voucher_id: string | null; id: string }> {
  const [p] = await sql<{ statut: string; voucher_id: string | null; id: string }>(URL_ADMIN,
    "SELECT statut, voucher_id::text, id::text FROM app.payment WHERE reference = $1", [reference]);
  return p;
}

export async function attendreStatut(reference: string, attendu: string, ms = 3000): Promise<void> {
  const fin = Date.now() + ms;
  while ((await statut(reference)).statut !== attendu) {
    if (Date.now() > fin) assert.fail(`${reference} : ${(await statut(reference)).statut}, attendu ${attendu}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export async function credits(tenant: string): Promise<bigint> {
  const [r] = await sql<{ s: string }>(URL_ADMIN, "SELECT app.credits_solde($1)::text AS s", [tenant]);
  return BigInt(r.s);
}

export async function transactionsDe(paymentId: string): Promise<number> {
  const [r] = await sql<{ n: number }>(URL_ADMIN, "SELECT count(*)::int AS n FROM ledger.transaction WHERE objet = $1", [`paiement:${paymentId}`]);
  return r.n;
}
