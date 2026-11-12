// WAKATNET — émetteur de Disconnect-Request et CoA-Request (ticket 09, ADR 0010 ; ADR 0006 §17).
// Ticket : .scratch/phase-1-coeur-radius/issues/09-coa-disconnect.md
//
// Module réutilisable par le futur worker (phase 2). Hors du processus FreeRADIUS (règle 1).
// Il appelle radclient (FreeRADIUS 3.2.10), qui signe la requête, calcule le
// Message-Authenticator et VÉRIFIE l'authentificateur de la réponse : une réponse dont
// l'authentificateur est faux est rejetée (« invalid Response Authenticator »).
//
// Secrets (S1) : le secret du routeur est écrit dans un fichier 0600, dans un répertoire 0700
// créé sous TMPDIR (un tmpfs en production : RuntimeDirectory de l'unité systemd), passé à
// radclient par -S, puis supprimé. Jamais en ligne de commande, jamais journalisé.
//
// Retentatives : radclient 3.2.10 n'envoie jamais plus de 2 fois quelle que soit la valeur
// de -r, et -r 0 n'envoie rien (mesuré le 12/11/2026, ADR 0010 §2). Chaque envoi est donc un
// appel « radclient -r 1 » : exactement `envois` paquets au plus, chacun avec son identifiant.
//
// Exécuté tel quel par Node 22 (suppression des types) : syntaxe TypeScript effaçable seulement.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TypeDemande = "disconnect" | "coa";
export type Resultat = "ack" | "nak" | "sans_reponse";

export interface Cible {
  nasIp: string;
  port: number;
  secret: string;
}

export interface Demande {
  type: TypeDemande;
  acctSessionId: string;
  userName: string;
  rateLimit?: string; // CoA de débit seulement (Mikrotik-Rate-Limit)
}

export interface Options {
  envois?: number;   // nombre maximal d'envois (défaut 3)
  delaiS?: number;   // attente d'une réponse par envoi, en secondes (défaut 1)
  radclient?: string;
}

export interface Compte {
  resultat: Resultat;
  envois: number;               // paquets réellement envoyés
  authentificateurFaux: number; // réponses rejetées par radclient
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
// Valeurs recopiées dans l'entrée de radclient, entre guillemets : jamais de guillemet,
// d'antislash ni de fin de ligne (sinon un attribut pourrait en injecter un autre).
const VALEUR = /^[A-Za-z0-9._:@\/+-]{1,128}$/;
const DEBIT = /^[A-Za-z0-9.\/ ]{1,128}$/;
const SECRET = /^[\x21-\x7e]{1,128}$/;

export class DemandeInvalide extends Error {}
// radclient n'a rien envoyé et a échoué (dictionnaire, fichier du secret, binaire absent) :
// une panne de l'émetteur, jamais un routeur muet (revue du ticket 09).
export class ErreurRadclient extends Error {}

function verifier(cible: Cible, demande: Demande, envois: number, delaiS: number): void {
  if (!IPV4.test(cible.nasIp)) throw new DemandeInvalide("adresse du routeur invalide");
  if (!Number.isInteger(cible.port) || cible.port < 1 || cible.port > 65535) throw new DemandeInvalide("port invalide");
  if (!SECRET.test(cible.secret)) throw new DemandeInvalide("secret du routeur illisible");
  if (!VALEUR.test(demande.acctSessionId)) throw new DemandeInvalide("Acct-Session-Id invalide");
  if (!VALEUR.test(demande.userName)) throw new DemandeInvalide("User-Name invalide");
  if (demande.type === "coa" && (demande.rateLimit === undefined || !DEBIT.test(demande.rateLimit))) {
    throw new DemandeInvalide("débit invalide");
  }
  if (!Number.isInteger(envois) || envois < 1 || envois > 10) throw new DemandeInvalide("nombre d'envois invalide");
  if (!(delaiS > 0 && delaiS <= 10)) throw new DemandeInvalide("délai invalide");
}

function attributs(demande: Demande): string {
  const lignes = [
    `User-Name = "${demande.userName}"`,
    `Acct-Session-Id = "${demande.acctSessionId}"`,
  ];
  if (demande.type === "coa") lignes.push(`Mikrotik-Rate-Limit = "${demande.rateLimit}"`);
  // Valeur nulle : radclient calcule le Message-Authenticator (RFC 5176 §3.3, RFC 2869).
  lignes.push("Message-Authenticator = 0x00");
  return lignes.join("\n") + "\n";
}

function unEnvoi(radclient: string, fichierSecret: string, cible: Cible, demande: Demande,
                 delaiS: number): Promise<{ sortie: string; erreur: string; code: number | null }> {
  return new Promise((resoudre, rejeter) => {
    const p = spawn(radclient,
      ["-S", fichierSecret, "-r", "1", "-t", String(delaiS), `${cible.nasIp}:${cible.port}`, demande.type],
      // Environnement minimal : radclient n'hérite d'aucun mot de passe (revue du ticket 09).
      { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    let sortie = "";
    let erreur = "";
    const garde = setTimeout(() => p.kill("SIGKILL"), (delaiS + 5) * 1000);
    p.stdout.on("data", (d) => { sortie += d; });
    p.stderr.on("data", (d) => { erreur += d; });
    p.on("error", (e) => { clearTimeout(garde); rejeter(e); });
    p.on("close", (code) => { clearTimeout(garde); resoudre({ sortie, erreur, code }); });
    p.stdin.end(attributs(demande));
  });
}

export async function envoyer(cible: Cible, demande: Demande, options: Options = {}): Promise<Compte> {
  const envois = options.envois ?? 3;
  const delaiS = options.delaiS ?? 1;
  verifier(cible, demande, envois, delaiS);
  const repertoire = await mkdtemp(join(tmpdir(), "wakatnet-coa-"));   // 0700
  const fichier = join(repertoire, "secret");
  const compte: Compte = { resultat: "sans_reponse", envois: 0, authentificateurFaux: 0 };
  try {
    await writeFile(fichier, cible.secret, { mode: 0o600, flag: "wx" });
    const attendu = demande.type === "disconnect" ? "Disconnect" : "CoA";
    for (let i = 0; i < envois; i++) {
      const { sortie, erreur, code } = await unEnvoi(options.radclient ?? "radclient", fichier, cible, demande, delaiS);
      if (!/^Sent /m.test(sortie)) {
        // Rien n'est parti : ce n'est pas un silence du routeur. Première ligne d'erreur seulement
        // (radclient n'y écrit jamais le secret, qu'il lit dans le fichier).
        throw new ErreurRadclient(`radclient (code ${code}) : ${(erreur.split("\n")[0] ?? "").slice(0, 200)}`);
      }
      compte.envois++;
      if (/invalid Response Authenticator/.test(sortie + erreur)) compte.authentificateurFaux++;
      if (new RegExp(`^Received ${attendu}-ACK `, "m").test(sortie)) { compte.resultat = "ack"; break; }
      if (new RegExp(`^Received ${attendu}-NAK `, "m").test(sortie)) { compte.resultat = "nak"; break; }
    }
  } finally {
    await rm(repertoire, { recursive: true, force: true });
  }
  return compte;
}
