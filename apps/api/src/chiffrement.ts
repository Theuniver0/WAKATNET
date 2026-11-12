// WAKATNET — chiffrement des clés marchandes (AES-256-GCM) et HMAC du numéro du payeur.
// ADR 0013 §8, §9 ; ADR 0005 §2 ; S3. Les clés de chiffrement ne sont JAMAIS en base.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const VERSION = 1;

export class CleInvalide extends Error {}

/** Clé de 32 octets en base64 (WAKATNET_CLE_MARCHANDS) ; au moins 32 octets pour le HMAC. */
export function lireCle(base64: string | undefined, nom: string, longueurExacte?: number): Buffer {
  if (!base64) throw new CleInvalide(`${nom} manquant`);
  const k = Buffer.from(base64, "base64");
  if (longueurExacte !== undefined ? k.length !== longueurExacte : k.length < 32) {
    throw new CleInvalide(`${nom} : ${longueurExacte ?? "32 octets au moins"} octets attendus en base64`);
  }
  return k;
}

/** version (1) ‖ nonce (12) ‖ chiffré ‖ étiquette (16). Données associées : identifiant du propriétaire. */
export function chiffrer(cle: Buffer, clair: Buffer, associe: string): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", cle, nonce);
  c.setAAD(Buffer.from(associe));
  const chiffre = Buffer.concat([c.update(clair), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, chiffre, c.getAuthTag()]);
}

export function dechiffrer(cle: Buffer, paquet: Buffer, associe: string): Buffer {
  if (paquet.length < 1 + 12 + 16 || paquet[0] !== VERSION) throw new CleInvalide("paquet chiffré illisible");
  const d = createDecipheriv("aes-256-gcm", cle, paquet.subarray(1, 13));
  d.setAAD(Buffer.from(associe));
  d.setAuthTag(paquet.subarray(paquet.length - 16));
  return Buffer.concat([d.update(paquet.subarray(13, paquet.length - 16)), d.final()]);
}

/** HMAC-SHA-256 du numéro (8 chiffres) : jamais un simple hachage, retrouvable par force brute. */
export function hmacNumero(cle: Buffer, numero: string): Buffer {
  return createHmac("sha256", cle).update(`numero:${numero}`).digest();
}
