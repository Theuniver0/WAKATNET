// Mode B verrouillé et reversements : règle P10 (SPEC §7.4 ; ADR 0001 ; ADR 0014 §8, §9).
// Ticket : .scratch/phase-4-exploitation/issues/07-mode-b-p10.md
// Sans argent réel : MockProvider, coupures avant et après l'envoi (dernier chiffre du montant).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import fc from "fast-check";
import { MockProvider } from "../../../packages/payments/src/index.ts";
import { traiterReversement, tourReversements, type Reversement } from "../src/reversements.ts";
import type { Base } from "../src/base.ts";
import { avecApp, proprietaire, sql, URL_ADMIN, URL_API } from "./aide.ts";

const DEST = "70000000";
const ref = () => `po_${randomBytes(9).toString("base64url")}`;
const mock = new MockProvider("secret-reversements", null);

const drapeau = (v: boolean) => sql(URL_ADMIN, "UPDATE app.plateforme_parametre SET valeur = $1 WHERE cle = 'mode_b_autorise'", [v]);

/** Drapeau du mode B levé le temps du travail, puis rabaissé quoi qu'il arrive (tests en série). */
async function modeB<T>(travail: () => Promise<T>): Promise<T> {
  await drapeau(true);
  try { return await travail(); } finally { await drapeau(false); }
}

async function proprietaireModeB(nom: string): Promise<string> {
  const { tenant } = await proprietaire(nom);
  await sql(URL_ADMIN, "UPDATE app.tenant SET settlement_mode = 'B' WHERE id = $1", [tenant]);
  return tenant;
}

const creer = async (tenant: string, montant: number, reference = ref()) => {
  await sql(URL_API, "SELECT app.reversement_creer($1, $2, $3)", [tenant, montant, reference]);
  return reference;
};
const etat = async (reference: string) => (await sql<{ statut: string; envois: number }>(URL_ADMIN,
  "SELECT statut, envois FROM app.payout WHERE reference = $1", [reference]))[0];
const ligne = async (reference: string): Promise<Reversement> => (await sql<{ reference: string; montant: string; statut: string; envois: number }>(URL_ADMIN,
  "SELECT reference, montant::text, statut, envois FROM app.payout WHERE reference = $1", [reference]))
  .map((r) => ({ ...r, montant: BigInt(r.montant) }))[0];
const pas = (base: Base, r: Reversement) => traiterReversement(base, mock, r, DEST);

test("mode B verrouillé : bascule refusée tant que le drapeau est faux ; wk_api ne peut pas lever le drapeau", async () => {
  const { tenant } = await proprietaire("verrou B");
  await assert.rejects(sql(URL_ADMIN, "UPDATE app.tenant SET settlement_mode = 'B' WHERE id = $1", [tenant]), /mode B verrouillé/);
  await assert.rejects(sql(URL_API, "UPDATE app.plateforme_parametre SET valeur = true WHERE cle = 'mode_b_autorise'"), /permission denied/);
  await assert.rejects(sql(URL_API, "SELECT valeur FROM app.plateforme_parametre"), /permission denied/);
  await assert.rejects(sql(URL_API, "SELECT * FROM app.payout"), /permission denied/);
  await assert.rejects(creer(tenant, 1000), /réservé au mode B/);
  const [{ v }] = await sql<{ v: boolean }>(URL_ADMIN, "SELECT valeur AS v FROM app.plateforme_parametre WHERE cle = 'mode_b_autorise'");
  assert.equal(v, false);
});

test("cas normal : un tour, SUCCEEDED, un seul ordre reçu ; création idempotente sur la référence", async () => {
  await modeB(async () => {
    const tenant = await proprietaireModeB("reversement normal");
    await avecApp(async (_app, base) => {
      const r = await creer(tenant, 1000);
      await creer(tenant, 1000, r);
      assert.equal(await pas(base, await ligne(r)), "SUCCEEDED");
      assert.deepEqual(await etat(r), { statut: "SUCCEEDED", envois: 1 });
      assert.equal(mock.recus(r), 1);
    });
  });
});

test("P10, coupure APRÈS l'envoi : EN_DOUTE, puis verifyPayout « réussi » → SUCCEEDED sans renvoi", async () => {
  await modeB(async () => {
    const tenant = await proprietaireModeB("coupure après");
    await avecApp(async (_app, base) => {
      const r = await creer(tenant, 1007);
      assert.equal(await pas(base, await ligne(r)), "EN_DOUTE");
      assert.deepEqual(await etat(r), { statut: "EN_DOUTE", envois: 1 }, "écrit EN_DOUTE avant l'appel");
      assert.equal(mock.recus(r), 1);
      assert.equal(await pas(base, await ligne(r)), "SUCCEEDED");
      assert.deepEqual(await etat(r), { statut: "SUCCEEDED", envois: 1 }, "aucun renvoi");
      assert.equal(mock.recus(r), 1);
    });
  });
});

test("P10, coupure AVANT l'envoi : verifyPayout « inconnu » → un seul renvoi, puis SUCCEEDED", async () => {
  await modeB(async () => {
    const tenant = await proprietaireModeB("coupure avant");
    await avecApp(async (_app, base) => {
      const r = await creer(tenant, 1009);
      assert.equal(await pas(base, await ligne(r)), "EN_DOUTE");
      assert.equal(mock.recus(r), 0);
      assert.equal(await pas(base, await ligne(r)), "SUCCEEDED");
      assert.deepEqual(await etat(r), { statut: "SUCCEEDED", envois: 2 });
      assert.equal(mock.recus(r), 1);
      assert.equal(await pas(base, await ligne(r)), "SUCCEEDED", "statut final : plus rien n'est fait");
      assert.equal(mock.recus(r), 1);
    });
  });
});

test("gardes : un EN_DOUTE récent n'est pas repris ; le renvoi est une comparaison-échange", async () => {
  await modeB(async () => {
    const tenant = await proprietaireModeB("gardes");
    await avecApp(async (_app, base) => {
      const r = await creer(tenant, 1009);
      await pas(base, await ligne(r));
      for (const age of [120, 0]) {
        const repris = await tourReversements(base, mock, async () => DEST, age);
        assert.equal(repris[r], undefined, `EN_DOUTE de moins de 120 s : laissé de côté (âge demandé ${age} : plancher en base)`);
      }
      const [{ a }] = await sql<{ a: boolean }>(URL_API, "SELECT app.reversement_renvoi_permis($1, 1) AS a", [r]);
      const [{ b }] = await sql<{ b: boolean }>(URL_API, "SELECT app.reversement_renvoi_permis($1, 1) AS b", [r]);
      assert.deepEqual([a, b], [true, false], "deux traitements qui ont lu envois = 1 : un seul renvoie");
      await assert.rejects(sql(URL_API, "SELECT app.reversement_verdict($1, 'CREATED', NULL)", [r]), /verdict invalide/);
    });
  });
});

test("propriété P10 : quelle que soit la suite de tours et de coupures, au plus un ordre reçu par référence", async () => {
  await modeB(async () => {
    const tenant = await proprietaireModeB("propriété P10");
    await avecApp(async (_app, base) => {
      await fc.assert(fc.asyncProperty(
        fc.constantFrom(0, 7, 9),
        fc.array(fc.constantFrom(1, 2), { minLength: 3, maxLength: 6 }),   // 1 ou 2 traitements par tour
        async (scenario, tours) => {
          const r = await creer(tenant, 1000 + scenario);
          for (const n of tours) {
            const instantane = await ligne(r);                             // deux traitements partis du même état
            await Promise.all(Array.from({ length: n }, () => pas(base, instantane)));
            assert.ok(mock.recus(r) <= 1, `${r} : ${mock.recus(r)} ordres reçus`);
          }
          const fin = await etat(r);
          assert.equal(fin.statut, "SUCCEEDED");
          assert.equal(mock.recus(r), 1);
        }), { numRuns: 40 });
    });
  });
});

test("délai dépassé : la requête est ANNULÉE (pas d'ordre tardif), puis vérification « inconnu » et un seul renvoi", async () => {
  await modeB(async () => {
    const tenant = await proprietaireModeB("fournisseur lent");
    await avecApp(async (_app, base) => {
      const r = await creer(tenant, 1003);
      assert.equal(await traiterReversement(base, mock, await ligne(r), DEST, 50), "EN_DOUTE");
      await new Promise((x) => setTimeout(x, 100));
      assert.equal(mock.recus(r), 0, "requête annulée à l'expiration : l'ordre n'arrive jamais après coup");
      assert.equal(await traiterReversement(base, mock, await ligne(r), DEST, 50), "SUCCEEDED");
      assert.deepEqual(await etat(r), { statut: "SUCCEEDED", envois: 2 });
      assert.equal(mock.recus(r), 1);
    });
  });
});

test("refus du fournisseur à l'envoi : FAILED définitif, rien n'est payé ni renvoyé", async () => {
  await modeB(async () => {
    const tenant = await proprietaireModeB("refus");
    await avecApp(async (_app, base) => {
      const r = await creer(tenant, 1001);
      assert.equal(await pas(base, await ligne(r)), "FAILED");
      assert.equal(await pas(base, await ligne(r)), "FAILED");
      assert.deepEqual(await etat(r), { statut: "FAILED", envois: 1 });
      assert.equal(mock.recus(r), 0);
    });
  });
});

test("plafond : au-delà de 5 envois, plus aucun renvoi (décision humaine)", async () => {
  await modeB(async () => {
    const tenant = await proprietaireModeB("plafond envois");
    await avecApp(async (_app, base) => {
      const r = await creer(tenant, 1009);
      await pas(base, await ligne(r));
      await sql(URL_ADMIN, "UPDATE app.payout SET envois = 5 WHERE reference = $1", [r]);
      const [{ ok }] = await sql<{ ok: boolean }>(URL_API, "SELECT app.reversement_renvoi_permis($1, 5) AS ok", [r]);
      assert.equal(ok, false);
      assert.equal(await pas(base, await ligne(r)), "EN_DOUTE");
      assert.equal(mock.recus(r), 0);
    });
  });
});

test("drapeau rabaissé : plus de création ni de traitement, même pour un propriétaire resté en mode B", async () => {
  const { tenant, r } = await modeB(async () => {
    const tenant = await proprietaireModeB("gel");
    return { tenant, r: await creer(tenant, 1000) };
  });
  await assert.rejects(creer(tenant, 1000), /réservé au mode B/);
  await avecApp(async (_app, base) => {
    const tour = await tourReversements(base, mock, async () => DEST);
    assert.equal(tour[r], undefined, "gelé");
  });
  assert.deepEqual(await etat(r), { statut: "CREATED", envois: 0 });
});

test("tour : une erreur sur un reversement est rendue avec lui, et les suivants sont traités", async () => {
  await modeB(async () => {
    const a = await proprietaireModeB("destination cassée");
    const b = await proprietaireModeB("destination saine");
    await avecApp(async (_app, base) => {
      const ra = await creer(a, 1000);
      const rb = await creer(b, 1000);
      const tour = await tourReversements(base, mock, async (t) => {
        if (t.toString() === a) throw new Error("compte du bénéficiaire illisible");
        return DEST;
      });
      assert.deepEqual(tour[ra], { statut: "CREATED", erreur: "compte du bénéficiaire illisible" });
      assert.deepEqual(tour[rb], { statut: "SUCCEEDED" });
      assert.equal(mock.recus(ra), 0);
    });
  });
});
