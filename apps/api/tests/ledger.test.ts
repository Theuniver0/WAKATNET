// Grand livre (SPEC §8.1, §8.4 ; ADR 0013 §3 à §5 ; A1 à A4, A6) : tests de PROPRIÉTÉS sur
// PostgreSQL réel. Ticket : .scratch/phase-3-portail-paiement/issues/02-grand-livre.md
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { randomBytes } from "node:crypto";
import fc from "fast-check";
import pg from "pg";
import { proprietaire, sql, URL_ADMIN } from "./aide.ts";

let client: pg.Client;
/** Clés propres à cette exécution : les tests repassent sur une base déjà remplie. */
const RUN = randomBytes(4).toString("hex");
const tenants: string[] = [];

before(async () => {
  for (let i = 0; i < 3; i++) tenants.push((await proprietaire(`grand livre ${i}`)).tenant);
});

async function avecClient<T>(f: (c: pg.Client) => Promise<T>): Promise<T> {
  client = new pg.Client({ connectionString: URL_ADMIN });
  await client.connect();
  try { return await f(client); } finally { await client.end(); }
}

type Ligne = { compte: string; debit?: number; credit?: number };
type Op = { cle: string; nature: string; objet: string; lignes: Ligne[] };

const credits = (t: string) => `proprietaire:${t}:credits`;

/** Opérations du mode A (ADR 0013 §4), montants entiers positifs. */
function operation(prefixe: string): fc.Arbitrary<Op> {
  const montant = fc.integer({ min: 1, max: 5_000_000 });
  const tenant = fc.constantFrom(...tenants);
  const cle = fc.integer({ min: 0, max: 40 }).map((n) => `${prefixe}:${n}`);
  return fc.oneof(
    fc.record({ cle, t: tenant, m: montant }).map(({ cle, t, m }) => ({
      cle: `${cle}:recharge`, nature: "recharge", objet: `recharge:${cle.replace(/:/g, "_")}`,
      lignes: [{ compte: "plateforme:tresorerie", debit: m }, { compte: credits(t), credit: m }] })),
    fc.record({ cle, t: tenant, m: montant }).map(({ cle, t, m }) => ({
      cle: `${cle}:commission`, nature: "commission", objet: `paiement:${cle.replace(/:/g, "_")}`,
      lignes: [{ compte: credits(t), debit: m }, { compte: "plateforme:produit:commission", credit: m }] })),
    fc.record({ cle, t: tenant, m: montant }).map(({ cle, t, m }) => ({
      cle: `${cle}:frais`, nature: "frais_papier", objet: `voucher:${cle.replace(/:/g, "_")}`,
      lignes: [{ compte: credits(t), debit: m }, { compte: "plateforme:produit:frais_papier", credit: m }] })),
  );
}

async function ecrire(c: pg.Client, o: Op): Promise<string> {
  const r = await c.query("SELECT ledger.ecrire($1, $2, $3, NULL, NULL, $4::jsonb)::text AS id",
                          [o.cle, o.nature, o.objet, JSON.stringify(o.lignes)]);
  return r.rows[0].id;
}

async function solde(c: pg.Client, code: string): Promise<bigint> {
  return BigInt((await c.query("SELECT ledger.solde($1)::text AS s", [code])).rows[0].s);
}

/** Modèle : la PREMIÈRE écriture d'une clé compte ; les suivantes (même contenu) ne comptent pas. */
function modele(ops: Op[]): Map<string, bigint> {
  const vues = new Map<string, Op>();
  for (const o of ops) if (!vues.has(o.cle)) vues.set(o.cle, o);
  const soldes = new Map<string, bigint>();
  const sens = (code: string) => (code === "plateforme:tresorerie" ? 1n : -1n); // débit : +d −c ; crédit : +c −d
  for (const o of vues.values()) {
    for (const l of o.lignes) {
      const d = BigInt(l.debit ?? 0), cr = BigInt(l.credit ?? 0);
      soldes.set(l.compte, (soldes.get(l.compte) ?? 0n) + sens(l.compte) * (d - cr));
    }
  }
  return soldes;
}

let passe = 0;
test("propriété : soldes = modèle ; doublons de clé sans effet ; Σ débits = Σ crédits partout", async () => {
  await avecClient(async (c) => {
    await fc.assert(fc.asyncProperty(fc.array(operation("x"), { minLength: 1, maxLength: 30 }), async (ops0) => {
      passe++;
      // Clés propres à cette exécution ; une même clé ne porte qu'un contenu (sinon : conflit, testé à part).
      const premier = new Map<string, Op>();
      const ops = ops0.map((o) => ({ ...o, cle: `${RUN}:p${passe}:${o.cle}`, objet: o.objet.replace(":", `:${RUN}_p${passe}_`) }))
        .map((o) => { if (!premier.has(o.cle)) premier.set(o.cle, o); return premier.get(o.cle)!; });
      const comptes = [...new Set(ops.flatMap((o) => o.lignes.map((l) => l.compte)))];
      const avant = new Map<string, bigint>();
      for (const k of comptes) avant.set(k, await solde(c, k));
      const ids = new Map<string, string>();
      for (const o of ops) {
        const id = await ecrire(c, o);
        if (ids.has(o.cle)) assert.equal(id, ids.get(o.cle), "même clé : même transaction rendue");
        ids.set(o.cle, id);
      }
      const attendu = modele(ops);
      for (const k of comptes) assert.equal(await solde(c, k) - avant.get(k)!, attendu.get(k) ?? 0n, k);
      // Rejeu complet du journal : aucune ligne de plus, mêmes soldes.
      const n = (await c.query("SELECT count(*)::int AS n FROM ledger.ecriture")).rows[0].n;
      for (const o of ops) await ecrire(c, o);
      assert.equal((await c.query("SELECT count(*)::int AS n FROM ledger.ecriture")).rows[0].n, n);
      for (const k of comptes) assert.equal(await solde(c, k) - avant.get(k)!, attendu.get(k) ?? 0n, `rejeu ${k}`);
    }), { numRuns: 60 });
    const glob = await c.query(`SELECT sum(debit)::text AS d, sum(credit)::text AS c FROM ledger.ecriture`);
    assert.equal(glob.rows[0].d, glob.rows[0].c, "Σ débits = Σ crédits, globalement");
    const desequilibres = await c.query(`SELECT transaction_id FROM ledger.ecriture GROUP BY 1
                                         HAVING sum(debit) <> sum(credit) OR count(*) < 2`);
    assert.equal(desequilibres.rowCount, 0, "Σ débits = Σ crédits, par transaction");
  });
});

test("propriété : toute écriture déséquilibrée est refusée et ne laisse rien", async () => {
  await avecClient(async (c) => {
    let i = 0;
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({ debit: fc.boolean(), m: fc.integer({ min: 1, max: 1_000_000 }) }), { minLength: 1, maxLength: 5 })
        .filter((ls) => ls.reduce((s, l) => s + (l.debit ? l.m : -l.m), 0) !== 0 || ls.length < 2),
      async (ls) => {
        i++;
        const lignes = ls.map((l, k) => ({ compte: k % 2 ? "plateforme:tresorerie" : credits(tenants[0]), [l.debit ? "debit" : "credit"]: l.m }));
        const avant = (await c.query("SELECT count(*)::int AS n FROM ledger.transaction")).rows[0].n;
        await assert.rejects(c.query("SELECT ledger.ecrire($1, 'correction', 'transaction:1', NULL, NULL, $2::jsonb)",
                                     [`desequilibre:${i}:${Date.now()}`, JSON.stringify(lignes)]));
        assert.equal((await c.query("SELECT count(*)::int AS n FROM ledger.transaction")).rows[0].n, avant);
      }), { numRuns: 60 });
  });
});

test("même clé, autre contenu : refus (jamais un double comptage)", async () => {
  await avecClient(async (c) => {
    const o: Op = { cle: `conflit:${RUN}`, nature: "recharge", objet: `recharge:conflit_${RUN}`,
      lignes: [{ compte: "plateforme:tresorerie", debit: 100 }, { compte: credits(tenants[1]), credit: 100 }] };
    await ecrire(c, o);
    const avant = await solde(c, credits(tenants[1]));
    for (const autre of [
      { ...o, lignes: [{ compte: "plateforme:tresorerie", debit: 200 }, { compte: credits(tenants[1]), credit: 200 }] },
      { ...o, objet: `recharge:autre_${RUN}` },
      { ...o, lignes: [{ compte: "plateforme:tresorerie", debit: 100 }, { compte: credits(tenants[2]), credit: 100 }] },
    ]) await assert.rejects(ecrire(c, autre), /déjà écrite avec un autre contenu/);
    assert.equal(await solde(c, credits(tenants[1])), avant);
  });
});

test("lignes invalides refusées : montant nul, négatif, décimal, débit ET crédit, compte inconnu", async () => {
  await avecClient(async (c) => {
    const t = credits(tenants[0]);
    for (const [k, lignes] of [
      [{ compte: "plateforme:tresorerie", debit: 0 }, { compte: t, credit: 0 }],
      [{ compte: "plateforme:tresorerie", debit: -5 }, { compte: t, credit: -5 }],
      [{ compte: "plateforme:tresorerie", debit: 1.5 }, { compte: t, credit: 1.5 }],
      [{ compte: "plateforme:tresorerie", debit: 5, credit: 5 }, { compte: t, credit: 5 }],
      [{ compte: "plateforme:inconnu", debit: 5 }, { compte: t, credit: 5 }],
      [{ compte: "proprietaire:999999999:credits", debit: 5 }, { compte: "plateforme:tresorerie", credit: 5 }],
    ].map((l, i) => [i, l] as const)) {
      await assert.rejects(c.query("SELECT ledger.ecrire($1, 'correction', 'transaction:1', NULL, NULL, $2::jsonb)",
                                   [`invalide:${RUN}:${k}`, JSON.stringify(lignes)]), `${JSON.stringify(lignes)}`);
    }
  });
});

test("ajout seul : UPDATE, DELETE, TRUNCATE refusés, même au propriétaire des tables", async () => {
  await avecClient(async (c) => {
    await c.query("SET ROLE wakatnet_owner");
    for (const q of ["UPDATE ledger.ecriture SET debit = debit", "DELETE FROM ledger.ecriture", "DELETE FROM ledger.transaction",
                     "UPDATE ledger.compte SET sens = sens", "TRUNCATE ledger.ecriture", "TRUNCATE ledger.transaction CASCADE"]) {
      await assert.rejects(c.query(q), /ajout seul/, q);
    }
  });
});

test("aucun rôle de connexion n'a de droit sur ledger (seules des fonctions du propriétaire y écrivent)", async () => {
  const r = await sql<{ role: string; objet: string }>(URL_ADMIN, `
    SELECT r.rolname AS role, c.relname AS objet FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN pg_roles r
     WHERE n.nspname = 'ledger' AND r.rolcanlogin AND NOT r.rolsuper
       AND has_table_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')`);
  assert.deepEqual(r, []);
  const f = await sql<{ role: string; f: string }>(URL_ADMIN, `
    SELECT r.rolname AS role, p.proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     CROSS JOIN pg_roles r
     WHERE n.nspname = 'ledger' AND r.rolcanlogin AND NOT r.rolsuper AND has_function_privilege(r.oid, p.oid, 'EXECUTE')`);
  assert.deepEqual(f, []);
});

test("commission (§8.1, A4) : table de la spec, et arrondi au franc le plus proche, 0,5 vers le haut", async () => {
  const table: [number, number][] = [[100, 10], [150, 15], [200, 20], [300, 30], [500, 50], [1000, 100], [105, 11], [104, 10], [0, 0]];
  for (const [m, attendu] of table) {
    const [{ x }] = await sql<{ x: string }>(URL_ADMIN, "SELECT ledger.commission($1, 1000)::text AS x", [m]);
    assert.equal(Number(x), attendu, `${m} F`);
  }
  // Frais papier (ADR 0002) : max(10 %, 10 F) — 0 F, 50 F, 100 F, 300 F, 1 000 F.
  for (const [prix, frais] of [[0, 10], [50, 10], [100, 10], [300, 30], [1000, 100]]) {
    const [{ x }] = await sql<{ x: string }>(URL_ADMIN, "SELECT ledger.commission($1, 1000, 10)::text AS x", [prix]);
    assert.equal(Number(x), frais, `frais papier sur ${prix} F`);
  }
  await fc.assert(fc.asyncProperty(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.integer({ min: 0, max: 10000 }), async (m, bps) => {
    const [{ x }] = await sql<{ x: string }>(URL_ADMIN, "SELECT ledger.commission($1, $2)::text AS x", [m.toString(), bps]);
    // Référence exacte en BigInt : 2 × reste ≥ 10000 → on monte.
    const q = (m * BigInt(bps)) / 10000n, r = (m * BigInt(bps)) % 10000n;
    assert.equal(BigInt(x), 2n * r >= 10000n ? q + 1n : q);
  }), { numRuns: 200 });
  const [{ n }] = await sql<{ n: string | null }>(URL_ADMIN, "SELECT ledger.commission(-1, 1000)::text AS n");
  assert.equal(n, null, "montant négatif : pas de commission calculée");
});
