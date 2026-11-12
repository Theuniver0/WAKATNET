// Identifiant bigint reçu dans une URL, un en-tête ou un corps : décimal, sans zéro de tête,
// et au plus 2^63 − 1 (sinon PostgreSQL lèverait une erreur, servie en 500 : revue Standards).
const MOTIF = /^[1-9][0-9]{0,18}$/;
const MAX = 9223372036854775807n;

export function estIdentifiant(v: unknown): v is string {
  return typeof v === "string" && MOTIF.test(v) && BigInt(v) <= MAX;
}
