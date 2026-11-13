// Rapprochement quotidien du pilote (SPEC §12 phase 6 ; docs/PILOTE.md §4). Code d'argent : tests de
// propriétés (règle 4 du §13) et relecture par un second agent (B1 à B3, I1 à I4 de sa relecture : couverts ici).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import fc from "fast-check";
import { ECARTS_A_INSTRUIRE, EXPLIQUES, lireArguments, lireDate, lireReleve, rapportMarkdown, rapprocher, verifierCouverture,
         verifierVolume, type Commission, type LigneBase, type LigneReleve } from "../src/rapprochement.ts";
import { avecApp, sql, URL_ADMIN } from "./aide.ts";
import { attendreStatut, jeton, numero, soumission, vendeur } from "./aide-paiement.ts";

const J = "2026-11-20";
const T = (h: number, m = 0, s = 0, jour = 20) => new Date(Date.UTC(2026, 10, jour, h, m, s));
const b = (reference: string, montant: number, confirmeLe: Date | null = T(12), statut = "SUCCEEDED", referenceFournisseur: string | null = null): LigneBase =>
  ({ reference, referenceFournisseur, montant: BigInt(montant), statut, confirmeLe });
const r = (reference: string, montant: number, le = T(12), reussi = true, ligne = 2): LigneReleve => ({ reference, montant: BigInt(montant), le, reussi, ligne });
const commission = (m: bigint, bps = 1000) => (m * BigInt(bps) + 5000n) / 10000n;
/** Commission conforme : écrite si > 0, figée à la confirmation, au taux en vigueur. */
const c = (x: LigneBase, bps = 1000): Commission => {
  const f = commission(x.montant, bps);
  return { reference: x.reference, nombre: f > 0n ? 1 : 0, ecriture: f > 0n ? f : null, figee: f, taux: f > 0n ? bps : null, tauxEnVigueur: bps, attendue: f };
};
const cats = (x: ReturnType<typeof rapprocher>) => x.lignes.map((l) => `${l.categorie}:${l.reference}`).sort();
const COL = { reference: "ref", montant: "montant", date: "date", statut: "statut", reussi: ["SUCCESS"], echec: ["FAILED"] };

test("chaque catégorie ; écart nul seulement sans écart à instruire", () => {
  const p1 = b("p1", 200), p2 = b("p2", 500, T(9), "SUCCEEDED", "OP-9");
  let x = rapprocher(J, [p1, p2], [r("p1", 200), r("OP-9", 500, T(9))], [c(p1), c(p2)]);
  assert.deepEqual(cats(x), ["concordant:p1", "concordant:p2"]);
  assert.equal(x.ecartNul, true);
  assert.deepEqual([x.totaux.base_xof, x.totaux.releve_xof, x.totaux.commissions_xof, x.totaux.taux], [700n, 700n, 70n, [1000]]);
  const p3 = b("p3", 300);
  x = rapprocher(J, [p1, p3], [r("p3", 350), r("INCONNU", 100)], [c(p1), c(p3)]);
  assert.deepEqual(cats(x), ["absent_de_la_base:INCONNU", "absent_du_releve:p1", "montant_different:p3"]);
  assert.equal(x.ecartNul, false);
  const p4 = b("p4", 200, null, "EXPIRED"), p5 = b("p5", 200);
  x = rapprocher(J, [p4, p5], [r("p4", 200), r("p5", 200, T(12), false)], [c(p5)]);
  assert.deepEqual(cats(x), ["succes_au_releve_pas_chez_nous:p4", "succes_chez_nous_echec_au_releve:p5"]);
  assert.deepEqual(cats(rapprocher(J, [b("p6", 200, null, "FAILED")], [r("p6", 200, T(12), false)], [])), [], "échec des deux côtés");
});

test("relecture B1 : un ticket délivré à 23:55 sans encaissement est un ÉCART (le relevé couvre le lendemain)", () => {
  const p = b("p1", 200, T(23, 55));
  const x = rapprocher(J, [p], [], [c(p)]);
  assert.deepEqual(cats(x), ["absent_du_releve:p1"]);
  assert.equal(x.ecartNul, false);
  // Et le lendemain, il n'est pas rapproché une seconde fois (jour de notre confirmation : J).
  assert.deepEqual(cats(rapprocher("2026-11-21", [p], [], [])), []);
});

test("relecture I1 : de part et d'autre de minuit, dans les deux sens, c'est un décalage expliqué", () => {
  // Encaissé à J 23:59:58, confirmé à J+1 00:00:05 : rapproché le jour de la confirmation (J+1).
  const p = b("p1", 200, T(0, 0, 5, 21));
  const rel = [r("p1", 200, T(23, 59, 58))];
  // Le jour J, la ligne est listée comme décalage (relecture N4 : la différence des totaux s'explique ligne par ligne).
  assert.deepEqual(cats(rapprocher(J, [p], rel, [c(p)])), ["decalage:p1"], "le jour J : contrepartie d'un paiement du lendemain");
  const x = rapprocher("2026-11-21", [p], rel, [c(p)]);
  assert.deepEqual(cats(x), ["decalage:p1"]);
  assert.equal(x.ecartNul, true);
  // Confirmé à J 23:59:50, encaissé à J+1 00:00:02 : décalage le jour J.
  const q = b("q1", 300, T(23, 59, 50));
  assert.deepEqual(cats(rapprocher(J, [q], [r("q1", 300, T(0, 0, 2, 21))], [c(q)])), ["decalage:q1"]);
});

test("relecture I3 : confirmation tardive (webhook perdu, repris par la vérification) expliquée ; incohérence de dates : écart", () => {
  const p = b("p1", 200, T(1, 30, 0, 21));                                // confirmé à J+1 01:30
  const x = rapprocher("2026-11-21", [p], [r("p1", 200, T(23, 40))], [c(p)]); // encaissé à J 23:40
  assert.deepEqual(cats(x), ["confirmation_tardive:p1"]);
  assert.equal(x.ecartNul, true);
  // Confirmé AVANT l'encaissement de plus que la tolérance : impossible, écart.
  const q = b("q1", 200, T(10));
  assert.deepEqual(cats(rapprocher(J, [q], [r("q1", 200, T(14))], [c(q)])), ["absent_du_releve:q1"]);
});

test("doublon au relevé et référence ambiguë : écarts", () => {
  const p = b("p1", 200);
  assert.deepEqual(cats(rapprocher(J, [p], [r("p1", 200, T(12), true, 2), r("p1", 200, T(12), true, 3)], [c(p)])), ["concordant:p1", "doublon_releve:p1"]);
  const a = b("a", 200, T(10), "SUCCEEDED", "OP-1"), bb = b("b", 200, T(11), "SUCCEEDED", "OP-1");
  const x = rapprocher(J, [a, bb], [r("OP-1", 200, T(10))], [c(a), c(bb)]);
  assert.ok(cats(x).includes("reference_ambigue:OP-1"));
  assert.equal(x.ecartNul, false);
});

test("grand livre : absente, en double, différente de la valeur figée, mauvais taux ; commission nulle non écrite conforme", () => {
  const ps = ["p1", "p2", "p3", "p4", "p5"].map((k) => b(k, 200));
  const rel = ps.map((p) => r(p.reference, 200));
  const comm: Commission[] = [
    c(ps[0]),
    { ...c(ps[1]), nombre: 0, ecriture: null },
    { ...c(ps[2]), nombre: 2, ecriture: 40n },
    { ...c(ps[3]), ecriture: 19n },
    { ...c(ps[4]), taux: 500, ecriture: 10n, figee: 10n },
  ];
  const x = rapprocher(J, ps, rel, comm);
  assert.deepEqual(x.lignes.filter((l) => !EXPLIQUES.includes(l.categorie)).map((l) => `${l.categorie}:${l.reference}`).sort(),
    ["grand_livre:p2", "grand_livre:p3", "grand_livre:p4", "taux_commission:p5"]);
  const nulle = b("n", 4);                                                // 4 F à 10 % : 0 F, non écrite
  assert.equal(rapprocher(J, [nulle], [r("n", 4)], [c(nulle)]).ecartNul, true);
  assert.equal(rapprocher(J, [nulle], [r("n", 4)], []).ecartNul, false, "sans aucune trace : écart");
});

test("propriété : sur toute la journée, minuit compris, relevé parfait ⇒ écart nul ; une perturbation ⇒ écart", () => {
  const TOL = 600_000;
  fc.assert(fc.property(
    fc.uniqueArray(fc.record({ ref: fc.stringMatching(/^[a-z0-9]{6,12}$/), montant: fc.integer({ min: 1, max: 1_000_000 }),
                               seconde: fc.integer({ min: 0, max: 86_399 }), decalage: fc.integer({ min: -TOL, max: TOL }) }),
                   { minLength: 1, maxLength: 30, selector: (x) => x.ref }),
    fc.option(fc.constantFrom("supprimer", "montant", "etranger", "echec", "doublon", "commission_absente", "commission_fausse",
                              "commission_double", "taux"), { nil: null }),
    fc.nat(),
    (paiements, perturbation, choix) => {
      const base = paiements.map((p) => b(p.ref, p.montant, new Date(Date.parse(`${J}T00:00:00Z`) + p.seconde * 1000)));
      let rel = paiements.map((p, i) => r(p.ref, p.montant, new Date(base[i].confirmeLe!.getTime() + p.decalage), true, i + 2));
      let comm = base.map((x) => c(x));
      const k = choix % base.length;
      const avecCommission = comm[k].figee! > 0n;
      if (perturbation === "supprimer") rel = rel.filter((_, i) => i !== k);
      if (perturbation === "montant") rel[k] = { ...rel[k], montant: rel[k].montant + 1n };
      if (perturbation === "etranger") rel.push(r("zzzzzzzzzzzzzz", 100, T(12), true, 999));
      if (perturbation === "echec") rel[k] = { ...rel[k], reussi: false };
      if (perturbation === "doublon") rel.push({ ...rel[k], ligne: 998 });
      if (perturbation === "commission_absente") comm = comm.filter((_, i) => i !== k);
      if (perturbation === "commission_fausse") comm[k] = { ...comm[k], nombre: 1, ecriture: (comm[k].figee ?? 0n) + 1n };
      // « double » et « taux » ne portent que sur une commission écrite : une commission nulle (1 à 4 F) n'a ni écriture
      // ni taux, et lui en donner un fabriquerait un état impossible (la perturbation est alors sans objet).
      const sansObjet = !avecCommission && (perturbation === "commission_double" || perturbation === "taux");
      if (perturbation === "commission_double" && !sansObjet) comm[k] = { ...comm[k], nombre: 2, ecriture: comm[k].ecriture! * 2n };
      if (perturbation === "taux" && !sansObjet) comm[k] = { ...comm[k], taux: 999 };
      const x = rapprocher(J, base, rel, comm);
      assert.equal(x.ecartNul, perturbation === null || sansObjet, `perturbation ${perturbation}`);
      // Chaque paiement est classé une fois hors grand livre, taux et doublon.
      const vus = x.lignes.filter((l) => !["grand_livre", "taux_commission", "doublon_releve"].includes(l.categorie)).map((l) => l.reference);
      for (const p of base) assert.equal(vus.filter((v) => v === p.reference).length, 1, p.reference);
      assert.ok(x.lignes.every((l) => ECARTS_A_INSTRUIRE.includes(l.categorie) || EXPLIQUES.includes(l.categorie)));
      assert.equal(x.totaux.base_xof, base.reduce((n, p) => n + p.montant, 0n));
    }), { numRuns: 500 });
});

test("relecture B2 et B3 : lecture du relevé stricte ; toute anomalie est une ERREUR, jamais une ligne ignorée", () => {
  const l = lireReleve('﻿ref;montant;date;statut\r\n"po_a;1";200;2026-11-20T10:00:00Z;success\npo_b;300;2026-11-20 11:00;FAILED\n', COL, J);
  assert.deepEqual(l.map((x) => [x.reference, x.montant, x.reussi, x.le.toISOString()]),
    [["po_a;1", 200n, true, "2026-11-20T10:00:00.000Z"], ["po_b", 300n, false, "2026-11-20T11:00:00.000Z"]]);
  const erreur = (csv: string, motif: RegExp) => assert.throws(() => lireReleve(csv, COL, J), motif);
  erreur("ref;montant;date;statut\npo;200;2026-11-20T10:00:00Z;COMPLETED\n", /ni réussi ni en échec/);
  erreur("ref,montant,date,statut\nOP-Y,1,000,2026-11-20T10:00:00Z,SUCCESS\n", /5 champs, 4 attendus/);
  erreur("ref;montant;date;statut\npo;200;10/11/2026 10:00;SUCCESS\n", /date « 10\/11\/2026 10:00 » refusée/);
  erreur("ref;montant;date;statut\npo;200;2026-12-25T10:00:00Z;SUCCESS\n", /hors de la fenêtre/);
  erreur("ref;montant;date;statut\npo;200.50;2026-11-20T10:00:00Z;SUCCESS\n", /montant/);
  erreur("ref;montant;date;statut\npo;-200;2026-11-20T10:00:00Z;SUCCESS\n", /montant/);
  erreur('ref;montant;date;statut\n"po;200;2026-11-20T10:00:00Z;SUCCESS\n', /guillemet non refermé/);
  erreur("ref;somme;date;statut\npo;200;2026-11-20T10:00:00Z;SUCCESS\n", /colonne « montant » absente/);
  assert.throws(() => lireReleve("ref;montant;date;statut\n", { ...COL, echec: ["SUCCESS"] }), /à la fois réussi et en échec/);
  // Sans fuseau : UTC (heure du Burkina), quel que soit le fuseau de la machine.
  assert.equal(lireDate("2026-11-20 23:30")!.toISOString(), "2026-11-20T23:30:00.000Z");
  assert.equal(lireDate("2026-11-20T23:30:00+01:00")!.toISOString(), "2026-11-20T22:30:00.000Z");
});

test("contre-relecture N1 à N5", () => {
  // N1 : second encaissement le jour J sous la référence d'un paiement confirmé à J − 2 (sa 1re ligne hors du relevé).
  const v = b("wk_V", 200, T(23, 0, 0, 18));
  assert.deepEqual(cats(rapprocher(J, [v], [r("wk_V", 200, T(10))], [])), ["doublon_releve:wk_V"]);
  // N4 : la contrepartie d'une confirmation du lendemain est listée (expliquée) le jour J aussi.
  const d = b("wk_D", 300, T(0, 0, 5, 21)), t = b("wk_T", 300, T(6, 0, 0, 21));
  const x = rapprocher(J, [d, t], [r("wk_D", 300, T(23, 59, 58)), r("wk_T", 300, T(22))], []);
  assert.deepEqual(cats(x), ["confirmation_tardive:wk_T", "decalage:wk_D"]);
  assert.equal(x.ecartNul, true);
  assert.deepEqual(cats(rapprocher(J, [d], [r("wk_D", 301, T(23, 59, 58))], [])), ["montant_different:wk_D"]);
  // N2 : valeur vide dans une liste, statut vide.
  assert.throws(() => lireReleve("ref;montant;date;statut\nOP-X;5000;2026-11-20T10:00:00Z;\n", { ...COL, echec: ["FAILED", ""] }, J), /sans valeur vide/);
  assert.throws(() => lireReleve("ref;montant;date;statut\nOP-X;5000;2026-11-20T10:00:00Z;\n", COL, J), /statut vide/);
  // N3 : commission figée à 0 alors que le taux en vigueur en donne 20 ; plancher non appliqué.
  const p = b("wk_P", 200);
  assert.deepEqual(cats(rapprocher(J, [p], [r("wk_P", 200)], [{ ...c(p), nombre: 0, ecriture: null, figee: 0n, taux: null, attendue: 20n }])), ["concordant:wk_P", "taux_commission:wk_P"]);
  assert.deepEqual(cats(rapprocher(J, [p], [r("wk_P", 200)], [{ ...c(p), attendue: 50n }])), ["concordant:wk_P", "taux_commission:wk_P"]);
  // N5 : dates impossibles refusées ; fractions de seconde gardées.
  for (const s of ["2026-02-30T10:00:00Z", "2026-11-31 10:00", "2026-11-20T24:00:00Z", "2026-11-20T10:60:00Z"]) assert.equal(lireDate(s), null, s);
  assert.equal(lireDate("2026-11-20T10:00:00.250Z")!.toISOString(), "2026-11-20T10:00:00.250Z");
});

test("relevé pawaPay (journal du portefeuille) : frais et retraits hors paiement, totalisés ; aucun échec ; « 100.00 »", () => {
  // Colonnes de l'export documenté (docs.pawapay.io, Dashboard > Statements, lu le 12/11/2026). Les VALEURS (format de
  // date, signe et décimales des frais) ne sont pas documentées : à confirmer sur le premier export du bac à sable.
  const DEP = "3f2a9c1e-0b4d-4e8a-9c2f-1a2b3c4d5e6f";
  const csv = "Creation date,MSISDN,Transaction ID,Amount,MNO,Type,Balance,Reason,Metadata\n"
    + `2026-11-20 10:00:00,22607345678,${DEP},200.00,ORANGE_BFA,Deposit,1200.00,,"{""a"":1,""b"":2}"\n`
    + `2026-11-20 10:00:00,22607345678,${DEP},-3.50,ORANGE_BFA,Deposit pass through fees,1196.50,,\n`
    + `2026-11-20 10:00:00,22607345678,${DEP},-2,ORANGE_BFA,Deposit PawaPay fees,1194.50,,\n`
    + "2026-11-20 18:00:00,,,-1000.00,,Withdrawal,194.50,Règlement,\n"
    + "2026-11-19 18:00:00,,,-50,,Withdrawal,0,Règlement,\n";
  const PP = { reference: "Transaction ID", montant: "Amount", date: "Creation date", statut: "Type", reussi: ["Deposit"], echec: [],
               hors: ["Deposit pass through fees", "Deposit PawaPay fees", "Withdrawal"] };
  const l = lireReleve(csv, PP, J);
  assert.deepEqual(l.filter((x) => !x.hors).map((x) => [x.reference, x.montant, x.reussi]), [[DEP, 200n, true]]);
  assert.deepEqual(l.filter((x) => x.hors).map((x) => [x.hors, x.centimes]),
    [["DEPOSIT PASS THROUGH FEES", -350n], ["DEPOSIT PAWAPAY FEES", -200n], ["WITHDRAWAL", -100000n], ["WITHDRAWAL", -5000n]]);
  // Rapproché par le depositId (référence du fournisseur) : écart nul ; les lignes hors paiement ne sont jamais des écarts.
  const p = b("wk_P", 200, T(10, 0, 5), "SUCCEEDED", DEP);
  const x = rapprocher(J, [p], l, [c(p)]);
  assert.deepEqual(cats(x), ["concordant:wk_P"]);
  assert.equal(x.ecartNul, true);
  // Totalisées par type, pour le jour J seulement (le retrait du 19 n'en est pas).
  assert.deepEqual(x.totaux.hors, [{ type: "DEPOSIT PASS THROUGH FEES", nombre: 1, centimes: -350n },
    { type: "DEPOSIT PAWAPAY FEES", nombre: 1, centimes: -200n }, { type: "WITHDRAWAL", nombre: 1, centimes: -100000n }]);
  const rapport = rapportMarkdown(x, "1", { du: T(0, 0, 0, 19), au: T(8, 0, 0, 21) });
  assert.match(rapport, /Lignes hors paiement/);
  assert.match(rapport, /\| DEPOSIT PASS THROUGH FEES \| 1 \| -3\.50 F \|/);
  assert.match(rapport, /\| WITHDRAWAL \| 1 \| -1000\.00 F \|/);
  // Un encaissement absent du relevé reste un écart, même sans aucune ligne d'échec possible.
  const q = b("wk_Q", 300, T(11));
  assert.deepEqual(cats(rapprocher(J, [p, q], l, [c(p), c(q)])), ["absent_du_releve:wk_Q", "concordant:wk_P"]);

  // Rien n'est assoupli pour le reste : toute ligne non déclarée reste une ERREUR.
  const erreur = (ligne: string, motif: RegExp, col = PP) =>
    assert.throws(() => lireReleve("Creation date,MSISDN,Transaction ID,Amount,MNO,Type,Balance,Reason,Metadata\n" + ligne + "\n", col, J), motif);
  erreur("2026-11-20 10:00:00,,,500,,Adjustment - Collections received,0,Correction,", /ni réussi ni en échec/);
  erreur(`2026-11-20 10:00:00,226,${DEP},-3.50,ORANGE_BFA,Deposit pass through fees,0,,`, /ni réussi ni en échec/, { ...PP, hors: [] });
  erreur(`2026-11-20 10:00:00,226,${DEP},200.50,ORANGE_BFA,Deposit,0,,`, /montant/);
  erreur(`2026-11-20 10:00:00,226,${DEP},-200.00,ORANGE_BFA,Deposit,0,,`, /montant/);
  erreur(`2026-11-20 10:00:00,226,${DEP},200.001,ORANGE_BFA,Deposit,0,,`, /montant/);
  erreur("2026-11-20 10:00:00,226,,200,ORANGE_BFA,Deposit,0,,", /référence vide/);
  erreur("2026-11-20 10:00:00,,,-3.505,,Withdrawal,0,,", /montant/);
  erreur("2026-11-20 10:00:00,,,abc,,Withdrawal,0,,", /montant/);
  erreur("2026-12-25 10:00:00,,,-3,,Withdrawal,0,,", /hors de la fenêtre/);
  assert.throws(() => lireReleve("a,b,c,d\n", { ...PP, reference: "a", montant: "b", date: "c", statut: "d", hors: ["Deposit"] }), /à la fois réussi et hors paiement/);
  assert.throws(() => lireReleve("a,b,c,d\n", { ...PP, reference: "a", montant: "b", date: "c", statut: "d", hors: ["Withdrawal", " "] }), /sans valeur vide/);
  // Des listes de réussite vide restent refusées : le relevé doit dire ce qu'est un encaissement.
  assert.throws(() => lireReleve("a,b,c,d\n", { ...PP, reference: "a", montant: "b", date: "c", statut: "d", reussi: [] }), /--reussi/);
});

test("relecture du profil pawaPay : ligne hors paiement créditrice, orpheline ou en double", () => {
  const DEP = "3f2a9c1e-0b4d-4e8a-9c2f-1a2b3c4d5e6f", AUTRE = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
  const PP = { reference: "Transaction ID", montant: "Amount", date: "Creation date", statut: "Type", reussi: ["Deposit"], echec: [],
               hors: ["Deposit PawaPay fees", "Withdrawal", "Refund"] };
  const ENT = "Creation date,MSISDN,Transaction ID,Amount,MNO,Type,Balance,Reason,Metadata\n";
  const dep = `2026-11-20 10:00:00,226,${DEP},200.00,ORANGE_BFA,Deposit,0,,\n`;
  const p = b("wk_P", 200, T(10, 0, 5), "SUCCEEDED", DEP);
  // I-a : une ligne hors paiement ne peut que débiter le portefeuille ; un crédit (+500 « Withdrawal ») est une ERREUR.
  assert.throws(() => lireReleve(ENT + `2026-11-20 10:00:00,226,${AUTRE},500,,Withdrawal,0,,\n`, PP, J), /hors paiement.*créditrice|crédit/);
  assert.throws(() => lireReleve(ENT + `2026-11-20 10:00:00,226,${DEP},2.50,,Deposit PawaPay fees,0,,\n`, PP, J), /crédit/);
  // I-b : une ligne hors paiement qui porte une référence doit porter celle d'un encaissement du relevé ; sinon : à instruire.
  const rembourse = rapprocher(J, [p], lireReleve(ENT + dep + `2026-11-20 12:00:00,226,${AUTRE},-200.00,ORANGE_BFA,Refund,0,,\n`, PP, J), [c(p)]);
  assert.deepEqual(cats(rembourse), ["concordant:wk_P", `hors_paiement_orphelin:${AUTRE}`]);
  assert.equal(rembourse.ecartNul, false);
  const frais = rapprocher(J, [p], lireReleve(ENT + dep + `2026-11-20 10:00:00,226,${DEP},-2.50,,Deposit PawaPay fees,0,,\n`, PP, J), [c(p)]);
  assert.deepEqual(cats(frais), ["concordant:wk_P"]);
  assert.equal(frais.ecartNul, true);
  // M-1 : la même ligne hors paiement deux fois (exports qui se chevauchent) : à instruire, jamais comptée deux fois en silence.
  const retrait = "2026-11-20 18:00:00,,,-1000.00,,Withdrawal,0,Règlement,\n";
  const double = rapprocher(J, [p], [...lireReleve(ENT + dep + retrait, PP, J), ...lireReleve(ENT + retrait, PP, J)], [c(p)]);
  assert.deepEqual(cats(double), ["concordant:wk_P", "doublon_releve:WITHDRAWAL"]);
  assert.equal(double.ecartNul, false);
});

// ------------------------------------------------------------------ audit de sécurité de l'outil (constats 1 à 6)

test("audit 1 : relevé vide, réduit à l'en-tête ou aux fins de ligne en \\r seul : ERREUR, jamais zéro ligne en silence", () => {
  const erreur = (csv: string, motif: RegExp) => assert.throws(() => lireReleve(csv, COL, J), motif);
  erreur("", /vide/);
  erreur("﻿", /vide/);
  erreur("ref;montant;date;statut\n", /aucune ligne de données/);
  erreur("ref;montant;date;statut\r\n\r\n  \r\n", /aucune ligne de données/);
  // Fins de ligne en \r seul (ancien Mac, certains tableurs) : avant le correctif, tout le fichier tenait sur la seule
  // ligne d'en-tête (colonne finale « x\rpo_a… ») et l'outil lisait zéro ligne, sans erreur.
  const cr = lireReleve("ref;montant;date;statut;x\rpo_a;200;2026-11-20T10:00:00Z;SUCCESS;\rpo_b;300;2026-11-20T11:00:00Z;FAILED;\r", COL, J);
  assert.deepEqual(cr.map((x) => [x.reference, x.montant, x.reussi, x.ligne]), [["po_a", 200n, true, 2], ["po_b", 300n, false, 3]]);
  // --releve-vide : un fichier réduit à l'en-tête est admis (jour réellement sans mouvement) ; un fichier vide, jamais.
  assert.deepEqual(lireReleve("ref;montant;date;statut\n", COL, J, { videPermis: true }), []);
  assert.throws(() => lireReleve("", COL, J, { videPermis: true }), /vide/);
  // Total sur tous les fichiers : nul ⇒ erreur, sauf --releve-vide ; --releve-vide avec une ligne du jour J ⇒ erreur.
  assert.throws(() => verifierVolume(J, [], false), /aucune ligne/);
  verifierVolume(J, [], true);
  verifierVolume(J, [r("p1", 200)], false);
  assert.throws(() => verifierVolume(J, [r("p1", 200)], true), /--releve-vide/);
  assert.throws(() => verifierVolume(J, [{ ...r("", 0), hors: "WITHDRAWAL", centimes: -100n }], true), /--releve-vide/);
  verifierVolume(J, [r("p1", 200, T(12, 0, 0, 19))], true);                 // la veille : le jour J reste sans mouvement
  // Le rapport le dit en tête.
  const x = rapprocher(J, [], [], []);
  assert.match(rapportMarkdown(x, "1", { du: T(0, 0, 0, 19), au: T(8, 0, 0, 21) }, { releveVide: true }).split("\n").slice(0, 4).join("\n"),
    /relevé déclaré vide par l'exploitant/);
  assert.doesNotMatch(rapportMarkdown(x, "1", { du: T(0, 0, 0, 19), au: T(8, 0, 0, 21) }), /déclaré vide/);
});

test("audit 2 : ligne de commande stricte ; argument positionnel ou option inconnue refusés ; --releve répétable", () => {
  const BASE = ["--proprietaire", "1", "--jour", J, "--releve-du", "2026-11-19T00:00:00Z", "--releve-au", "2026-11-21T08:00:00Z", "--reussi", "SUCCESS"];
  const a = lireArguments([...BASE, "--releve", "a.csv", "--releve", "b c.csv", "--echec", "FAILED", "--hors-paiement", "Withdrawal", "--sep", ","]);
  assert.deepEqual([a.proprietaire, a.jour, a.fichiers, a.releveVide, a.col.reussi, a.col.echec, a.col.hors, a.col.sep, a.col.reference],
    ["1", J, ["a.csv", "b c.csv"], false, ["SUCCESS"], ["FAILED"], ["Withdrawal"], ",", "reference"]);
  assert.equal(lireArguments([...BASE, "--releve", "a.csv", "--releve-vide"]).releveVide, true);
  // Le piège du shell : « --releve releve-*.csv » devient « --releve a.csv b.csv » ; b.csv était ignoré en silence.
  assert.throws(() => lireArguments([...BASE, "--releve", "a.csv", "b.csv"]), /argument inattendu « b\.csv »/);
  assert.throws(() => lireArguments(["x.csv", ...BASE, "--releve", "a.csv"]), /argument inattendu « x\.csv »/);
  assert.throws(() => lireArguments([...BASE, "--releve", "a.csv", "--releve-vide", "oui"]), /argument inattendu « oui »/);
  assert.throws(() => lireArguments([...BASE, "--releve", "a.csv", "--tolerance", "600"]), /option inconnue « --tolerance »/);
  assert.throws(() => lireArguments([...BASE, "--releve=a.csv"]), /option inconnue/);
  assert.throws(() => lireArguments([...BASE, "--releve", "a.csv", "--jour", "2026-11-21"]), /--jour.*plus d'une fois/);
  assert.throws(() => lireArguments([...BASE, "--releve"]), /--releve.*valeur/);
  assert.throws(() => lireArguments([...BASE, "--releve", "--echec", "FAILED"]), /--releve.*valeur/);
  assert.throws(() => lireArguments(BASE), /--releve : au moins un fichier/);
  assert.throws(() => lireArguments([...BASE.slice(2), "--releve", "a.csv"]), /--proprietaire manquante/);
});

test("audit 1 et 2 de bout en bout, sans base : code 2 avant toute connexion", async () => {
  const d = mkdtempSync(join(tmpdir(), "wakatnet-rapprochement-audit-"));
  writeFileSync(join(d, "a.csv"), "reference;montant;date;statut\nwk_a;200;2026-11-20T10:00:00Z;SUCCESS\n");
  writeFileSync(join(d, "entete.csv"), "reference;montant;date;statut\n");
  const lancer = async (...args: string[]) => {
    try {
      await promisify(execFile)("node", [join(process.cwd(), "src/rapprochement.ts"), "--proprietaire", "1", "--jour", J,
        "--releve-du", "2026-11-19T00:00:00Z", "--releve-au", "2026-11-21T08:00:00Z", "--reussi", "SUCCESS", ...args],
        { env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" } });
      return { code: 0, sortie: "" };
    } catch (e) {
      const x = e as { code: number; stdout: string; stderr: string };
      return { code: x.code, sortie: x.stdout + x.stderr };
    }
  };
  const glob = await lancer("--releve", join(d, "a.csv"), join(d, "entete.csv"));
  assert.equal(glob.code, 2, glob.sortie);
  assert.match(glob.sortie, /argument inattendu/);
  const vide = await lancer("--releve", join(d, "entete.csv"));
  assert.equal(vide.code, 2, vide.sortie);
  assert.match(vide.sortie, /aucune ligne de données/);
  // --releve-vide franchit la lecture : l'outil s'arrête ensuite sur l'adresse de la base absente (code 2, pas 0).
  const declare = await lancer("--releve", join(d, "entete.csv"), "--releve-vide");
  assert.equal(declare.code, 2, declare.sortie);
  assert.match(declare.sortie, /WAKATNET_RAPPROCHEMENT_DATABASE_URL manquant/);
});

test("audit 3 : débits hors paiement de plus de 10 % de l'encaissement sous sa référence : à instruire", () => {
  const DEP = "3f2a9c1e-0b4d-4e8a-9c2f-1a2b3c4d5e6f";
  const PP = { reference: "Transaction ID", montant: "Amount", date: "Creation date", statut: "Type", reussi: ["Deposit"], echec: [],
               hors: ["Deposit pass through fees", "Deposit PawaPay fees", "Refund"] };
  const ENT = "Creation date,MSISDN,Transaction ID,Amount,MNO,Type,Balance,Reason,Metadata\n";
  const dep = `2026-11-20 10:00:00,226,${DEP},200.00,ORANGE_BFA,Deposit,0,,\n`;
  const p = b("wk_P", 200, T(10, 0, 5), "SUCCEEDED", DEP);
  const avec = (...lignes: string[]) => rapprocher(J, [p], lireReleve(ENT + dep + lignes.join(""), PP, J), [c(p)]);
  // Un remboursement ajouté à tort à --hors-paiement, sous la référence d'un dépôt PRÉSENT au relevé.
  const rembourse = avec(`2026-11-20 12:00:00,226,${DEP},-200.00,ORANGE_BFA,Refund,0,,\n`);
  assert.deepEqual(cats(rembourse), ["concordant:wk_P", `hors_paiement_excessif:${DEP}`]);
  assert.equal(rembourse.ecartNul, false);
  assert.ok(ECARTS_A_INSTRUIRE.includes("hors_paiement_excessif"));
  // Frais normaux : sous le seuil ; exactement 10 % : sous le seuil ; un centime de plus : au-dessus (somme de plusieurs lignes).
  assert.equal(avec(`2026-11-20 10:00:00,226,${DEP},-3.50,,Deposit pass through fees,0,,\n`, `2026-11-20 10:00:00,226,${DEP},-2,,Deposit PawaPay fees,0,,\n`).ecartNul, true);
  assert.equal(avec(`2026-11-20 10:00:00,226,${DEP},-12.00,,Deposit pass through fees,0,,\n`, `2026-11-20 10:00:00,226,${DEP},-8,,Deposit PawaPay fees,0,,\n`).ecartNul, true);
  assert.deepEqual(cats(avec(`2026-11-20 10:00:00,226,${DEP},-12.01,,Deposit pass through fees,0,,\n`, `2026-11-20 10:00:00,226,${DEP},-8,,Deposit PawaPay fees,0,,\n`)),
    ["concordant:wk_P", `hors_paiement_excessif:${DEP}`]);
});

test("audit 5 : un texte venu du relevé ne sort jamais de sa ligne du rapport (Markdown, HTML, contrôle)", () => {
  const piege = "x`<!--|\u001b[2J\u0007";
  const x = rapprocher(J, [], [r(piege, 100), { ...r("", 0), hors: "FRAIS|<b>`", centimes: -100n, brut: "a" }], []);
  const rapport = rapportMarkdown(x, "1", { du: T(0, 0, 0, 19), au: T(8, 0, 0, 21) });
  const ligne = rapport.split("\n").find((l) => l.includes("absent_de_la_base") || l.startsWith("- "))!;
  assert.ok(ligne, rapport);
  for (const interdit of ["`", "<", ">", "|", "\u001b", "\u0007"]) assert.ok(!ligne.includes(interdit), `${JSON.stringify(interdit)} dans ${ligne}`);
  assert.doesNotMatch(rapport, /<!--/);
  assert.doesNotMatch(rapport, /<b>/);
  assert.match(rapport, /\| FRAIS&#124;&lt;b&gt;&#96; \| 1 \| -1\.00 F \|/);
  assert.match(rapport, /Concordants : 0\./, "la fin du rapport reste visible");
});

test("audit 6 : un paiement REFUNDED confirmé le jour J est toujours à instruire (rembourse), avec ou sans ligne au relevé", () => {
  const p = b("wk_R", 200, T(12), "REFUNDED");
  const x = rapprocher(J, [p], [], []);
  assert.deepEqual(cats(x), ["rembourse:wk_R"]);
  assert.equal(x.ecartNul, false);
  assert.ok(ECARTS_A_INSTRUIRE.includes("rembourse"));
  assert.deepEqual(cats(rapprocher(J, [p], [r("wk_R", 200)], [])), ["rembourse:wk_R"], "listé une fois, pas aussi en succès au relevé");
  assert.deepEqual(cats(rapprocher(J, [b("wk_S", 200, T(12, 0, 0, 18), "REFUNDED")], [], [])), [], "confirmé un autre jour : rapproché ce jour-là");
});

test("couverture : le relevé doit couvrir de J − 1 à J + 1 jour + 10 min", () => {
  verifierCouverture(J, { du: T(0, 0, 0, 19), au: T(0, 10, 0, 21) });
  assert.throws(() => verifierCouverture(J, { du: T(0, 0, 0, 20), au: T(8, 0, 0, 21) }), /relevé insuffisant/);
  assert.throws(() => verifierCouverture(J, { du: T(0, 0, 0, 19), au: T(0, 5, 0, 21) }), /relevé insuffisant/);
});

test("outil de bout en bout : vrai paiement confirmé par webhook ; juste → 0, montant faux → 1, couverture ou statut invalides → 2", async () => {
  await avecApp(async (app) => {
    const v = await vendeur(app, "rapprochement");
    const a = await app.paiement!.creer({ sitePublic: v.publicId, planId: BigInt(v.plan), operateur: "moov_bf", numero: numero("00"),
                                          jetonAppareil: jeton(), soumission: soumission() });
    if (a.statut !== "cree") assert.fail(a.statut);
    await attendreStatut(a.reference, "SUCCEEDED");
    const [p] = await sql<{ montant: string; le: Date; jour: string }>(URL_ADMIN,
      "SELECT montant::text, confirme_le AS le, to_char(confirme_le AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS jour FROM app.payment WHERE reference = $1", [a.reference]);
    const jour0 = Date.parse(`${p.jour}T00:00:00Z`);
    // Audit 4 : l'outil tourne sous le rôle dédié wk_rapprochement (migration 0038), jamais en superutilisateur. Mot de passe
    // jetable, tiré pour ce test (en production : WAKATNET_PG_RAPPROCHEMENT_PASSWORD, posé par migrer.sh).
    const mdp = randomBytes(18).toString("hex");
    await sql(URL_ADMIN, `ALTER ROLE wk_rapprochement PASSWORD '${mdp}'`);
    const u = new URL(URL_ADMIN);
    u.username = "wk_rapprochement"; u.password = mdp;
    const URL_RAPPRO = u.toString();
    assert.deepEqual(await sql(URL_RAPPRO, "SHOW default_transaction_read_only"), [{ default_transaction_read_only: "on" }]);
    await assert.rejects(sql(URL_RAPPRO, "SELECT reference FROM app.payment LIMIT 1"), /permission denied/);
    await assert.rejects(sql(URL_RAPPRO, "SELECT 1 FROM ledger.ecriture LIMIT 1"), /permission denied/);
    const du = new Date(jour0 - 86_400_000).toISOString(), au = new Date(jour0 + 2 * 86_400_000).toISOString();
    const d = mkdtempSync(join(tmpdir(), "wakatnet rapprochement é-"));   // espace et accent : relecture I4
    const lancer = async (montant: string, statut = "SUCCESS", couvertureAu = au) => {
      writeFileSync(join(d, "releve.csv"), `reference;montant;date;statut\n${a.reference};${montant};${p.le.toISOString()};${statut}\n`);
      try {
        const { stdout } = await promisify(execFile)("node", [join(process.cwd(), "src/rapprochement.ts"), "--proprietaire", v.tenant, "--jour", p.jour,
          "--releve", join(d, "releve.csv"), "--releve-du", du, "--releve-au", couvertureAu, "--reussi", "SUCCESS", "--echec", "FAILED"],
          { env: { ...process.env, WAKATNET_RAPPROCHEMENT_DATABASE_URL: URL_RAPPRO, NODE_NO_WARNINGS: "1", TZ: "Europe/Paris" } });
        return { code: 0, sortie: stdout };
      } catch (e) {
        const x = e as { code: number; stdout: string; stderr: string };
        return { code: x.code, sortie: x.stdout + x.stderr };
      }
    };
    const juste = await lancer(p.montant);
    assert.equal(juste.code, 0, juste.sortie);
    assert.match(juste.sortie, /ÉCART NUL/);
    assert.match(juste.sortie, /Commissions au grand livre \| \| 20 F/);
    assert.match(juste.sortie, /Taux appliqués \| \| 1000 bps/);
    const faux = await lancer(String(Number(p.montant) + 5));
    assert.equal(faux.code, 1, faux.sortie);
    assert.match(faux.sortie, /montant_different/);
    assert.equal((await lancer(p.montant, "COMPLETED")).code, 2, "statut inconnu : entrée invalide");
    const court = await lancer(p.montant, "SUCCESS", new Date(jour0 + 86_400_000).toISOString());
    assert.equal(court.code, 2, court.sortie);
    assert.match(court.sortie, /relevé insuffisant/);

    // Profil pawaPay (journal du portefeuille) : rapproché par la référence du fournisseur, frais et retrait totalisés,
    // sans --echec ; un ajustement manuel, type non déclaré, arrête l'outil (code 2).
    const [f] = await sql<{ rf: string }>(URL_ADMIN, "SELECT reference_fournisseur AS rf FROM app.payment WHERE reference = $1", [a.reference]);
    assert.ok(f.rf, "le paiement porte la référence du fournisseur");
    const pawapay = async (extra = "") => {
      const le = p.le.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
      writeFileSync(join(d, "pawapay.csv"), "Creation date,MSISDN,Transaction ID,Amount,MNO,Type,Balance,Reason,Metadata\n"
        + `${le},22670000000,${f.rf},${p.montant}.00,MOOV_BFA,Deposit,0,,\n${le},22670000000,${f.rf},-2.50,MOOV_BFA,Deposit PawaPay fees,0,,\n`
        + `${le},,,-100,,Withdrawal,0,Règlement,\n${extra}`);
      try {
        const { stdout } = await promisify(execFile)("node", [join(process.cwd(), "src/rapprochement.ts"), "--proprietaire", v.tenant, "--jour", p.jour,
          "--releve", join(d, "pawapay.csv"), "--releve-du", du, "--releve-au", au, "--col-reference", "Transaction ID", "--col-montant", "Amount",
          "--col-date", "Creation date", "--col-statut", "Type", "--reussi", "Deposit", "--hors-paiement", "Deposit PawaPay fees,Withdrawal"],
          { env: { ...process.env, WAKATNET_RAPPROCHEMENT_DATABASE_URL: URL_RAPPRO, NODE_NO_WARNINGS: "1" } });
        return { code: 0, sortie: stdout };
      } catch (e) {
        const x = e as { code: number; stdout: string; stderr: string };
        return { code: x.code, sortie: x.stdout + x.stderr };
      }
    };
    const pp = await pawapay();
    assert.equal(pp.code, 0, pp.sortie);
    assert.match(pp.sortie, /ÉCART NUL/);
    assert.match(pp.sortie, /\| DEPOSIT PAWAPAY FEES \| 1 \| -2\.50 F \|/);
    assert.match(pp.sortie, /\| WITHDRAWAL \| 1 \| -100\.00 F \|/);
    const ajuste = await pawapay(`${p.le.toISOString()},,,500,,Adjustment - Collections received,0,Correction,\n`);
    assert.equal(ajuste.code, 2, ajuste.sortie);
    assert.match(ajuste.sortie, /Adjustment - Collections received/);
  });
});

test("relecture R4 (I-1) : une ligne hors paiement SANS référence n'est admise que pour les types déclarés (retraits) ; sinon à instruire", () => {
  const DEP = "3f2a9c1e-0b4d-4e8a-9c2f-1a2b3c4d5e6f";
  const ENT = "Creation date,MSISDN,Transaction ID,Amount,MNO,Type,Balance,Reason,Metadata\n";
  const PP = { reference: "Transaction ID", montant: "Amount", date: "Creation date", statut: "Type", reussi: ["Deposit"], echec: [],
               hors: ["Deposit PawaPay fees", "Withdrawal", "Refund", "Adjustment - Other"] };
  const dep = `2026-11-20 10:00:00,226,${DEP},200.00,ORANGE_BFA,Deposit,0,,\n`;
  const p = b("wk_P", 200, T(10, 0, 5), "SUCCEEDED", DEP);
  // Remboursement intégral, ou reprise par ajustement, sans Transaction ID : avant, simplement totalisé → « ÉCART NUL ».
  for (const ligne of ["2026-11-20 11:00:00,,,-200.00,,Refund,0,,\n", "2026-11-20 11:00:00,,,-200,,Adjustment - Other,0,Reprise,\n"]) {
    const x = rapprocher(J, [p], lireReleve(ENT + dep + ligne, PP, J), [c(p)]);
    assert.equal(x.ecartNul, false, ligne);
    assert.ok(cats(x).some((k) => k.startsWith("hors_paiement_sans_reference:")), `${ligne} → ${cats(x)}`);
  }
  // Retrait (règlement vers la banque) : sans référence par nature, déclaré par défaut → totalisé, aucun écart.
  const retrait = rapprocher(J, [p], lireReleve(ENT + dep + "2026-11-20 18:00:00,,,-100,,Withdrawal,0,Règlement,\n", PP, J), [c(p)]);
  assert.deepEqual(cats(retrait), ["concordant:wk_P"]);
  // Liste explicite : un type sans référence admis doit être aussi hors paiement.
  assert.throws(() => lireReleve(ENT, { ...PP, horsSansReference: ["Top up"] }, J), /--hors-sans-reference/);
});

test("relecture R4 (M-4) : une référence en forme de lien ou d'image Markdown est neutralisée dans le rapport", async () => {
  const { texteMd } = await import("../src/rapprochement.ts");
  for (const r of ["[x](https://exemple.invalid)", "![](https://exemple.invalid/p.png)"]) {
    const t = texteMd(r);
    assert.ok(!t.includes("[") && !t.includes("]"), t);
  }
});
