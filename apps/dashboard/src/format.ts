/** « 1500 » -> « 1 500 F » (espace simple, pour que les textes restent faciles à chercher). */
export function franc(n: number): string {
  const signe = n < 0 ? "-" : "";
  return `${signe}${Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} F`;
}

export function duree(s: number | null): string {
  if (s === null) return "Illimitée";
  if (s % 86400 === 0) return `${s / 86400} j`;
  if (s % 3600 === 0) return `${s / 3600} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
}

export function dateHeure(iso: string | null): string {
  if (iso === null) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("fr-FR", { timeZone: "UTC", dateStyle: "short", timeStyle: "short" });
}

/** Champ numérique libre : vide -> null, sinon entier ou NaN. */
export function entierOuNull(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  return /^\d+$/.test(t) ? Number(t) : Number.NaN;
}

export const ETATS_PAIEMENT: Record<string, string> = {
  CREATED: "Créé", PENDING: "En attente", SUCCEEDED: "Réussi", FAILED: "Échoué", EXPIRED: "Expiré", MISMATCH: "À vérifier", REFUNDED: "Remboursé",
};
