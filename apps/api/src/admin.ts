// WAKATNET — outils du super-admin (phase 4, ticket 06 ; ADR 0014 §3, §4).
// Ticket : .scratch/phase-4-exploitation/issues/06-super-admin.md
// Toutes les routes exigent un super-admin dont la session a validé son TOTP (garde « admin »).
// Chaque action est inscrite au journal d'audit par la fonction SQL appelée.
import type { FastifyInstance } from "fastify";
import { garde } from "./auth.ts";
import type { Base } from "./base.ts";
import { periode } from "./exploitation.ts";
import { estIdentifiant } from "./identifiant.ts";

export function routesAdmin(app: FastifyInstance, base: Base): void {
  app.register(async (adm) => {
    adm.addHook("onRequest", garde(base, "admin"));

    adm.get<{ Querystring: Record<string, string> }>("/admin/v1/proprietaires", async (req, rep) => {
      const p = periode(req.query);
      if (p === null) return rep.code(422).send({ erreur: "période invalide" });
      const l = await base.$queryRaw<{ tenant_id: bigint; nom: string; suspendu: boolean; commission_bps: number; plafond_decouvert: bigint;
        solde_credits_xof: bigint; ventes_en_ligne_xof: bigint; commissions_xof: bigint; frais_papier_xof: bigint }[]>`
        SELECT * FROM app.admin_proprietaires(${p.debut}, ${p.fin})`;
      return l.map((x) => ({ id: x.tenant_id.toString(), nom: x.nom, suspendu: x.suspendu, commission_bps: x.commission_bps,
        plafond_decouvert_xof: Number(x.plafond_decouvert), solde_credits_xof: Number(x.solde_credits_xof),
        ventes_en_ligne_xof: Number(x.ventes_en_ligne_xof), commissions_xof: Number(x.commissions_xof), frais_papier_xof: Number(x.frais_papier_xof) }));
    });

    // Rechargement des crédits : idempotent sur la référence (celle du reçu Mobile Money, par exemple).
    adm.post<{ Params: { id: string }; Body: { montant_xof?: unknown; reference?: unknown } }>("/admin/v1/proprietaires/:id/recharges", async (req, rep) => {
      if (!estIdentifiant(req.params.id)) return rep.code(404).send({ erreur: "propriétaire inconnu" });
      const { montant_xof, reference } = req.body ?? {};
      if (typeof montant_xof !== "number" || !Number.isSafeInteger(montant_xof) || montant_xof <= 0 || montant_xof > 100_000_000) {
        return rep.code(422).send({ erreur: "montant en francs entiers, de 1 à 100 000 000" });
      }
      if (typeof reference !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(reference)) return rep.code(422).send({ erreur: "référence invalide" });
      try {
        await base.$queryRaw`SELECT app.admin_recharger(${BigInt(req.params.id)}, ${BigInt(montant_xof)}, ${reference}, ${req.utilisateur!.id})`;
      } catch (e) {
        if (/propriétaire inconnu/.test(String(e))) return rep.code(404).send({ erreur: "propriétaire inconnu" });
        if (/déjà écrite avec un autre contenu/.test(String(e))) return rep.code(409).send({ erreur: "référence déjà utilisée pour un autre montant" });
        throw e;
      }
      return rep.code(201).send({ ok: true });
    });

    adm.put<{ Params: { id: string }; Body: { suspendu?: unknown; commission_bps?: unknown; plafond_decouvert_xof?: unknown } }>(
      "/admin/v1/proprietaires/:id", async (req, rep) => {
        if (!estIdentifiant(req.params.id)) return rep.code(404).send({ erreur: "propriétaire inconnu" });
        const b = req.body ?? {};
        if (b.suspendu !== undefined && typeof b.suspendu !== "boolean") return rep.code(422).send({ erreur: "suspendu : booléen" });
        const ent = (x: unknown, max: number) => x === undefined || (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 && x <= max);
        if (!ent(b.commission_bps, 10_000)) return rep.code(422).send({ erreur: "commission en points de base, de 0 à 10 000" });
        if (!ent(b.plafond_decouvert_xof, 10_000_000)) return rep.code(422).send({ erreur: "plafond en francs entiers" });
        const [{ ok }] = await base.$queryRaw<{ ok: boolean }[]>`
          SELECT app.admin_regler(${BigInt(req.params.id)}, ${b.suspendu ?? null}::boolean, ${(b.commission_bps as number | undefined) ?? null}::integer,
                                  ${b.plafond_decouvert_xof === undefined ? null : BigInt(b.plafond_decouvert_xof as number)}::bigint,
                                  ${req.utilisateur!.id}) AS ok`;
        if (!ok) return rep.code(404).send({ erreur: "propriétaire inconnu" });
        return { ok: true };
      });
  });
}
