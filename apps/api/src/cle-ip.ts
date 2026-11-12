// WAKATNET — clé de limitation par source (revue de sécurité M2 et M7 ; ADR 0016 §2).
// IPv4 : l'adresse. IPv6 : le /64, car un abonné en reçoit un entier et en change à volonté ; compter par
// adresse ne le limiterait pas. Une IPv4 notée en IPv6 (::ffff:a.b.c.d, socket en double pile) est ramenée
// à l'IPv4. Une valeur illisible donne « ? » : elle partage alors un seul budget, jamais un budget neuf.
import { createHmac } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

/** Ce qui est gardé en base : HMAC de la clé de source, clé WAKATNET_CLE_HMAC, renouvelé chaque jour UTC (relecture :
 *  ni IP en clair, ni lien d'un jour à l'autre). Sans clé (développement), la clé de source elle-même. */
export function cleSource(ip: string | undefined, cleHmac: Buffer | null, maintenant = new Date()): string {
  const c = cleIp(ip);
  if (cleHmac === null) return c;
  return createHmac("sha256", cleHmac).update(`source|${maintenant.toISOString().slice(0, 10)}|${c}`).digest("base64url").slice(0, 22);
}

/** L'IP telle que la base la compare à celle des routeurs (migration 0032) : IPv4 notée en IPv6 ramenée à l'IPv4,
 *  zone retirée ; null si illisible. Jamais gardée : seule sa comparaison sert. */
export function ipComparable(ip: string | undefined): string | null {
  let a = (ip ?? "").trim().toLowerCase().replace(/%.*$/, "");
  if (a.startsWith("::ffff:") && isIPv4(a.slice(7))) a = a.slice(7);
  return isIPv4(a) || isIPv6(a) ? a : null;
}

export function cleIp(ip: string | undefined): string {
  let a = (ip ?? "").trim().toLowerCase().replace(/%.*$/, "");
  if (a.startsWith("::ffff:") && isIPv4(a.slice(7))) a = a.slice(7);
  if (isIPv4(a)) return a;
  if (!isIPv6(a)) return "?";
  // Développe « :: » et une IPv4 finale, puis garde les quatre premiers groupes.
  let groupes = a.split("::").map((p) => (p === "" ? [] : p.split(":")));
  groupes = groupes.map((g) => g.flatMap((x) => (x.includes(".") ? (() => {
    const o = x.split(".").map(Number);
    return [((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)];
  })() : [x])));
  const [gauche, droite] = groupes;
  const tout = droite === undefined ? gauche : [...gauche, ...Array(8 - gauche.length - droite.length).fill("0"), ...droite];
  return `${tout.slice(0, 4).map((x) => parseInt(x, 16).toString(16)).join(":")}::/64`;
}
