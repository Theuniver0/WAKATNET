// Supervision : collecteur, règles au changement d'état, Telegram, page d'état (ADR 0015 §6 ; SPEC §10.3).
// Ticket : .scratch/phase-5-haute-disponibilite/issues/05-supervision.md
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lireEtats } from "../src/etat.ts";
import { compterSilences, evaluer, formatPrometheus, messageAlerte, envoyerTelegram, routeursSansHandshake, tourSante,
         type ConfigSante, type Mesure } from "../src/sante.ts";
import { avecApp, config, proprietaire, sql, URL_ADMIN, URL_API } from "./aide.ts";

const M = (nom: string, valeur: number, etiquettes?: Record<string, string>): Mesure => ({ nom, aide: nom, valeur, etiquettes });

test("format Prometheus : HELP et TYPE une fois par nom, étiquettes échappées, nom refusé s'il est invalide", () => {
  const t = formatPrometheus([M("service_actif", 1, { service: "freeradius" }), M("service_actif", 0, { service: 'a"b' }), M("x", NaN)]);
  assert.equal(t.match(/# TYPE wakatnet_service_actif gauge/g)?.length, 1);
  assert.match(t, /wakatnet_service_actif\{service="freeradius"\} 1/);
  assert.match(t, /wakatnet_service_actif\{service="a\\"b"\} 0/);
  assert.match(t, /wakatnet_x NaN/);
  assert.throws(() => formatPrometheus([M("Mauvais-Nom", 1)]));
});

test("règles : une alerte seulement au CHANGEMENT d'état ; un envoi échoué est retenté ; la résolution est notifiée", () => {
  const t0 = new Date("2026-11-12T10:00:00Z"), t1 = new Date("2026-11-12T10:01:00Z"), t2 = new Date("2026-11-12T10:02:00Z");
  const panne = [M("service_actif", 0, { service: "freeradius" })];
  const sain = [M("service_actif", 1, { service: "freeradius" })];
  let r = evaluer(sain, {}, t0);
  assert.deepEqual(r.aNotifier, [], "état initial sain : rien à dire");
  r = evaluer(panne, r.etat, t1);
  assert.deepEqual(r.aNotifier.map((x) => [x.id, x.active]), [["service_freeradius", true]]);
  // Envoi échoué (notifiee reste false) : la même transition revient à la minute suivante, une seule fois.
  r = evaluer(panne, r.etat, t2);
  assert.deepEqual(r.aNotifier.map((x) => x.id), ["service_freeradius"]);
  r.etat.service_freeradius.notifiee = true;
  assert.deepEqual(evaluer(panne, r.etat, t2).aNotifier, [], "déjà notifiée : silence");
  const fin = evaluer(sain, r.etat, t2);
  assert.deepEqual(fin.aNotifier.map((x) => [x.id, x.active]), [["service_freeradius", false]]);
  assert.equal(messageAlerte("A", fin.aNotifier[0]), "🟢 RÉSOLU [A] FreeRADIUS arrêté");
});

test("règles de réplication : A sans réplique en flux, B sans flux reçu, retard > 5 min ; sauvegarde suivie sur le primaire seul", () => {
  const ids = (m: Mesure[]) => Object.entries(evaluer(m, {}, new Date()).etat).filter(([, e]) => e.active).map(([k]) => k).sort();
  assert.deepEqual(ids([M("en_recuperation", 0), M("replicas_en_flux", 0), M("sauvegarde_age_s", 60)]), ["replication_a"]);
  assert.deepEqual(ids([M("en_recuperation", 1), M("recepteur_en_flux", 0)]), ["replication_b"]);
  assert.deepEqual(ids([M("en_recuperation", 1), M("recepteur_en_flux", 1), M("replication_retard_s", 301)]), ["replication_retard"]);
  assert.deepEqual(ids([M("en_recuperation", 1), M("recepteur_en_flux", 1)]), [], "une réplique ne prend pas les sauvegardes");
  assert.deepEqual(ids([M("en_recuperation", 0), M("replicas_en_flux", 1)]), ["sauvegarde"], "primaire sans sauvegarde connue : alerte");
  assert.deepEqual(ids([M("en_recuperation", 0), M("replicas_en_flux", 1), M("sauvegarde_age_s", 3600)]), []);
});

test("silences des 5 dernières minutes et pairs WireGuard muets", () => {
  const n = new Date("2026-11-12T10:10:00Z");
  assert.equal(compterSilences("2026-11-12 10:04:59 10.213.1.1\n2026-11-12 10:05:00 10.213.1.2\n2026-11-12 10:09:59 10.213.1.3\nmal formée\n", n), 2);
  const e = n.getTime() / 1000;
  assert.equal(routeursSansHandshake(`k1\t${e - 10}\nk2\t${e - 200}\nk3\t0\n`, n), 2);
});

test("Telegram : un POST JSON vers /bot<jeton>/sendMessage ; une erreur HTTP est une erreur", async () => {
  const recus: { url: string; corps: unknown }[] = [];
  let code = 200;
  const s = createServer((req, res) => {
    let b = "";
    req.on("data", (x) => (b += x)).on("end", () => { recus.push({ url: req.url ?? "", corps: JSON.parse(b) }); res.writeHead(code).end("{}"); });
  });
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  try {
    await envoyerTelegram(base, "123:abc", "-100", "🔴 ALERTE [A] essai");
    assert.deepEqual(recus[0], { url: "/bot123:abc/sendMessage", corps: { chat_id: "-100", text: "🔴 ALERTE [A] essai", disable_web_page_preview: true } });
    code = 500;
    await assert.rejects(envoyerTelegram(base, "123:abc", "-100", "x"), /HTTP 500/);
  } finally {
    s.close();
  }
});

function dossierNoeud() {
  const d = mkdtempSync(join(tmpdir(), "wakatnet-sante-"));
  mkdirSync(join(d, "silences")); mkdirSync(join(d, "spool"));
  return d;
}

test("tour de santé sur la vraie base : app.sante() en tant que wk_sante, silences, spool, état écrit, alertes envoyées une fois", async () => {
  const d = dossierNoeud();
  writeFileSync(join(d, "silences", "silence-auth.log"), `${new Date().toISOString().slice(0, 19).replace("T", " ")} 10.213.1.9\n`);
  writeFileSync(join(d, "spool", "detail-20261112"), "x".repeat(100));
  const vieux = Date.now() / 1000 - 700;
  utimesSync(join(d, "spool", "detail-20261112"), vieux, vieux);
  const url = URL_API.replace(/\/\/wk_api:[^@]*@/, `//wk_sante:${process.env.WAKATNET_PG_SANTE_PASSWORD}@`);
  const cfg: ConfigSante = { noeud: "A", urlBase: url, dossierSilences: join(d, "silences"), spool: join(d, "spool"),
    etatSauvegarde: join(d, "sauvegarde.json"), sortieMetriques: join(d, "wakatnet.prom"), fichierEtat: join(d, "etat.json"),
    services: [], interfaceWg: "wg-absente" };
  const envois: string[] = [];
  const e = await tourSante(cfg, async (t) => { envois.push(t); });
  assert.equal(e.alertes.base_injoignable.active, false, "wk_sante joint la base et exécute app.sante()");
  assert.equal(e.alertes.silences.active, true);
  assert.equal(e.alertes.spool_bloque.active, true);
  assert.equal(e.composants.authentification, false);
  assert.ok(envois.some((x) => x.includes("Le nœud se tait")) && envois.every((x) => !/[A-Z0-9]{8,16}\b.*ticket/.test(x)));
  const avant = envois.length;
  await tourSante(cfg, async (t) => { envois.push(t); });
  assert.equal(envois.length, avant, "même état à la minute suivante : aucun nouvel envoi");
  const etats = await lireEtats([cfg.fichierEtat, join(d, "absent.json")]);
  assert.equal(etats[0].composants.authentification, "perturbe");
  assert.deepEqual(Object.values(etats[1].composants), ["inconnu", "inconnu", "inconnu"]);
  const perime = await lireEtats([cfg.fichierEtat], new Date(Date.now() + 4 * 60_000));
  assert.deepEqual(Object.values(perime[0].composants), ["inconnu", "inconnu", "inconnu"], "état de plus de 3 min : inconnu");
});

test("app.sante() : comptes seulement, et wk_sante ne lit aucune table ni n'appelle une autre fonction", async () => {
  await proprietaire("santé");
  const url = URL_API.replace(/\/\/wk_api:[^@]*@/, `//wk_sante:${process.env.WAKATNET_PG_SANTE_PASSWORD}@`);
  const [{ s }] = await sql<{ s: Record<string, unknown> }>(url, "SELECT app.sante() AS s");
  for (const cle of ["en_recuperation", "sonde_authorize_ms", "routeurs_actifs", "paiements_pending_15min", "paiements_mismatch",
                     "replicas_en_flux", "auth_5min"]) assert.ok(cle in s, cle);
  assert.equal(s.en_recuperation, 0);
  assert.ok(Number(s.sonde_authorize_ms) >= 0 && Number(s.sonde_authorize_ms) < 1000);
  assert.ok(!JSON.stringify(s).match(/@|[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8,16}/), "aucune adresse ni code dans les métriques");
  await assert.rejects(sql(url, "SELECT count(*) FROM app.tenant"), /permission denied/);
  await assert.rejects(sql(url, "SELECT * FROM radius.authorize('X', '10.0.0.1', '', '')"), /permission denied/);
  const [{ n }] = await sql<{ n: number }>(URL_ADMIN, `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname IN ('app', 'radius', 'ledger') AND has_function_privilege('wk_sante', p.oid, 'EXECUTE')`);
  assert.equal(n, 1, "app.sante() seulement");
});

test("GET /etat : HTML et JSON, sans donnée de propriétaire, sans cache", async () => {
  const d = dossierNoeud();
  writeFileSync(join(d, "etat.json"), JSON.stringify({ noeud: "A", verifie_le: new Date().toISOString(),
    composants: { authentification: true, paiements: false, replication: true }, alertes: { x: { active: true } } }));
  await avecApp(async (app) => {
    const h = await app.inject({ url: "/etat" });
    assert.equal(h.statusCode, 200);
    assert.match(h.body, /Connexion des clients Wi-Fi : <strong>En service<\/strong>/);
    assert.match(h.body, /Paiements : <strong>Perturbé<\/strong>/);
    assert.equal(h.headers["cache-control"], "no-store");
    const j = (await app.inject({ url: "/etat?format=json" })).json();
    assert.deepEqual(j.noeuds[0].composants, { authentification: "en_service", paiements: "perturbe", replication: "en_service" });
    assert.ok(!("alertes" in j.noeuds[0]), "le détail des alertes reste interne");
  }, config({ etatsNoeuds: [join(d, "etat.json")] }));
});
