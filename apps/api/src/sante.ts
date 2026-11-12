// WAKATNET — collecteur de santé d'un nœud, alertes au changement d'état (ADR 0015 §6 ; SPEC §10.3).
// Ticket : .scratch/phase-5-haute-disponibilite/issues/05-supervision.md
//
// Lancé chaque minute par wakatnet-sante.timer, sur CHAQUE nœud. Il :
//   1. mesure (base par app.sante() en tant que wk_sante, fichiers du nœud, services systemd) ;
//   2. écrit les métriques au format texte de Prometheus (lu plus tard par un Prometheus, si besoin) ;
//   3. évalue les règles et n'envoie une alerte qu'au CHANGEMENT d'état (déclenchée, résolue) ;
//   4. écrit l'état du nœud, lu par la page /etat de l'API.
// Une alerte ne porte jamais de donnée personnelle ni de code de ticket : des comptes seulement.
import { execFile } from "node:child_process";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const executer = promisify(execFile);

export type Mesure = { nom: string; aide: string; valeur: number; etiquettes?: Record<string, string> };

/** Format texte de Prometheus (version 0.0.4) ; noms préfixés wakatnet_. */
export function formatPrometheus(mesures: Mesure[]): string {
  const echapper = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  const lignes: string[] = [];
  const vus = new Set<string>();
  for (const m of mesures) {
    if (!/^[a-z_][a-z0-9_]*$/.test(m.nom)) throw new Error(`nom de métrique invalide : ${m.nom}`);
    const nom = `wakatnet_${m.nom}`;
    if (!vus.has(nom)) {
      lignes.push(`# HELP ${nom} ${m.aide.replace(/\n/g, " ")}`, `# TYPE ${nom} gauge`);
      vus.add(nom);
    }
    const e = Object.entries(m.etiquettes ?? {});
    const etiquettes = e.length ? `{${e.map(([k, v]) => `${k}="${echapper(v)}"`).join(",")}}` : "";
    lignes.push(`${nom}${etiquettes} ${Number.isFinite(m.valeur) ? m.valeur : "NaN"}`);
  }
  return lignes.join("\n") + "\n";
}

// ------------------------------------------------------------------ règles

export type Regle = { id: string; titre: string; active: (v: (nom: string, etiquettes?: Record<string, string>) => number | undefined) => boolean };

export type EtatRegle = { active: boolean; depuis: string; notifiee: boolean };
export type EtatAlertes = Record<string, EtatRegle>;
export type Transition = { id: string; titre: string; active: boolean };

export const REGLES: Regle[] = [
  { id: "service_freeradius", titre: "FreeRADIUS arrêté", active: (v) => v("service_actif", { service: "freeradius" }) === 0 },
  { id: "service_postgresql", titre: "PostgreSQL arrêté", active: (v) => v("service_actif", { service: "postgresql" }) === 0 },
  { id: "service_wg_agent", titre: "wg-agent arrêté", active: (v) => v("service_actif", { service: "wakatnet-wg-agent" }) === 0 },
  { id: "base_injoignable", titre: "Base injoignable par le collecteur", active: (v) => v("base_joignable") === 0 },
  { id: "silences", titre: "Le nœud se tait (base indisponible pour FreeRADIUS)", active: (v) => (v("silences_5min", { nature: "auth" }) ?? 0) > 0 },
  { id: "sonde_lente", titre: "authorize lent (sonde > 100 ms)", active: (v) => (v("sonde_authorize_ms") ?? 0) > 100 },
  { id: "spool_bloque", titre: "Spool d'accounting en attente depuis plus de 10 min", active: (v) => (v("spool_age_s") ?? 0) > 600 },
  { id: "routeurs_muets", titre: "Routeurs sans échange WireGuard depuis plus de 3 min", active: (v) => (v("routeurs_sans_handshake") ?? 0) > 0 },
  // Migration 0032 (revue M7) : sur le primaire, aucun routeur actif n'a d'IP notée depuis 10 min. wg-agent n'écrit
  // plus (arrêté, ancien, schéma en retard) : les hotspots ont perdu leur budget de paiement propre.
  // ADR 0017 (revue M4) : les adresses de l'overlay ne reviennent jamais ; prévenir avant qu'il soit plein.
  { id: "overlay_plein", titre: "Overlay rempli à plus de 80 % (adresses de routeurs, révoqués compris)",
    active: (v) => (v("overlay_utilise") ?? 0) > 0.8 * 254 * 254 },
  // ADR 0019 : plafond global de 200 e-mails par 24 h (80 % : envoi en masse probable, ou croissance à prévoir) ;
  // plafond de 100 routeurs enrôlés par jour pour les comptes non validés.
  { id: "courriels", titre: "Plus de 160 e-mails en 24 h (plafond 200 : envois bientôt suspendus)",
    active: (v) => (v("courriels_24h") ?? 0) >= 160 },
  { id: "plafond_enrolement", titre: "Plafond quotidien d'enrôlements des comptes non validés atteint (100)",
    active: (v) => (v("enrolements_non_valides_24h") ?? 0) >= 100 },
  { id: "ip_routeurs", titre: "wg-agent ne note plus l'IP publique des routeurs (budget de paiement des hotspots perdu)",
    active: (v) => v("en_recuperation") === 0 && (v("routeurs_actifs") ?? 0) > 0 && v("routeurs_ip_recente") === 0 },
  { id: "replication_a", titre: "Le nœud B ne réplique plus", active: (v) => v("en_recuperation") === 0 && v("replicas_en_flux") === 0 },
  { id: "replication_retard", titre: "Retard de réplication supérieur à 5 min",
    active: (v) => (v("replication_retard_s") ?? 0) > 300 },
  { id: "replication_b", titre: "La réplique ne reçoit plus le flux du primaire", active: (v) => v("en_recuperation") === 1 && v("recepteur_en_flux") === 0 },
  { id: "paiements_bloques", titre: "Paiements en attente depuis plus de 15 min", active: (v) => (v("paiements_pending_15min") ?? 0) > 0 },
  { id: "ecart_rapprochement", titre: "Écart de rapprochement (paiements MISMATCH)", active: (v) => (v("paiements_mismatch") ?? 0) > 0 },
  // Sur le PRIMAIRE seulement, qui prend les sauvegardes (ADR 0015 §5) ; aucune sauvegarde connue = alerte.
  // Après une bascule, le nouveau primaire alerte jusqu'à sa première sauvegarde : c'est voulu.
  { id: "sauvegarde", titre: "Dernière sauvegarde réussie il y a plus de 26 h",
    active: (v) => v("en_recuperation") === 0 && (v("sauvegarde_age_s") ?? Infinity) > 26 * 3600 },
  // Revue de sécurité M6 : l'échec de l'essai mensuel (écart du grand livre compris) DOIT se voir. Sur le
  // primaire ; un essai jamais lancé alerte aussi (le lancer une fois au déploiement).
  { id: "essai_restauration", titre: "Essai de restauration en échec, ou plus vieux que 35 jours",
    active: (v) => v("en_recuperation") === 0 && (v("essai_restauration_ok") !== 1 || (v("essai_restauration_age_s") ?? Infinity) > 35 * 86400) },
];

/** Évalue les règles ; rend le nouvel état et les transitions à notifier (y compris celles dont l'envoi a échoué). */
export function evaluer(mesures: Mesure[], precedent: EtatAlertes, maintenant: Date, regles: Regle[] = REGLES):
  { etat: EtatAlertes; aNotifier: Transition[] } {
  const v = (nom: string, etiquettes: Record<string, string> = {}) => mesures.find((m) => m.nom === nom
    && Object.entries(etiquettes).every(([k, x]) => m.etiquettes?.[k] === x))?.valeur;
  const etat: EtatAlertes = {};
  const aNotifier: Transition[] = [];
  for (const r of regles) {
    const active = r.active(v);
    const avant = precedent[r.id] ?? { active: false, depuis: maintenant.toISOString(), notifiee: true };
    const change = avant.active !== active;
    etat[r.id] = { active, depuis: change ? maintenant.toISOString() : avant.depuis, notifiee: change ? false : avant.notifiee };
    if (!etat[r.id].notifiee) aNotifier.push({ id: r.id, titre: r.titre, active });
  }
  return { etat, aNotifier };
}

export function messageAlerte(noeud: string, t: Transition): string {
  return `${t.active ? "🔴 ALERTE" : "🟢 RÉSOLU"} [${noeud}] ${t.titre}`;
}

/** Telegram (ADR 0015 §6) : un appel HTTPS. `base` est remplaçable pour les tests (faux serveur). */
export async function envoyerTelegram(base: string, jeton: string, salon: string, texte: string): Promise<void> {
  const r = await fetch(`${base}/bot${jeton}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: salon, text: texte, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Telegram : HTTP ${r.status}`);
}

// ------------------------------------------------------------------ mesures du nœud

/** Lignes d'un compteur de silence (ADR 0009 §4) datées des 5 dernières minutes : « AAAA-MM-JJ HH:MM:SS IP ». */
export function compterSilences(texte: string, maintenant: Date): number {
  const limite = maintenant.getTime() - 5 * 60_000;
  let n = 0;
  for (const l of texte.split("\n")) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) /.exec(l);
    if (m && Date.parse(`${m[1]}T${m[2]}Z`) >= limite) n++;
  }
  return n;
}

/** Sortie de `wg show wg0 latest-handshakes` : « clé<TAB>époque » ; 0 = jamais. */
export function routeursSansHandshake(sortie: string, maintenant: Date, seuilS = 180): number {
  const t = maintenant.getTime() / 1000;
  return sortie.split("\n").filter((l) => l.trim()).filter((l) => {
    const e = Number(l.split(/\s+/)[1]);
    return !Number.isFinite(e) || e === 0 || t - e > seuilS;
  }).length;
}

async function lireTexte(p: string): Promise<string | null> {
  try { return await readFile(p, "utf8"); } catch { return null; }
}

export type ConfigSante = {
  noeud: string; urlBase: string; dossierSilences: string; spool: string; etatSauvegarde: string;
  sortieMetriques: string; fichierEtat: string; services: string[]; interfaceWg: string; etatEssai: string;
};

async function mesuresBase(urlBase: string): Promise<Mesure[]> {
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: urlBase, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  try {
    await c.connect();
    const { rows: [{ s }] } = await c.query<{ s: Record<string, number | Record<string, number>> }>("SELECT app.sante() AS s");
    const m: Mesure[] = [{ nom: "base_joignable", aide: "1 si le collecteur joint la base locale", valeur: 1 }];
    for (const [cle, val] of Object.entries(s)) {
      if (typeof val === "number") m.push({ nom: cle, aide: `app.sante() : ${cle}`, valeur: val });
      else for (const [k, x] of Object.entries(val)) m.push({ nom: cle, aide: `app.sante() : ${cle}`, valeur: x, etiquettes: { cle: k } });
    }
    return m;
  } catch {
    return [{ nom: "base_joignable", aide: "1 si le collecteur joint la base locale", valeur: 0 }];
  } finally {
    await c.end().catch(() => {});
  }
}

export async function mesurer(cfg: ConfigSante, maintenant = new Date()): Promise<Mesure[]> {
  const m: Mesure[] = await mesuresBase(cfg.urlBase);
  for (const nature of ["auth", "client"]) {
    const t = await lireTexte(join(cfg.dossierSilences, `silence-${nature}.log`));
    m.push({ nom: "silences_5min", aide: "paquets laissés sans réponse sur 5 min (ADR 0009)", valeur: t ? compterSilences(t, maintenant) : 0, etiquettes: { nature } });
  }
  let fichiers: string[] = [];
  try { fichiers = (await readdir(cfg.spool)).filter((f) => f.startsWith("detail")); } catch { /* spool pas encore créé */ }
  let age = 0, octets = 0;
  for (const f of fichiers) {
    const s = await stat(join(cfg.spool, f)).catch(() => null);
    if (s) { octets += s.size; age = Math.max(age, (maintenant.getTime() - s.mtimeMs) / 1000); }
  }
  m.push({ nom: "spool_fichiers", aide: "fichiers du spool d'accounting en attente", valeur: fichiers.length },
         { nom: "spool_octets", aide: "taille du spool d'accounting", valeur: octets },
         { nom: "spool_age_s", aide: "âge du plus ancien fichier du spool", valeur: Math.round(age) });
  try {
    const { stdout } = await executer("wg", ["show", cfg.interfaceWg, "latest-handshakes"], { timeout: 5000 });
    m.push({ nom: "routeurs_sans_handshake", aide: "pairs WireGuard sans échange depuis plus de 3 min", valeur: routeursSansHandshake(stdout, maintenant) });
  } catch { /* wg absent ou interface absente : pas de mesure (pas d'alerte inventée) */ }
  for (const service of cfg.services) {
    let actif = 0;
    try { actif = (await executer("systemctl", ["is-active", "--quiet", service], { timeout: 5000 })) ? 1 : 0; } catch { actif = 0; }
    m.push({ nom: "service_actif", aide: "1 si l'unité systemd est active", valeur: actif, etiquettes: { service } });
  }
  const sauvegarde = await lireTexte(cfg.etatSauvegarde);
  if (sauvegarde) {
    try {
      const s = JSON.parse(sauvegarde) as { fin: string; ok: boolean };
      if (s.ok) m.push({ nom: "sauvegarde_age_s", aide: "âge de la dernière sauvegarde réussie", valeur: Math.round((maintenant.getTime() - Date.parse(s.fin)) / 1000) });
    } catch { /* fichier illisible : pas de mesure, l'alerte « sauvegarde » se déclenche */ }
  }
  const essai = await lireTexte(cfg.etatEssai);
  if (essai) {
    try {
      const s = JSON.parse(essai) as { fin: string; ok: boolean };
      m.push({ nom: "essai_restauration_ok", aide: "1 si le dernier essai de restauration a réussi", valeur: s.ok ? 1 : 0 },
             { nom: "essai_restauration_age_s", aide: "âge du dernier essai de restauration", valeur: Math.round((maintenant.getTime() - Date.parse(s.fin)) / 1000) });
    } catch { /* illisible : pas de mesure, l'alerte se déclenche */ }
  }
  return m;
}

/** Écriture atomique (fichier temporaire puis renommage) : un lecteur ne voit jamais un fichier à moitié écrit. */
async function ecrire(p: string, contenu: string): Promise<void> {
  await writeFile(`${p}.tmp`, contenu, { mode: 0o644 });
  await rename(`${p}.tmp`, p);
}

export type EtatNoeud = { noeud: string; verifie_le: string; composants: Record<string, boolean>; alertes: EtatAlertes };

export async function tourSante(cfg: ConfigSante, envoyer: ((t: string) => Promise<void>) | null, maintenant = new Date()): Promise<EtatNoeud> {
  const mesures = await mesurer(cfg, maintenant);
  await ecrire(cfg.sortieMetriques, formatPrometheus(mesures));
  const avant = JSON.parse((await lireTexte(cfg.fichierEtat)) ?? "{}") as Partial<EtatNoeud>;
  const { etat, aNotifier } = evaluer(mesures, avant.alertes ?? {}, maintenant);
  for (const t of aNotifier) {
    if (!envoyer) break;
    try {
      await envoyer(messageAlerte(cfg.noeud, t));
      etat[t.id].notifiee = true;
    } catch (e) {
      console.error(`alerte ${t.id} non envoyée (nouvel essai à la prochaine minute) : ${(e as Error).message}`);
    }
  }
  // Composants de la page /etat : noms génériques, aucune donnée de propriétaire.
  const ko = (...ids: string[]) => ids.some((id) => etat[id]?.active);
  const sortie: EtatNoeud = {
    noeud: cfg.noeud, verifie_le: maintenant.toISOString(), alertes: etat,
    composants: {
      authentification: !ko("service_freeradius", "service_postgresql", "silences", "base_injoignable"),
      paiements: !ko("paiements_bloques"),
      replication: !ko("replication_a", "replication_b", "replication_retard"),
    },
  };
  await ecrire(cfg.fichierEtat, JSON.stringify(sortie));
  return sortie;
}

// Point d'entrée (pas lors d'un import par les tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  const exiger = (n: string) => { const x = env[n]; if (!x) { console.error(`santé : ${n} manquant`); process.exit(1); } return x; };
  const cfg: ConfigSante = {
    noeud: exiger("WAKATNET_NOEUD"),
    urlBase: exiger("WAKATNET_SANTE_DATABASE_URL"),
    dossierSilences: env.WAKATNET_SILENCES ?? "/var/log/freeradius/wakatnet",
    spool: env.WAKATNET_SPOOL ?? "/var/log/freeradius/radacct/wakatnet",
    etatSauvegarde: env.WAKATNET_ETAT_SAUVEGARDE ?? "/var/lib/wakatnet/sauvegarde.json",
    sortieMetriques: env.WAKATNET_METRIQUES ?? "/var/lib/wakatnet/sante/wakatnet.prom",
    fichierEtat: env.WAKATNET_ETAT_NOEUD ?? "/var/lib/wakatnet/sante/etat.json",
    services: (env.WAKATNET_SERVICES ?? "freeradius,postgresql,wakatnet-wg-agent").split(",").filter(Boolean),
    interfaceWg: env.WAKATNET_WG_INTERFACE ?? "wg0",
    etatEssai: env.WAKATNET_ETAT_ESSAI ?? "/var/lib/wakatnet/essai-restauration.json",
  };
  const jeton = env.WAKATNET_TELEGRAM_JETON, salon = env.WAKATNET_TELEGRAM_SALON;
  const envoyer = jeton && salon
    ? (t: string) => envoyerTelegram(env.WAKATNET_TELEGRAM_URL ?? "https://api.telegram.org", jeton, salon, t)
    : null;
  if (!envoyer) console.error("santé : alertes Telegram non configurées (WAKATNET_TELEGRAM_JETON, WAKATNET_TELEGRAM_SALON)");
  const e = await tourSante(cfg, envoyer);
  const actives = Object.entries(e.alertes).filter(([, x]) => x.active).map(([k]) => k);
  console.log(`santé ${cfg.noeud} : ${actives.length ? `alertes actives : ${actives.join(", ")}` : "aucune alerte"}`);
}
