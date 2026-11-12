// WAKATNET — déclencheur de coupure (ticket 09, ADR 0010 ; ADR 0006 §17). Hors de FreeRADIUS.
// Ticket : .scratch/phase-1-coeur-radius/issues/09-coa-disconnect.md
//
//   node coupure.ts                         un tour : Disconnect de chaque session à couper
//   node coupure.ts debit <session> <débit> CoA de changement de débit (Mikrotik-Rate-Limit)
//
// Rôle PostgreSQL wk_coa, seul autorisé sur sessions_to_cut, coa_target et mark_cut.
// Accès à la base par psql (aucune dépendance npm avant le socle de la phase 2) : les
// paramètres passent par des variables psql, jamais par concaténation.
//
// Environnement (EnvironmentFile systemd, réservé à root) :
//   WAKATNET_PG_COA_PASSWORD   mot de passe de wk_coa (obligatoire)
//   WAKATNET_PG_HOST           défaut 127.0.0.1
//   WAKATNET_COUPURE_ENVOIS    envois par session et par tour (défaut 3)
//   WAKATNET_COUPURE_DELAI_S   attente d'une réponse par envoi, en secondes (défaut 1)
//   WAKATNET_COUPURE_BUDGET_S  durée maximale d'un tour (défaut 20, sous TimeoutStartSec=25s) ;
//                              les sessions restantes passent au tour suivant
// Valeurs illisibles : sortie 1 AVANT tout envoi, sans rien enregistrer (revue du ticket 09).
// Nœud en lecture seule (réplique, T13) : aucun envoi ; la coupure ne tourne que sur le primaire.
//
// Journal : une ligne par session, sans le code du ticket ni le secret (S1, ADR 0006 §10).
// Une erreur sur une session (base, radclient) est journalisée, la session n'est pas marquée,
// et le tour continue avec les suivantes.
// Code de sortie : 0 tour terminé (même sans réponse d'un routeur) ; 1 erreur d'environnement,
// de base ou de radclient (le tour a pu traiter d'autres sessions) ; 2 CoA de débit non acquitté.

import { spawn } from "node:child_process";
import { DemandeInvalide, envoyer } from "./emetteur.ts";

const MOT_DE_PASSE = process.env.WAKATNET_PG_COA_PASSWORD;
const ENVOIS = Number(process.env.WAKATNET_COUPURE_ENVOIS ?? "3");
const DELAI_S = Number(process.env.WAKATNET_COUPURE_DELAI_S ?? "1");
const BUDGET_S = Number(process.env.WAKATNET_COUPURE_BUDGET_S ?? "20");

function configuration(): string | null {
  if (!MOT_DE_PASSE) return "WAKATNET_PG_COA_PASSWORD manquant";
  if (!Number.isInteger(ENVOIS) || ENVOIS < 1 || ENVOIS > 10) return "WAKATNET_COUPURE_ENVOIS : entier de 1 à 10";
  if (!(DELAI_S > 0 && DELAI_S <= 10)) return "WAKATNET_COUPURE_DELAI_S : de 0 à 10 s";
  if (!(BUDGET_S > 0 && BUDGET_S <= 600)) return "WAKATNET_COUPURE_BUDGET_S : de 0 à 600 s";
  return null;
}

function sql(requete: string, variables: Record<string, string>): Promise<string[][]> {
  return new Promise((resoudre, rejeter) => {
    const args = ["-X", "-q", "-tA", "-F", "\t", "-v", "ON_ERROR_STOP=1"];
    for (const [cle, valeur] of Object.entries(variables)) args.push("-v", `${cle}=${valeur}`);
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PGHOST: process.env.WAKATNET_PG_HOST ?? "127.0.0.1",
      PGDATABASE: "wakatnet",
      PGUSER: "wk_coa",
      PGPASSWORD: MOT_DE_PASSE,
      PGAPPNAME: "wakatnet-coupure",
      PGCONNECT_TIMEOUT: "5",
    };
    const p = spawn("psql", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let sortie = "";
    let erreur = "";
    p.stdout.on("data", (d) => { sortie += d; });
    p.stderr.on("data", (d) => { erreur += d; });
    p.on("error", rejeter);
    p.on("close", (code) => {
      if (code !== 0) rejeter(new Error(`psql (${code}) : ${erreur.trim()}`));
      else resoudre(sortie.split("\n").filter((l) => l !== "").map((l) => l.split("\t")));
    });
    p.stdin.end(requete);
  });
}

const ENTIER = /^[1-9][0-9]{0,18}$/;

async function cible(session: string) {
  const lignes = await sql("SELECT nas_ip, coa_port, secret, acct_session_id, username FROM radius.coa_target(:'s'::bigint);\n",
                           { s: session });
  if (lignes.length !== 1) return null;
  const [nasIp, port, secret, acctSessionId, userName] = lignes[0];
  return { cible: { nasIp, port: Number(port), secret }, acctSessionId, userName };
}

async function uneSession(session: string, motif: string): Promise<void> {
  const c = await cible(session);
  let resultat = "sans_reponse";
  let envois = 0;
  let routeur = "?";
  if (c === null) {
    // Sans secret ou sans ticket : comptée comme muette, donc abandonnée avec une alerte.
    console.log(`session=${session} motif=${motif} cible_introuvable`);
  } else {
    routeur = c.cible.nasIp;
    try {
      const r = await envoyer(c.cible, { type: "disconnect", acctSessionId: c.acctSessionId, userName: c.userName },
                              { envois: ENVOIS, delaiS: DELAI_S });
      resultat = r.resultat;
      envois = r.envois;
      if (r.authentificateurFaux > 0) {
        console.log(`session=${session} routeur=${routeur} reponses_rejetees=${r.authentificateurFaux}`);
      }
    } catch (e) {
      if (!(e instanceof DemandeInvalide)) throw e;   // panne de l'émetteur : pas un routeur muet
      console.log(`session=${session} routeur=${routeur} demande_invalide=« ${e.message} »`);
    }
  }
  const [[enregistre]] = await sql("SELECT radius.mark_cut(:'s'::bigint, :'r');\n", { s: session, r: resultat });
  console.log(`session=${session} routeur=${routeur} motif=${motif} envois=${envois} resultat=${enregistre}`);
}

async function tour(): Promise<number> {
  // Réplique (pg_is_in_recovery) ou base en lecture seule (transaction_read_only, qui vaut
  // aussi « on » sur une réplique) : mark_cut ne pourrait rien enregistrer.
  const [[lecture_seule]] = await sql(
    "SELECT pg_is_in_recovery() OR current_setting('transaction_read_only') = 'on';\n", {});
  if (lecture_seule === "t") {
    console.log("base en lecture seule (réplique) : aucune coupure sur ce nœud");
    return 0;
  }
  const fin = Date.now() + BUDGET_S * 1000;
  const sessions = await sql("SELECT session_id, motif FROM radius.sessions_to_cut();\n", {});
  let code = 0;
  let traitees = 0;
  for (const [session, motif] of sessions) {
    if (Date.now() >= fin) {
      console.log(`budget de ${BUDGET_S} s atteint : ${sessions.length - traitees} session(s) au tour suivant`);
      break;
    }
    try {
      await uneSession(session, motif);
    } catch (e) {
      console.error(`session=${session} erreur=« ${e instanceof Error ? e.message : e} »`);
      code = 1;
    }
    traitees++;
  }
  return code;
}

async function debit(session: string, valeur: string): Promise<number> {
  const c = await cible(session);
  if (c === null) {
    console.log(`session=${session} resultat=cible_introuvable`);
    return 2;
  }
  const r = await envoyer(c.cible, { type: "coa", acctSessionId: c.acctSessionId, userName: c.userName, rateLimit: valeur },
                          { envois: ENVOIS, delaiS: DELAI_S });
  console.log(`session=${session} routeur=${c.cible.nasIp} coa_debit envois=${r.envois} resultat=${r.resultat}`);
  return r.resultat === "ack" ? 0 : 2;
}

async function principal(): Promise<number> {
  const defaut = configuration();
  if (defaut !== null) {
    console.error(`configuration : ${defaut}`);
    return 1;
  }
  const [commande, session, valeur] = process.argv.slice(2);
  if (commande === undefined) {
    return tour();
  }
  if (commande === "debit" && session !== undefined && ENTIER.test(session) && valeur !== undefined) {
    return debit(session, valeur);
  }
  console.error("usage : coupure.ts [debit <session> <débit>]");
  return 1;
}

principal().then((code) => { process.exitCode = code; },
                 (e) => { console.error(`échec : ${e instanceof Error ? e.message : e}`); process.exitCode = 1; });
