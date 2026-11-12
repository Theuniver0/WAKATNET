// WAKATNET — CSV des relevés (ADR 0014 §6) : UTF-8 avec BOM, séparateur « ; » (Excel en
// français), montants en entiers XOF, champs protégés contre l'injection de formules.
const FORMULE = /^[=+\-@\t\r]/;

export function champ(v: unknown): string {
  let s = v === null || v === undefined ? "" : typeof v === "bigint" ? v.toString() : v instanceof Date ? v.toISOString() : String(v);
  // Un nombre négatif reste un nombre ; tout autre texte commençant par = + - @ devient du texte.
  if (FORMULE.test(s) && !/^-[0-9]+$/.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csv(entete: string[], lignes: unknown[][]): Buffer {
  const texte = [entete, ...lignes].map((l) => l.map(champ).join(";")).join("\r\n") + "\r\n";
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(texte, "utf8")]);
}
