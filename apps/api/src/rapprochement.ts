// WAKATNET — rapprochement quotidien du pilote (SPEC §12 phase 6 : « rapprochement quotidien à la main » ;
// critère de sortie : écart nul). Procédure : docs/PILOTE.md §4. Relu par un second agent (règle 4) : la
// première version disait « écart nul » dans trois cas où de l'argent manquait (paiement de fin de journée
// sans encaissement, statut inconnu lu comme un échec, ligne CSV mal découpée) ; cette version les ferme.
//
// Mode A (ADR 0001) : l'argent d'une vente arrive sur le compte marchand du PROPRIÉTAIRE. Le rapprochement
// se fait par propriétaire et par jour J (UTC = heure du Burkina), entre :
//   1. nos paiements (app.payment, confirme_le) ;
//   2. le relevé de son compte marchand, qui doit COUVRIR [J − 1 jour, J + 1 jour + tolérance] (couverture
//      déclarée par l'exploitant, vérifiée) : on exporte trois jours glissants ;
//   3. le grand livre : une commission, et une seule, par paiement réussi, du montant figé, au taux en vigueur.
// Règles :
//   - un paiement réussi le jour J sans ligne au relevé est TOUJOURS un écart (la couverture le garantit) ;
//   - une ligne réussie du jour J sans paiement chez nous est TOUJOURS un écart ;
//   - une paire trouvée des deux côtés, de part et d'autre de minuit, est un décalage (expliqué, listé) ;
//   - une paire où l'encaissement précède la confirmation de plus que la tolérance (webhook perdu, repris par
//     la vérification périodique, jusqu'à 24 h : ADR 0013) est une confirmation tardive (expliquée, listée) ;
//   - un paiement remboursé (REFUNDED) confirmé le jour J est TOUJOURS à instruire, avec ou sans ligne au relevé.
// Audit de sécurité de l'outil (constats 1 à 6) : relevé vide ou réduit à l'en-tête refusé (sauf --releve-vide), ligne de
// commande stricte, débits hors paiement excessifs sous un dépôt présent, texte du relevé neutralisé dans le rapport,
// remboursements listés ; base lue par le rôle dédié wk_rapprochement (migration 0038), en lecture seule.
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { versXof } from "../../../packages/payments/src/index.ts";

export type LigneBase = { reference: string; referenceFournisseur: string | null; montant: bigint; statut: string; confirmeLe: Date | null };
/** `hors` : ligne d'un type déclaré « hors paiement » (frais, retrait du journal d'un portefeuille) : jamais rapprochée
 *  d'un paiement, jamais ignorée non plus : totalisée par type au rapport, en centimes (`centimes`, signé). */
export type LigneReleve = { reference: string; montant: bigint; le: Date; reussi: boolean; ligne: number; hors?: string; centimes?: bigint; brut?: string;
  /** Ligne hors paiement sans référence d'un type que --hors-sans-reference n'admet pas (relecture R4, I-1). */
  sansReferenceSuspecte?: boolean };
/** `ecriture` : somme des débits de commission au compte du propriétaire ; `nombre` : écritures ; `figee` : commission
 *  figée au journal d'audit de la confirmation ; `taux` : taux de l'écriture ; `tauxEnVigueur` : celui du propriétaire ;
 *  `attendue` : ledger.commission(montant, taux en vigueur, plancher en vigueur), recalculée par la base. */
export type Commission = { reference: string; nombre: number; ecriture: bigint | null; figee: bigint | null; taux: number | null;
  tauxEnVigueur: number; attendue: bigint | null };

export type Categorie = "concordant" | "decalage" | "confirmation_tardive" | "montant_different" | "doublon_releve"
  | "succes_chez_nous_echec_au_releve" | "succes_au_releve_pas_chez_nous" | "absent_du_releve" | "absent_de_la_base"
  | "grand_livre" | "taux_commission" | "reference_ambigue" | "hors_paiement_orphelin" | "hors_paiement_excessif" | "hors_paiement_sans_reference" | "rembourse";
export type Ecart = { categorie: Categorie; reference: string; detail: string };

export const EXPLIQUES: Categorie[] = ["concordant", "decalage", "confirmation_tardive"];
export const ECARTS_A_INSTRUIRE: Categorie[] = ["montant_different", "doublon_releve", "succes_chez_nous_echec_au_releve",
  "succes_au_releve_pas_chez_nous", "absent_du_releve", "absent_de_la_base", "grand_livre", "taux_commission", "reference_ambigue",
  "hors_paiement_orphelin", "hors_paiement_excessif", "hors_paiement_sans_reference", "rembourse"];

export type Couverture = { du: Date; au: Date };
export type Resultat = {
  jour: string; lignes: Ecart[]; ecartNul: boolean;
  totaux: { base_xof: bigint; releve_xof: bigint; commissions_xof: bigint; paiements: number; encaissements: number; taux: number[];
            hors: { type: string; nombre: number; centimes: bigint }[] };
};

const JOUR_MS = 86_400_000;
/** Délai maximal entre l'encaissement et notre confirmation (vérification périodique pendant 24 h, ADR 0013). */
const RETARD_MAX_MS = JOUR_MS;
/** Audit 3 : les débits hors paiement (frais) portés par la référence d'un dépôt ne dépassent pas 10 % de son montant.
 *  Les frais de pawaPay d'un dépôt (« pass through » et « PawaPay fees ») sont de quelques pour cent ; un remboursement,
 *  ou tout débit du montant entier, déclaré à tort dans --hors-paiement dépasse ce seuil. En pour cent, entier (A1). */
export const SEUIL_HORS_PAIEMENT_PCT = 10n;

export function bornes(jour: string, toleranceS: number) {
  const debut = Date.parse(`${jour}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(jour) || !Number.isFinite(debut)) throw new Error(`jour invalide : ${jour}`);
  return { debut, fin: debut + JOUR_MS, couvertureMin: debut - JOUR_MS, couvertureMax: debut + JOUR_MS + toleranceS * 1000 };
}

/** La couverture déclarée du relevé doit contenir [J − 1 jour, J + 1 jour + tolérance]. */
export function verifierCouverture(jour: string, c: Couverture, toleranceS = 600): void {
  const b = bornes(jour, toleranceS);
  if (c.du.getTime() > b.couvertureMin || c.au.getTime() < b.couvertureMax) {
    throw new Error(`relevé insuffisant : il doit couvrir du ${new Date(b.couvertureMin).toISOString()} au ${new Date(b.couvertureMax).toISOString()} `
      + `(déclaré : ${c.du.toISOString()} → ${c.au.toISOString()}). Exporter trois jours glissants, après ${new Date(b.couvertureMax).toISOString()}.`);
  }
}

export function rapprocher(jour: string, base: LigneBase[], releveComplet: LigneReleve[], commissions: Commission[], toleranceS = 600): Resultat {
  const { debut, fin } = bornes(jour, toleranceS);
  const tol = toleranceS * 1000;
  const dansJour = (t: number) => t >= debut && t < fin;
  // Lignes hors paiement (frais, retraits) : hors du rapprochement ligne à ligne, totalisées par type pour le jour J.
  const releve = releveComplet.filter((r) => r.hors === undefined);
  const parType = new Map<string, { type: string; nombre: number; centimes: bigint }>();
  const ecartsHors: Ecart[] = [];
  // Relecture I-b : une ligne hors paiement qui porte une référence (frais) doit porter celle d'un encaissement du relevé ;
  // sinon (remboursement déclaré par erreur, ligne mal typée) elle est à instruire. M-1 : une ligne identique en double
  // (exports qui se chevauchent) est à instruire, et n'est pas comptée deux fois.
  const encaisses = new Set(releve.filter((r) => r.reussi).map((r) => r.reference));
  const vues = new Set<string>();
  const debitsParRef = new Map<string, { centimes: bigint; lignes: number[]; types: Set<string> }>();
  for (const h of releveComplet) {
    if (h.hors === undefined || !dansJour(h.le.getTime())) continue;
    const cle = `${h.hors}\u0000${h.brut ?? `${h.reference}|${h.centimes}|${h.le.toISOString()}`}`;
    if (vues.has(cle)) {
      ecartsHors.push({ categorie: "doublon_releve", reference: h.hors, detail: `ligne ${h.ligne} : ligne « ${h.hors} » identique à une autre (exports qui se chevauchent ?) ; comptée une fois` });
      continue;
    }
    vues.add(cle);
    if (h.reference && !encaisses.has(h.reference)) {
      ecartsHors.push({ categorie: "hors_paiement_orphelin", reference: h.reference,
        detail: `ligne ${h.ligne} : « ${h.hors} » de ${formatCentimes(h.centimes ?? 0n)} F sous une référence sans encaissement au relevé (remboursement ? type mal déclaré ?)` });
    } else if (!h.reference && h.sansReferenceSuspecte) {
      // Relecture R4 (I-1) : un remboursement ou un ajustement débiteur SANS référence sortirait l'argent du contrôle.
      ecartsHors.push({ categorie: "hors_paiement_sans_reference", reference: h.hors,
        detail: `ligne ${h.ligne} : « ${h.hors} » de ${formatCentimes(h.centimes ?? 0n)} F sans référence : rattacher à un paiement, ou déclarer le type par --hors-sans-reference s'il ne touche aucun encaissement` });
    } else if (h.reference) {
      // Audit 3 : sous la référence d'un dépôt PRÉSENT, les débits hors paiement sont cumulés, puis comparés à son montant.
      const d = debitsParRef.get(h.reference) ?? { centimes: 0n, lignes: [] as number[], types: new Set<string>() };
      d.centimes += h.centimes ?? 0n; d.lignes.push(h.ligne); d.types.add(h.hors);
      debitsParRef.set(h.reference, d);
    }
    const t = parType.get(h.hors) ?? { type: h.hors, nombre: 0, centimes: 0n };
    t.nombre++; t.centimes += h.centimes ?? 0n;
    parType.set(h.hors, t);
  }
  for (const [ref, d] of debitsParRef) {
    const debit = -d.centimes;                                           // centimes ≤ 0 : lireReleve refuse un crédit
    const encaisse = releve.filter((r) => r.reussi && r.reference === ref).reduce((n, r) => n + r.montant, 0n);
    // debit (centimes) > SEUIL % de encaisse (XOF) ⇔ debit × 100 > SEUIL × encaisse × 100 : en entiers.
    if (debit * 100n > SEUIL_HORS_PAIEMENT_PCT * encaisse * 100n) {
      ecartsHors.push({ categorie: "hors_paiement_excessif", reference: ref,
        detail: `lignes ${d.lignes.join(", ")} : ${formatCentimes(-debit)} F hors paiement (${[...d.types].sort().join(", ")}) sous un encaissement de ${encaisse} F, `
          + `au-delà de ${SEUIL_HORS_PAIEMENT_PCT} % (remboursement déclaré dans --hors-paiement ? frais anormaux ?)` });
    }
  }
  const lignes: Ecart[] = [...ecartsHors];

  // Index : notre référence et celle du fournisseur. Une clé portée par deux paiements est ambiguë : signalée.
  const parRef = new Map<string, LigneBase>();
  const ambigues = new Set<string>();
  for (const b of base) {
    for (const k of [b.reference, b.referenceFournisseur]) {
      if (!k) continue;
      const deja = parRef.get(k);
      if (deja && deja !== b) ambigues.add(k); else parRef.set(k, b);
    }
  }
  for (const k of ambigues) lignes.push({ categorie: "reference_ambigue", reference: k, detail: "référence portée par plusieurs paiements" });

  // Paires : chaque ligne du relevé est rattachée à au plus un paiement ; un paiement à au plus une ligne.
  const ligneDe = new Map<LigneBase, LigneReleve>();
  for (const r of releve) {
    if (ambigues.has(r.reference)) continue;
    const b = parRef.get(r.reference);
    if (!b) {
      if (r.reussi && dansJour(r.le.getTime())) lignes.push({ categorie: "absent_de_la_base", reference: r.reference,
        detail: `ligne ${r.ligne} du relevé : ${r.montant} F encaissés le ${r.le.toISOString()}, aucun paiement de ce propriétaire ne porte cette référence (client payé sans ticket ?)` });
      continue;
    }
    const deja = ligneDe.get(b);
    if (deja) {
      if (dansJour(r.le.getTime()) || dansJour(deja.le.getTime()) || (b.confirmeLe && dansJour(b.confirmeLe.getTime()))) {
        lignes.push({ categorie: "doublon_releve", reference: b.reference, detail: `lignes ${deja.ligne} et ${r.ligne} du relevé portent la même référence` });
      }
      continue;
    }
    ligneDe.set(b, r);
  }

  for (const b of base) {
    const r = ligneDe.get(b);
    // Audit 6 : un remboursement confirmé le jour J est toujours à instruire (aucun n'est encore codé : garde).
    if (b.statut === "REFUNDED" && b.confirmeLe && dansJour(b.confirmeLe.getTime())) {
      lignes.push({ categorie: "rembourse", reference: b.reference,
        detail: `${b.montant} F : paiement confirmé le ${b.confirmeLe.toISOString()} puis remboursé ; `
          + (r ? `ligne ${r.ligne} du relevé : ${r.montant} F ${r.reussi ? "encaissés" : "en échec"}` : "aucune ligne au relevé")
          + " (vérifier le remboursement au compte marchand et le sort du ticket)" });
      continue;
    }
    const baseOk = b.statut === "SUCCEEDED" && b.confirmeLe !== null;
    const tBase = b.confirmeLe?.getTime() ?? NaN;
    // Le jour d'une paire est celui de NOTRE confirmation ; sans confirmation, celui de la ligne du relevé.
    const duJour = baseOk ? dansJour(tBase) : r !== undefined && dansJour(r.le.getTime());
    if (!duJour) {
      // Relecture N1 et N4 : un encaissement du jour J rattaché à un paiement confirmé un autre jour. Expliqué seulement
      // s'il est la contrepartie de ce paiement (même montant, minuit ou vérification périodique) : il est alors listé
      // ici aussi, pour que la différence des totaux de J s'explique ligne par ligne. Sinon : second encaissement.
      if (r && r.reussi && dansJour(r.le.getTime())) {
        const ecart = tBase - r.le.getTime();
        const contrepartie = Math.abs(ecart) <= tol || (ecart > 0 && ecart <= RETARD_MAX_MS);
        if (contrepartie && r.montant === b.montant) {
          lignes.push({ categorie: Math.abs(ecart) <= tol ? "decalage" : "confirmation_tardive", reference: b.reference,
            detail: `${r.montant} F encaissés le ${r.le.toISOString()} (ligne ${r.ligne}), ticket confirmé le ${b.confirmeLe!.toISOString()} : compté au rapprochement de ce jour-là` });
        } else if (contrepartie) {
          lignes.push({ categorie: "montant_different", reference: b.reference, detail: `ligne ${r.ligne} : ${r.montant} F au relevé, ${b.montant} F chez nous` });
        } else {
          lignes.push({ categorie: "doublon_releve", reference: b.reference,
            detail: `ligne ${r.ligne} : ${r.montant} F encaissés le ${r.le.toISOString()} sous la référence d'un paiement confirmé le ${b.confirmeLe!.toISOString()} (second encaissement, client payé sans ticket ?)` });
        }
      }
      continue;
    }
    if (!r) {
      if (baseOk) lignes.push({ categorie: "absent_du_releve", reference: b.reference,
        detail: `${b.montant} F : ticket délivré (confirmé le ${b.confirmeLe!.toISOString()}), aucune ligne au relevé qui couvre pourtant la période` });
      continue;
    }
    if (r.reussi && !baseOk) {
      lignes.push({ categorie: "succes_au_releve_pas_chez_nous", reference: b.reference,
        detail: `ligne ${r.ligne} : ${r.montant} F encaissés, paiement ${b.statut} chez nous (client payé sans ticket ?)` });
    } else if (!r.reussi && baseOk) {
      lignes.push({ categorie: "succes_chez_nous_echec_au_releve", reference: b.reference,
        detail: `ligne ${r.ligne} : échec au relevé, ticket délivré chez nous (${b.montant} F)` });
    } else if (!r.reussi) {
      continue;                                                         // échec des deux côtés
    } else if (r.montant !== b.montant) {
      lignes.push({ categorie: "montant_different", reference: b.reference, detail: `ligne ${r.ligne} : ${r.montant} F au relevé, ${b.montant} F chez nous` });
    } else {
      const ecart = tBase - r.le.getTime();                             // > 0 : confirmé après l'encaissement
      if (Math.abs(ecart) <= tol) {
        lignes.push(dansJour(r.le.getTime())
          ? { categorie: "concordant", reference: b.reference, detail: `${b.montant} F` }
          : { categorie: "decalage", reference: b.reference, detail: `${b.montant} F de part et d'autre de minuit (relevé ${r.le.toISOString()}, chez nous ${b.confirmeLe!.toISOString()})` });
      } else if (ecart > 0 && ecart <= RETARD_MAX_MS) {
        lignes.push({ categorie: "confirmation_tardive", reference: b.reference,
          detail: `${b.montant} F encaissés le ${r.le.toISOString()}, confirmés chez nous ${Math.round(ecart / 60000)} min plus tard (vérification périodique)` });
      } else {
        lignes.push({ categorie: "absent_du_releve", reference: b.reference,
          detail: `même référence à des dates incohérentes (relevé ${r.le.toISOString()}, chez nous ${b.confirmeLe!.toISOString()})` });
      }
    }
  }

  // Grand livre : une écriture de commission au plus, égale à la valeur figée à la confirmation, au taux en vigueur.
  // Une commission nulle n'est pas écrite (paiement_transition : IF v_comm > 0) : conforme si la valeur figée est 0.
  const commParRef = new Map(commissions.map((c) => [c.reference, c]));
  let commissionsXof = 0n;
  const taux = new Set<number>();
  for (const b of base) {
    if (b.statut !== "SUCCEEDED" || !b.confirmeLe || !dansJour(b.confirmeLe.getTime())) continue;
    const c = commParRef.get(b.reference);
    let defaut: string | null = null;
    if (!c || c.figee === null) defaut = "aucune trace de la commission (ni écriture, ni valeur figée à la confirmation)";
    else if (c.nombre === 0 && c.figee !== 0n) defaut = `aucune commission au grand livre (${c.figee} F figés à la confirmation)`;
    else if (c.nombre > 1) defaut = `${c.nombre} commissions au grand livre`;
    else if (c.nombre === 1 && c.ecriture !== c.figee) defaut = `commission de ${c.ecriture ?? "?"} F au grand livre, ${c.figee} F figés à la confirmation`;
    if (defaut) lignes.push({ categorie: "grand_livre", reference: b.reference, detail: defaut });
    // Relecture N3 : la valeur figée est recalculée au taux et au plancher en vigueur, commission nulle comprise.
    else if (c!.attendue === null || c!.figee !== c!.attendue) lignes.push({ categorie: "taux_commission", reference: b.reference,
      detail: `${c!.figee} F figés à la confirmation, ${c!.attendue ?? "?"} F attendus au taux et au plancher du propriétaire (changement de réglage ? voir admin_reglage)` });
    if (c?.ecriture) commissionsXof += c.ecriture;
    if (c && c.taux !== null) {
      taux.add(c.taux);
      const dejaSignale = lignes.some((l) => l.categorie === "taux_commission" && l.reference === b.reference);
      if (c.taux !== c.tauxEnVigueur && !dejaSignale) lignes.push({ categorie: "taux_commission", reference: b.reference,
        detail: `taux appliqué ${c.taux} bps, taux du propriétaire ${c.tauxEnVigueur} bps (changement de réglage dans la journée ? voir le journal d'audit admin_reglage)` });
    }
  }
  const succesDuJour = base.filter((b) => b.statut === "SUCCEEDED" && b.confirmeLe && dansJour(b.confirmeLe.getTime()));
  const encaissementsDuJour = releve.filter((r) => r.reussi && dansJour(r.le.getTime()));
  return {
    jour, lignes, ecartNul: !lignes.some((l) => ECARTS_A_INSTRUIRE.includes(l.categorie)),
    totaux: { base_xof: succesDuJour.reduce((n, b) => n + b.montant, 0n), releve_xof: encaissementsDuJour.reduce((n, r) => n + r.montant, 0n),
      commissions_xof: commissionsXof, paiements: succesDuJour.length, encaissements: encaissementsDuJour.length, taux: [...taux].sort((a, b) => a - b),
      hors: [...parType.values()].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0)) },
  };
}

// ------------------------------------------------------------------ relevé CSV

/** `echec` peut être vide (le journal d'un portefeuille ne porte que des mouvements réalisés) ; `reussi` jamais.
 *  `hors` : types de ligne à totaliser hors paiement (frais, retraits) ; tout autre type reste une erreur. */
/** `horsSansReference` : parmi `hors`, les types admis SANS référence (retraits vers la banque) ; défaut : Withdrawal. */
export type Colonnes = { reference: string; montant: string; date: string; statut: string; reussi: string[]; echec: string[]; hors?: string[];
  horsSansReference?: string[]; sep?: string };

/** Montant d'un encaissement : XOF entier ; « 200.00 » vaut 200 (format des agrégateurs) ; décimale non nulle refusée. */
function montantPaiement(v: string): bigint {
  const m = /^(0|[1-9][0-9]{0,14})(?:\.0+)?$/.exec(v);
  if (!m) throw new TypeError(`montant XOF invalide : ${JSON.stringify(v)} (entier positif, décimales nulles seulement)`);
  return BigInt(versXof(m[1]));
}

/** Montant d'une ligne hors paiement (frais : signés, parfois fractionnaires) : en centimes, deux décimales au plus. */
function centimes(v: string): bigint {
  const m = /^(-?)(0|[1-9][0-9]{0,14})(?:\.([0-9]{1,2}))?$/.exec(v);
  if (!m) throw new TypeError(`montant invalide : ${JSON.stringify(v)} (signé, deux décimales au plus)`);
  const c = BigInt(m[2]) * 100n + BigInt((m[3] ?? "").padEnd(2, "0") || "0");
  return m[1] === "-" ? -c : c;
}

export function formatCentimes(c: bigint): string {
  const a = c < 0n ? -c : c;
  return `${c < 0n ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}

/** Découpe une ligne CSV (guillemets doublés). Un guillemet non refermé est une erreur (saut de ligne dans un champ). */
function champs(l: string, sep: string, ligne: number): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) {
      if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { out.push(cur); cur = ""; } else cur += c;
  }
  if (q) throw new Error(`ligne ${ligne} : guillemet non refermé (saut de ligne dans un champ ?)`);
  out.push(cur);
  return out.map((x) => x.trim());
}

/** Dates ISO 8601 seulement (« 2026-11-20T10:00:00Z », « 2026-11-20 10:00 », « +00:00 ») ; sans fuseau : UTC
 *  (heure du Burkina), jamais le fuseau de la machine. jj/mm/aaaa est refusé (ambigu). */
export function lireDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) return null;
  // Relecture N5 : une date impossible (30 février, 24:00, 31 d'un mois de 30 jours) est refusée, pas reportée.
  const [a, mo, j, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "00"].map(Number);
  const v = new Date(Date.UTC(a, mo - 1, j, h, mi, se));
  if (v.getUTCFullYear() !== a || v.getUTCMonth() !== mo - 1 || v.getUTCDate() !== j || v.getUTCHours() !== h
    || v.getUTCMinutes() !== mi || v.getUTCSeconds() !== se) return null;
  const fuseau = m[8] ?? "Z";
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${m[7] ?? ""}${fuseau === "Z" ? "Z" : fuseau.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2")}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Lit le relevé. TOUTE anomalie est une erreur (code 2), jamais une ligne ignorée : fichier vide, fichier réduit à
 *  l'en-tête (sauf `videPermis`, option --releve-vide), nombre de champs, statut hors des listes (--reussi, --echec,
 *  --hors-paiement), montant d'encaissement non entier (décimales nulles admises), ligne hors paiement créditrice, date
 *  non ISO, ligne hors de la fenêtre [J − 2, J + 3[ (mauvais fichier). Fins de ligne : \r\n, \n ou \r seul (audit 1). */
export function lireReleve(texte: string, col: Colonnes, jour?: string, opts: { videPermis?: boolean } = {}): LigneReleve[] {
  const lignesTexte = texte.replace(/^﻿/, "").split(/\r\n|\r|\n/).filter((l) => l.trim() !== "");
  if (lignesTexte.length === 0) throw new Error("relevé vide, sans en-tête (export interrompu ?) : même un jour sans mouvement, l'export porte son en-tête");
  const sep = col.sep ?? ((lignesTexte[0].match(/;/g)?.length ?? 0) >= (lignesTexte[0].match(/,/g)?.length ?? 0) ? ";" : ",");
  const entete = champs(lignesTexte[0], sep, 1);
  const idx = (n: string) => { const i = entete.indexOf(n); if (i < 0) throw new Error(`colonne « ${n} » absente du relevé (colonnes : ${entete.join(", ")})`); return i; };
  const [iRef, iMontant, iDate, iStatut] = [idx(col.reference), idx(col.montant), idx(col.date), idx(col.statut)];
  // Relecture N2 : une valeur vide (« FAILED, ») ferait d'un statut vide un échec, donc une ligne ignorée.
  const liste = (l: string[], nom: string, videPermise = false) => {
    const v = l.map((s) => s.trim().toUpperCase());
    if ((v.length === 0 && !videPermise) || v.some((s) => s === "")) throw new Error(`--${nom} : liste de statuts sans valeur vide`);
    return new Set(v);
  };
  const reussi = liste(col.reussi, "reussi"), echec = liste(col.echec, "echec", true), hors = liste(col.hors ?? [], "hors-paiement", true);
  const sansRef = liste(col.horsSansReference ?? ["Withdrawal"], "hors-sans-reference", true);
  for (const t of sansRef) if (!hors.has(t) && col.horsSansReference !== undefined) throw new Error(`--hors-sans-reference : « ${t} » doit aussi figurer dans --hors-paiement`);
  for (const s of reussi) if (echec.has(s)) throw new Error(`statut « ${s} » à la fois réussi et en échec`);
  for (const s of hors) if (reussi.has(s) || echec.has(s)) throw new Error(`statut « ${s} » à la fois ${reussi.has(s) ? "réussi" : "en échec"} et hors paiement`);
  if (lignesTexte.length === 1 && !opts.videPermis) {
    throw new Error("aucune ligne de données (fichier réduit à l'en-tête) : export incomplet ? Un jour réellement sans mouvement se déclare par --releve-vide");
  }
  const fenetre = jour ? [Date.parse(`${jour}T00:00:00Z`) - 2 * JOUR_MS, Date.parse(`${jour}T00:00:00Z`) + 3 * JOUR_MS] : null;
  return lignesTexte.slice(1).map((l, k) => {
    const ligne = k + 2, c = champs(l, sep, ligne);
    if (c.length !== entete.length) throw new Error(`ligne ${ligne} : ${c.length} champs, ${entete.length} attendus (séparateur « ${sep} » ; montant à séparateur de milliers non cité ?)`);
    const le = lireDate(c[iDate]);
    if (!le) throw new Error(`ligne ${ligne} : date « ${c[iDate]} » refusée (ISO 8601 : AAAA-MM-JJ HH:MM[:SS][Z|±HH:MM])`);
    if (fenetre && (le.getTime() < fenetre[0] || le.getTime() >= fenetre[1])) throw new Error(`ligne ${ligne} : date ${le.toISOString()} hors de la fenêtre du rapprochement (mauvais fichier ?)`);
    const statut = c[iStatut].toUpperCase();
    if (!statut) throw new Error(`ligne ${ligne} : statut vide`);
    const reference = c[iRef];
    if (hors.has(statut)) {
      // Frais ou retrait : la référence peut manquer (retrait), le montant être signé et fractionnaire.
      let ct: bigint;
      try { ct = centimes(c[iMontant]); } catch (e) { throw new Error(`ligne ${ligne} : montant « ${c[iMontant]} » refusé (${(e as Error).message})`); }
      // Relecture I-a : frais et retraits DÉBITENT le portefeuille ; un crédit hors paiement sortirait de l'argent encaissé
      // du rapprochement sans signal. Une recharge ou un ajustement créditeur s'instruit à la main (PILOTE.md §4).
      if (ct > 0n) throw new Error(`ligne ${ligne} : ligne hors paiement « ${c[iStatut]} » créditrice (+${formatCentimes(ct)} F) : un crédit sur le compte s'instruit à la main, --hors-paiement ne couvre que des débits`);
      return { reference, montant: 0n, le, reussi: false, ligne, hors: statut, centimes: ct, brut: l.trim(),
               ...(!reference && !sansRef.has(statut) ? { sansReferenceSuspecte: true } : {}) };
    }
    if (!reussi.has(statut) && !echec.has(statut)) throw new Error(`ligne ${ligne} : statut « ${c[iStatut]} » ni réussi ni en échec ni hors paiement (--reussi, --echec, --hors-paiement)`);
    if (!reference) throw new Error(`ligne ${ligne} : référence vide`);
    let montant: bigint;
    try { montant = montantPaiement(c[iMontant]); } catch (e) { throw new Error(`ligne ${ligne} : montant « ${c[iMontant]} » refusé (${(e as Error).message})`); }
    return { reference, montant, le, reussi: reussi.has(statut), ligne };
  });
}

/** Audit 1 : sur l'ensemble des fichiers, zéro ligne lue est une erreur, sauf relevé déclaré vide par l'exploitant
 *  (--releve-vide) ; déclaré vide, il ne doit porter aucune ligne du jour J (paiement ou hors paiement). */
export function verifierVolume(jour: string, releve: LigneReleve[], releveVide: boolean): void {
  const { debut, fin } = bornes(jour, 0);
  if (!releveVide && releve.length === 0) {
    throw new Error("aucune ligne lue sur l'ensemble des relevés : export vide ou incomplet ? Un jour réellement sans mouvement se déclare par --releve-vide");
  }
  const duJour = releve.filter((r) => r.le.getTime() >= debut && r.le.getTime() < fin).length;
  if (releveVide && duJour > 0) throw new Error(`--releve-vide : le relevé porte ${duJour} ligne(s) du ${jour} ; il n'est pas vide (retirer l'option)`);
}

// ------------------------------------------------------------------ rapport

/** Audit 5 : tout texte venu du relevé (référence, type de ligne, détail) est neutralisé avant d'entrer dans le Markdown :
 *  ni bloc de code refermé (`), ni HTML ou commentaire (<, >), ni cellule de tableau (|), ni caractère de contrôle
 *  (séquences ANSI, retour à la ligne, inversion bidirectionnelle), rendu visible en \uXXXX. */
const CONTROLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
export function sansControle(s: string): string {
  return s.replace(CONTROLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
// Relecture R4 (M-4) : [ et ] aussi, sinon une référence « [x](https://…) » ou « ![](…) » devient un lien ou une image.
const ENTITES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "`": "&#96;", "|": "&#124;", "[": "&#91;", "]": "&#93;" };
export function texteMd(s: string): string {
  return sansControle(s.replace(/[&<>`|[\]]/g, (c) => ENTITES[c]));
}

export function rapportMarkdown(r: Resultat, proprietaire: string, couverture: Couverture, opts: { releveVide?: boolean } = {}): string {
  const t = r.totaux;
  const parCat = (c: Categorie) => r.lignes.filter((l) => l.categorie === c);
  const out = [`# Rapprochement du ${r.jour} — propriétaire ${texteMd(proprietaire)} — ${r.ecartNul ? "ÉCART NUL" : "ÉCARTS À INSTRUIRE"}`, "",
    ...(opts.releveVide ? [`> **Attention** : relevé déclaré vide par l'exploitant (--releve-vide) : aucun mouvement au compte marchand le ${r.jour}, `
      + "selon sa déclaration. À noter au journal du pilote.", ""] : []),
    `Relevé couvrant du ${couverture.du.toISOString()} au ${couverture.au.toISOString()}.`, "",
    "| | Nombre | Montant |", "|---|---|---|",
    `| Paiements réussis chez nous (confirmés le ${r.jour}) | ${t.paiements} | ${t.base_xof} F |`,
    `| Encaissements au relevé (le ${r.jour}) | ${t.encaissements} | ${t.releve_xof} F |`,
    `| Différence (chez nous − relevé) | | ${t.base_xof - t.releve_xof} F |`,
    `| Commissions au grand livre | | ${t.commissions_xof} F |`,
    `| Taux appliqués | | ${t.taux.length ? t.taux.map((x) => `${x} bps`).join(", ") : "—"} |`, ""];
  if (t.base_xof !== t.releve_xof) out.push("La différence des totaux doit s'expliquer, ligne par ligne, par les décalages et confirmations tardives ci-dessous.", "");
  for (const c of [...ECARTS_A_INSTRUIRE, "decalage", "confirmation_tardive"] as Categorie[]) {
    const l = parCat(c);
    if (l.length === 0) continue;
    out.push(`## ${c} (${l.length})${EXPLIQUES.includes(c) ? " — expliqué" : " — À INSTRUIRE"}`, "");
    for (const x of l) out.push(`- « ${texteMd(x.reference)} » : ${texteMd(x.detail)}`);
    out.push("");
  }
  if (t.hors.length) {
    out.push(`## Lignes hors paiement du ${r.jour} (totalisées, ni rapprochées ni comptées comme écarts)`, "",
      "Frais et retraits déclarés par `--hors-paiement`. Tout autre type de ligne arrête l'outil (code 2).", "",
      "| Type | Nombre | Montant |", "|---|---|---|", ...t.hors.map((h) => `| ${texteMd(h.type)} | ${h.nombre} | ${formatCentimes(h.centimes)} F |`), "");
  }
  out.push(`Concordants : ${parCat("concordant").length}.`);
  return out.join("\n") + "\n";
}

// ------------------------------------------------------------------ point d'entrée

const AVEC_VALEUR = new Set(["proprietaire", "jour", "releve", "releve-du", "releve-au", "col-reference", "col-montant", "col-date",
  "col-statut", "reussi", "echec", "hors-paiement", "hors-sans-reference", "sep"]);
const DRAPEAUX = new Set(["releve-vide"]);
const REPETABLES = new Set(["releve"]);
export type Arguments = { proprietaire: string; jour: string; couverture: Couverture; fichiers: string[]; col: Colonnes; releveVide: boolean };

/** Audit 2 : ligne de commande stricte. Tout argument positionnel (« --releve a.csv b.csv », motif développé par le shell),
 *  toute option inconnue ou répétée (sauf --releve), toute option sans valeur est une ERREUR, jamais ignorée. */
export function lireArguments(args: string[]): Arguments {
  const v = new Map<string, string[]>();
  const drapeaux = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      throw new Error(`argument inattendu « ${a} » : un fichier par --releve (« --releve a.csv --releve b.csv »), jamais un motif développé par le shell`);
    }
    const nom = a.slice(2);
    if (DRAPEAUX.has(nom)) {
      if (drapeaux.has(nom)) throw new Error(`${a} donnée plus d'une fois`);
      drapeaux.add(nom);
      continue;
    }
    if (!AVEC_VALEUR.has(nom)) throw new Error(`option inconnue « ${a} » (options : ${[...AVEC_VALEUR, ...DRAPEAUX].map((o) => `--${o}`).join(", ")})`);
    const valeur = args[i + 1];
    if (valeur === undefined || valeur.startsWith("--")) throw new Error(`${a} : valeur manquante`);
    if (v.has(nom) && !REPETABLES.has(nom)) throw new Error(`${a} donnée plus d'une fois`);
    v.set(nom, [...(v.get(nom) ?? []), valeur]);
    i++;
  }
  const une = (nom: string, defaut?: string) => {
    const x = v.get(nom)?.[0] ?? defaut;
    if (x === undefined) throw new Error(`option --${nom} manquante`);
    return x;
  };
  const proprietaire = une("proprietaire"), jour = une("jour");
  if (!/^\d+$/.test(proprietaire)) throw new Error("--proprietaire : identifiant entier");
  bornes(jour, 0);
  const du = lireDate(une("releve-du")), au = lireDate(une("releve-au"));
  if (!du || !au) throw new Error("--releve-du et --releve-au : dates ISO 8601");
  const fichiers = v.get("releve") ?? [];
  if (fichiers.length === 0) throw new Error("--releve : au moins un fichier");
  const col: Colonnes = { reference: une("col-reference", "reference"), montant: une("col-montant", "montant"),
    date: une("col-date", "date"), statut: une("col-statut", "statut"),
    reussi: une("reussi").split(","),
    // Facultatifs : un journal de portefeuille (pawaPay) n'a aucune ligne d'échec, mais des frais et des retraits.
    echec: v.has("echec") ? une("echec").split(",") : [],
    hors: v.has("hors-paiement") ? une("hors-paiement").split(",") : [],
    ...(v.has("hors-sans-reference") ? { horsSansReference: une("hors-sans-reference").split(",") } : {}),
    ...(v.has("sep") ? { sep: une("sep") } : {}) };
  return { proprietaire, jour, couverture: { du, au }, fichiers, col, releveVide: drapeaux.has("releve-vide") };
}

// pathToFileURL : un chemin avec espace ou accent ne doit pas faire sortir l'outil en silence avec le code 0.
// realpathSync : lancé par un lien symbolique, l'outil doit tourner aussi.
const lanceDirectement = () => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } };
if (process.argv[1] && lanceDirectement()) {
  // Lancé à la main sur le nœud primaire, chaque matin, pour la veille (docs/PILOTE.md §4) :
  //   node src/rapprochement.ts --proprietaire 1 --jour 2026-11-20 \
  //     --releve releve-19.csv --releve releve-20.csv --releve releve-21.csv \
  //     --releve-du 2026-11-19T00:00:00Z --releve-au 2026-11-21T08:00:00Z \
  //     --col-reference reference --col-montant montant --col-date date --col-statut statut \
  //     --reussi SUCCESS --echec FAILED,CANCELLED
  //   Relevé pawaPay (journal du portefeuille, sans échec) : --reussi Deposit, sans --echec, et
  //     --hors-paiement "Deposit pass through fees,Deposit PawaPay fees,Withdrawal" (docs/PILOTE.md §4).
  //   Jour réellement sans mouvement (fichiers réduits à l'en-tête) : --releve-vide, noté en tête du rapport.
  // Base en LECTURE SEULE, rôle wk_rapprochement (migration 0038) : WAKATNET_RAPPROCHEMENT_DATABASE_URL, jamais en argument.
  // Sortie : rapport Markdown. Code : 0 écart nul, 1 écarts à instruire, 2 entrée invalide (relevé insuffisant ou vide,
  // ligne illisible, argument inattendu…).
  try {
    const { proprietaire, jour, couverture, fichiers, col, releveVide } = lireArguments(process.argv.slice(2));
    verifierCouverture(jour, couverture);
    const releve = fichiers.flatMap((f) => {
      try { return lireReleve(readFileSync(f, "utf8"), col, jour, { videPermis: releveVide }); } catch (e) { throw new Error(`${f} : ${(e as Error).message}`); }
    });
    verifierVolume(jour, releve, releveVide);
    const url = process.env.WAKATNET_RAPPROCHEMENT_DATABASE_URL;
    if (!url) throw new Error("WAKATNET_RAPPROCHEMENT_DATABASE_URL manquant (adresse du rôle wk_rapprochement, docs/PILOTE.md §4)");
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      // Bornes du jour en UTC quel que soit le fuseau de la session (heure du Burkina).
      await c.query("SET LOCAL TIME ZONE 'UTC'");
      const refs = releve.filter((r) => r.hors === undefined).map((r) => r.reference);
      // Deux fonctions de lecture du propriétaire des tables (migration 0038) : wk_rapprochement n'a aucun droit sur une
      // table ni sur le schéma ledger. Elles rendent ce que lisaient les deux requêtes de l'outil, à l'identique.
      const { rows: base } = await c.query<{ reference: string; reference_fournisseur: string | null; montant: string; statut: string; confirme_le: Date | null }>(
        `SELECT reference, reference_fournisseur, montant::text, statut, confirme_le
           FROM app.rapprochement_paiements($1::bigint, $2::date, $3::text[])`, [proprietaire, jour, refs]);
      const { rows: comm } = await c.query<{ reference: string; nombre: number; ecriture: string | null; figee: string | null; taux: number | null; taux_en_vigueur: number; attendue: string | null }>(
        `SELECT reference, nombre, ecriture::text, figee::text, taux, taux_en_vigueur, attendue::text
           FROM app.rapprochement_commissions($1::bigint, $2::date)`, [proprietaire, jour]);
      await c.query("COMMIT");
      const r = rapprocher(jour, base.map((b) => ({ reference: b.reference, referenceFournisseur: b.reference_fournisseur, montant: BigInt(b.montant),
          statut: b.statut, confirmeLe: b.confirme_le })), releve,
        comm.map((x) => ({ reference: x.reference, nombre: x.nombre, ecriture: x.ecriture === null ? null : BigInt(x.ecriture),
          figee: x.figee === null ? null : BigInt(x.figee), taux: x.taux, tauxEnVigueur: x.taux_en_vigueur,
          attendue: x.attendue === null ? null : BigInt(x.attendue) })));
      process.stdout.write(rapportMarkdown(r, proprietaire, couverture, { releveVide }));
      process.exitCode = r.ecartNul ? 0 : 1;
    } finally {
      await c.end();
    }
  } catch (e) {
    // Le message peut citer le relevé ou un argument : aucun caractère de contrôle (séquence ANSI) jusqu'au terminal.
    console.error(`rapprochement : ${sansControle((e as Error).message)}`);
    process.exitCode = 2;
  }
}
