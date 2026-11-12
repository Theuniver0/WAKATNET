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
//     la vérification périodique, jusqu'à 24 h : ADR 0013) est une confirmation tardive (expliquée, listée).
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { versXof } from "../../../packages/payments/src/index.ts";

export type LigneBase = { reference: string; referenceFournisseur: string | null; montant: bigint; statut: string; confirmeLe: Date | null };
export type LigneReleve = { reference: string; montant: bigint; le: Date; reussi: boolean; ligne: number };
/** `ecriture` : somme des débits de commission au compte du propriétaire ; `nombre` : écritures ; `figee` : commission
 *  figée au journal d'audit de la confirmation ; `taux` : taux de l'écriture ; `tauxEnVigueur` : celui du propriétaire ;
 *  `attendue` : ledger.commission(montant, taux en vigueur, plancher en vigueur), recalculée par la base. */
export type Commission = { reference: string; nombre: number; ecriture: bigint | null; figee: bigint | null; taux: number | null;
  tauxEnVigueur: number; attendue: bigint | null };

export type Categorie = "concordant" | "decalage" | "confirmation_tardive" | "montant_different" | "doublon_releve"
  | "succes_chez_nous_echec_au_releve" | "succes_au_releve_pas_chez_nous" | "absent_du_releve" | "absent_de_la_base"
  | "grand_livre" | "taux_commission" | "reference_ambigue";
export type Ecart = { categorie: Categorie; reference: string; detail: string };

export const EXPLIQUES: Categorie[] = ["concordant", "decalage", "confirmation_tardive"];
export const ECARTS_A_INSTRUIRE: Categorie[] = ["montant_different", "doublon_releve", "succes_chez_nous_echec_au_releve",
  "succes_au_releve_pas_chez_nous", "absent_du_releve", "absent_de_la_base", "grand_livre", "taux_commission", "reference_ambigue"];

export type Couverture = { du: Date; au: Date };
export type Resultat = {
  jour: string; lignes: Ecart[]; ecartNul: boolean;
  totaux: { base_xof: bigint; releve_xof: bigint; commissions_xof: bigint; paiements: number; encaissements: number; taux: number[] };
};

const JOUR_MS = 86_400_000;
/** Délai maximal entre l'encaissement et notre confirmation (vérification périodique pendant 24 h, ADR 0013). */
const RETARD_MAX_MS = JOUR_MS;

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

export function rapprocher(jour: string, base: LigneBase[], releve: LigneReleve[], commissions: Commission[], toleranceS = 600): Resultat {
  const { debut, fin } = bornes(jour, toleranceS);
  const tol = toleranceS * 1000;
  const dansJour = (t: number) => t >= debut && t < fin;
  const lignes: Ecart[] = [];

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
      commissions_xof: commissionsXof, paiements: succesDuJour.length, encaissements: encaissementsDuJour.length, taux: [...taux].sort((a, b) => a - b) },
  };
}

// ------------------------------------------------------------------ relevé CSV

export type Colonnes = { reference: string; montant: string; date: string; statut: string; reussi: string[]; echec: string[]; sep?: string };

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

/** Lit le relevé. TOUTE anomalie est une erreur (code 2), jamais une ligne ignorée : nombre de champs, statut hors des
 *  deux listes, montant non entier, date non ISO, ligne hors de la fenêtre [J − 2, J + 3[ (mauvais fichier). */
export function lireReleve(texte: string, col: Colonnes, jour?: string): LigneReleve[] {
  const lignesTexte = texte.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lignesTexte.length === 0) return [];
  const sep = col.sep ?? ((lignesTexte[0].match(/;/g)?.length ?? 0) >= (lignesTexte[0].match(/,/g)?.length ?? 0) ? ";" : ",");
  const entete = champs(lignesTexte[0], sep, 1);
  const idx = (n: string) => { const i = entete.indexOf(n); if (i < 0) throw new Error(`colonne « ${n} » absente du relevé (colonnes : ${entete.join(", ")})`); return i; };
  const [iRef, iMontant, iDate, iStatut] = [idx(col.reference), idx(col.montant), idx(col.date), idx(col.statut)];
  // Relecture N2 : une valeur vide (« FAILED, ») ferait d'un statut vide un échec, donc une ligne ignorée.
  const liste = (l: string[], nom: string) => {
    const v = l.map((s) => s.trim().toUpperCase());
    if (v.length === 0 || v.some((s) => s === "")) throw new Error(`--${nom} : liste de statuts sans valeur vide`);
    return new Set(v);
  };
  const reussi = liste(col.reussi, "reussi"), echec = liste(col.echec, "echec");
  for (const s of reussi) if (echec.has(s)) throw new Error(`statut « ${s} » à la fois réussi et en échec`);
  const fenetre = jour ? [Date.parse(`${jour}T00:00:00Z`) - 2 * JOUR_MS, Date.parse(`${jour}T00:00:00Z`) + 3 * JOUR_MS] : null;
  return lignesTexte.slice(1).map((l, k) => {
    const ligne = k + 2, c = champs(l, sep, ligne);
    if (c.length !== entete.length) throw new Error(`ligne ${ligne} : ${c.length} champs, ${entete.length} attendus (séparateur « ${sep} » ; montant à séparateur de milliers non cité ?)`);
    const reference = c[iRef];
    if (!reference) throw new Error(`ligne ${ligne} : référence vide`);
    let montant: bigint;
    try { montant = BigInt(versXof(c[iMontant])); } catch (e) { throw new Error(`ligne ${ligne} : montant « ${c[iMontant]} » refusé (${(e as Error).message})`); }
    const le = lireDate(c[iDate]);
    if (!le) throw new Error(`ligne ${ligne} : date « ${c[iDate]} » refusée (ISO 8601 : AAAA-MM-JJ HH:MM[:SS][Z|±HH:MM])`);
    if (fenetre && (le.getTime() < fenetre[0] || le.getTime() >= fenetre[1])) throw new Error(`ligne ${ligne} : date ${le.toISOString()} hors de la fenêtre du rapprochement (mauvais fichier ?)`);
    const statut = c[iStatut].toUpperCase();
    if (!statut) throw new Error(`ligne ${ligne} : statut vide`);
    if (!reussi.has(statut) && !echec.has(statut)) throw new Error(`ligne ${ligne} : statut « ${c[iStatut]} » ni réussi ni en échec (--reussi, --echec)`);
    return { reference, montant, le, reussi: reussi.has(statut), ligne };
  });
}

// ------------------------------------------------------------------ rapport

export function rapportMarkdown(r: Resultat, proprietaire: string, couverture: Couverture): string {
  const t = r.totaux;
  const parCat = (c: Categorie) => r.lignes.filter((l) => l.categorie === c);
  const out = [`# Rapprochement du ${r.jour} — propriétaire ${proprietaire} — ${r.ecartNul ? "ÉCART NUL" : "ÉCARTS À INSTRUIRE"}`, "",
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
    for (const x of l) out.push(`- \`${x.reference}\` : ${x.detail}`);
    out.push("");
  }
  out.push(`Concordants : ${parCat("concordant").length}.`);
  return out.join("\n") + "\n";
}

// ------------------------------------------------------------------ point d'entrée

function option(nom: string, defaut?: string): string {
  const i = process.argv.indexOf(`--${nom}`);
  const v = i >= 0 ? process.argv[i + 1] : defaut;
  if (v === undefined || (i >= 0 && v.startsWith("--"))) throw new Error(`option --${nom} manquante`);
  return v;
}
function options(nom: string): string[] {
  return process.argv.flatMap((a, i) => (a === `--${nom}` && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? [process.argv[i + 1]] : []));
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
  // Base en LECTURE SEULE (WAKATNET_ADMIN_DATABASE_URL, jamais en argument). Sortie : rapport Markdown.
  // Code : 0 écart nul, 1 écarts à instruire, 2 entrée invalide (relevé insuffisant, ligne illisible…).
  try {
    const proprietaire = option("proprietaire"), jour = option("jour");
    if (!/^\d+$/.test(proprietaire)) throw new Error("--proprietaire : identifiant entier");
    const du = lireDate(option("releve-du")), au = lireDate(option("releve-au"));
    if (!du || !au) throw new Error("--releve-du et --releve-au : dates ISO 8601");
    const couverture = { du, au };
    verifierCouverture(jour, couverture);
    const fichiers = options("releve");
    if (fichiers.length === 0) throw new Error("--releve : au moins un fichier");
    const col: Colonnes = { reference: option("col-reference", "reference"), montant: option("col-montant", "montant"),
      date: option("col-date", "date"), statut: option("col-statut", "statut"),
      reussi: option("reussi").split(","), echec: option("echec").split(","),
      ...(process.argv.includes("--sep") ? { sep: option("sep") } : {}) };
    const releve = fichiers.flatMap((f) => {
      try { return lireReleve(readFileSync(f, "utf8"), col, jour); } catch (e) { throw new Error(`${f} : ${(e as Error).message}`); }
    });
    const url = process.env.WAKATNET_ADMIN_DATABASE_URL;
    if (!url) throw new Error("WAKATNET_ADMIN_DATABASE_URL manquant");
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      // Bornes du jour en UTC quel que soit le fuseau de la session (heure du Burkina).
      await c.query("SET LOCAL TIME ZONE 'UTC'");
      const refs = releve.map((r) => r.reference);
      const { rows: base } = await c.query<{ reference: string; reference_fournisseur: string | null; montant: string; statut: string; confirme_le: Date | null }>(
        `SELECT reference, reference_fournisseur, montant::text, statut, confirme_le FROM app.payment
          WHERE tenant_id = $1 AND (confirme_le >= $2::date - 2 AND confirme_le < $2::date + 3
                OR reference = ANY($3::text[]) OR reference_fournisseur = ANY($3::text[]))`, [proprietaire, jour, refs]);
      const { rows: comm } = await c.query<{ reference: string; nombre: number; ecriture: string | null; figee: string | null; taux: number | null; taux_en_vigueur: number; attendue: string | null }>(
        `SELECT p.reference,
                (SELECT count(*)::int FROM ledger.transaction x WHERE x.objet = 'paiement:' || p.id AND x.nature = 'commission') AS nombre,
                (SELECT sum(e.debit)::text FROM ledger.transaction x JOIN ledger.ecriture e ON e.transaction_id = x.id
                  JOIN ledger.compte k ON k.id = e.compte_id AND k.code = 'proprietaire:' || p.tenant_id || ':credits'
                  WHERE x.objet = 'paiement:' || p.id AND x.nature = 'commission') AS ecriture,
                (SELECT max((a.details->>'commission')::bigint)::text FROM app.audit_log a
                  WHERE a.objet = 'paiement:' || p.id AND a.action IN ('paiement_confirme', 'paiement_succes_apres_expiration')) AS figee,
                (SELECT max(x.taux_bps) FROM ledger.transaction x WHERE x.objet = 'paiement:' || p.id AND x.nature = 'commission') AS taux,
                t.commission_bps AS taux_en_vigueur,
                ledger.commission(p.montant, t.commission_bps, t.commission_min)::text AS attendue
           FROM app.payment p JOIN app.tenant t ON t.id = p.tenant_id
          WHERE p.tenant_id = $1 AND p.statut = 'SUCCEEDED' AND p.confirme_le >= $2::date AND p.confirme_le < $2::date + 1`, [proprietaire, jour]);
      await c.query("COMMIT");
      const r = rapprocher(jour, base.map((b) => ({ reference: b.reference, referenceFournisseur: b.reference_fournisseur, montant: BigInt(b.montant),
          statut: b.statut, confirmeLe: b.confirme_le })), releve,
        comm.map((x) => ({ reference: x.reference, nombre: x.nombre, ecriture: x.ecriture === null ? null : BigInt(x.ecriture),
          figee: x.figee === null ? null : BigInt(x.figee), taux: x.taux, tauxEnVigueur: x.taux_en_vigueur,
          attendue: x.attendue === null ? null : BigInt(x.attendue) })));
      process.stdout.write(rapportMarkdown(r, proprietaire, couverture));
      process.exitCode = r.ecartNul ? 0 : 1;
    } finally {
      await c.end();
    }
  } catch (e) {
    console.error(`rapprochement : ${(e as Error).message}`);
    process.exitCode = 2;
  }
}
