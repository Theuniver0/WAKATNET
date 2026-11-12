// WAKATNET — import des tickets Mikhmon (SPEC §6.3, ADR 0012 §10).
// Ticket : .scratch/phase-2-multi-proprietaires/issues/07-import-mikhmon.md
//
// CSV d'utilisateurs hotspot (colonnes name, password, profile ; les autres sont ignorées) et
// correspondance « profil → forfait » fournie par le propriétaire. Un rapport par ligne ; le
// rejeu du même fichier n'importe rien de plus (doublons). Les codes ne sont jamais journalisés.
import type { FastifyInstance } from "fastify";
import type { Base } from "./base.ts";
import { enTantQue } from "./base.ts";
import { estIdentifiant } from "./identifiant.ts";

export const LIGNES_MAX = 20_000;

export class CsvInvalide extends Error {}

/** CSV RFC 4180 (guillemets doublés, virgule ou point-virgule détecté sur l'en-tête). */
export function lireCsv(texte: string): string[][] {
  const t = texte.replace(/^﻿/, "");
  const premiere = t.split(/\r?\n/, 1)[0] ?? "";
  const sep = (premiere.match(/;/g)?.length ?? 0) > (premiere.match(/,/g)?.length ?? 0) ? ";" : ",";
  const lignes: string[][] = [];
  let champ = "";
  let ligne: string[] = [];
  let entre = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (entre) {
      if (c === '"' && t[i + 1] === '"') { champ += '"'; i++; }
      else if (c === '"') entre = false;
      else champ += c;
    } else if (c === '"' && champ === "") entre = true;
    else if (c === sep) { ligne.push(champ); champ = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      ligne.push(champ); champ = "";
      if (ligne.some((x) => x !== "")) lignes.push(ligne);
      ligne = [];
    } else champ += c;
  }
  if (entre) throw new CsvInvalide("guillemet non fermé");
  ligne.push(champ);
  if (ligne.some((x) => x !== "")) lignes.push(ligne);
  return lignes;
}

export type Statut = "importe" | "doublon" | "refuse";
export type LigneRapport = { ligne: number; code?: string; statut: Statut; motif?: string };

/** Contrôles sans base : rend le code à importer et son forfait, ou le motif de refus. */
export function examiner(name: string, password: string, profil: string, correspondance: Map<string, bigint>):
  { code: string; plan: bigint } | { motif: string } {
  const n = name.trim();
  if (!/^[0-9A-Za-z]{4,32}$/.test(n)) return { motif: "code hors [0-9A-Za-z] ou longueur hors 4 à 32" };
  if (password.trim().toUpperCase() !== n.toUpperCase()) return { motif: "identifiant et mot de passe différents" };
  const plan = correspondance.get(profil.trim());
  if (plan === undefined) return { motif: `profil « ${profil.trim()} » sans forfait correspondant` };
  return { code: n.toUpperCase(), plan };
}

export function routesImport(app: FastifyInstance, base: Base): void {
  app.post<{ Body: { csv?: unknown; correspondance?: unknown } }>("/v1/imports/mikhmon",
    { bodyLimit: 4 * 1024 * 1024 }, async (req, rep) => {
      const { csv, correspondance } = req.body ?? {};
      if (typeof csv !== "string") return rep.code(422).send({ erreur: "csv : texte attendu" });
      if (typeof correspondance !== "object" || correspondance === null || Array.isArray(correspondance)) {
        return rep.code(422).send({ erreur: "correspondance : objet { profil: identifiant du forfait } attendu" });
      }
      const corresp = new Map<string, bigint>();
      for (const [profil, plan] of Object.entries(correspondance)) {
        if (!estIdentifiant(plan)) return rep.code(422).send({ erreur: `correspondance : forfait invalide pour « ${profil} »` });
        corresp.set(profil.trim(), BigInt(plan));
      }
      let lignes: string[][];
      try {
        lignes = lireCsv(csv);
      } catch (e) {
        return rep.code(422).send({ erreur: `csv : ${(e as Error).message}` });
      }
      if (lignes.length < 2) return rep.code(422).send({ erreur: "csv : en-tête et au moins une ligne" });
      if (lignes.length - 1 > LIGNES_MAX) return rep.code(422).send({ erreur: `csv : ${LIGNES_MAX} lignes au plus` });
      const entete = lignes[0].map((x) => x.trim().toLowerCase());
      const col = { name: entete.indexOf("name"), password: entete.indexOf("password"), profile: entete.indexOf("profile") };
      if (col.name < 0 || col.password < 0 || col.profile < 0) return rep.code(422).send({ erreur: "csv : colonnes name, password et profile exigées" });

      // Contrôles sans base d'abord, puis UN seul appel SQL pour tout le lot (ticket 07, revue).
      const rapport: (LigneRapport | null)[] = [];
      const aImporter: { indice: number; code: string; plan: bigint }[] = [];
      for (let i = 1; i < lignes.length; i++) {
        const l = lignes[i];
        const x = examiner(l[col.name] ?? "", l[col.password] ?? "", l[col.profile] ?? "", corresp);
        if ("motif" in x) rapport.push({ ligne: i + 1, statut: "refuse", motif: x.motif });
        else { rapport.push(null); aImporter.push({ indice: i - 1, code: x.code, plan: x.plan }); }
      }
      await enTantQue(base, req.tenantId, async (tx) => {
        const resultats = aImporter.length === 0 ? [] : await tx.$queryRaw<{ rang: number; statut: string }[]>`
          SELECT rang, statut FROM app.voucher_importer(${aImporter.map((x) => x.plan)}::bigint[],
                                                        ${aImporter.map((x) => x.code)}::text[])`;
        for (const r of resultats) {
          const x = aImporter[r.rang - 1];
          rapport[x.indice] = r.statut === "importe" || r.statut === "doublon"
            ? { ligne: x.indice + 2, code: x.code, statut: r.statut }
            : { ligne: x.indice + 2, code: x.code, statut: "refuse", motif: r.statut === "forfait_inconnu" ? "forfait inconnu" : "code invalide" };
        }
        const n = (st: Statut) => rapport.filter((y) => y?.statut === st).length;
        await tx.audit_log.create({
          data: { tenant_id: req.tenantId, acteur: `tenant:${req.tenantId}`, action: "import_mikhmon", objet: "voucher",
                  details: { importes: n("importe"), doublons: n("doublon"), refuses: n("refuse") } },
        });
      });
      if (rapport.some((y) => y === null)) throw new Error("import : ligne sans résultat");
      const lignesRapport = rapport as LigneRapport[];
      const compte = (st: Statut) => lignesRapport.filter((y) => y.statut === st).length;
      return {
        importes: compte("importe"), doublons: compte("doublon"), refuses: compte("refuse"),
        // Codes de moins de 8 caractères : plus faciles à deviner que ceux de la plateforme (ADR 0012 §10).
        courts: lignesRapport.filter((y) => y.statut === "importe" && (y.code?.length ?? 0) < 8).length,
        lignes: lignesRapport,
      };
    });
}
