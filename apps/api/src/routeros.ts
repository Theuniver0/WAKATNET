// WAKATNET — générateur des scripts RouterOS v7 de l'enrôlement (SPEC §6.2, ADR 0012 §4 et §9).
// Tickets : .scratch/phase-2-multi-proprietaires/issues/03-api-enrolement.md, 04-scripts-routeros.md
//
// Normes R1–R8 (CONTRIBUTING.md) : idempotent, additif, objets marqués « wakatnet », pas
// d'accès d'administration touché, use-radius en dernier après preuve du tunnel, réversible.
// [LABO] : ces scripts n'ont PAS été exécutés sur CHR (écart R8 décidé par Yacouba le
// 12/11/2026, PRD de la phase 2 §6). Points à trancher : ADR 0012 §9.
//
// Chaque script est un seul bloc { … } : sous /import, une variable :local ne survit pas
// d'une ligne de premier niveau à la suivante.


export type Hotspot = {
  serveur: string;
  profil: string;
  use_radius: boolean;
  html_directory: string;
  radius_accounting: boolean;
  radius_interim_update: string;
  /** Adresse et nom DNS de la page de connexion du hotspot : cibles admises de l'auto-connexion. */
  adresse?: string;
  dns?: string;
};

export type Inventaire = {
  identity: string;
  modele: string;
  version: string;
  listen_port: number;
  coa_port: number;
  coa_accept: boolean;
  hotspots: Hotspot[];
};

import type { Noeud } from "./config.ts";

export type { Noeud };

export class ValeurInterdite extends Error {}

/**
 * Chaîne RouterOS entre guillemets. Échappe « \ », « " », « $ » (substitution de variable)
 * et « ? » (aide du terminal). Refuse tout caractère de contrôle : une fin de ligne
 * injectée ouvrirait une nouvelle commande.
 */
export function chaine(valeur: string): string {
  if (/[\u0000-\u001f\u007f]/.test(valeur)) throw new ValeurInterdite("caractere de controle dans une valeur RouterOS");
  return `"${valeur.replace(/[\\"$?]/g, (c) => `\\${c}`)}"`;
}

const IPV4 = /^(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){3}$/;
const CLE = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

function ip(v: string): string {
  if (!IPV4.test(v)) throw new ValeurInterdite(`adresse IPv4 invalide : ${v}`);
  return v;
}

function cle(v: string): string {
  if (!CLE.test(v)) throw new ValeurInterdite("cle WireGuard invalide");
  return v;
}

/** Nom d'hôte DNS (minuscules, étiquettes de 1 à 63 caractères) : jamais de joker ni de chemin. */
function hoteDns(v: string): string {
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(v) || v.length > 253) {
    throw new ValeurInterdite(`nom d'hote invalide : ${v}`);
  }
  return v;
}

function port(v: number): number {
  if (!Number.isInteger(v) || v < 1 || v > 65535) throw new ValeurInterdite(`port invalide : ${v}`);
  return v;
}

/** Commande à coller par le propriétaire (SPEC §6.2). */
export function commande(urlPublique: string, jeton: string, racines: { pem: string; empreinte: string }[] = []): string {
  const url = chaine(`${urlPublique}/enroll/${jeton}`);
  return [...racines.map((r) => ligneRacine(r)),
    `/tool fetch url=${url} check-certificate=yes dst-path="wakatnet-enroll.rsc"`,
    `/import file-name="wakatnet-enroll.rsc"`,
  ].join("\n");
}

/** Racine TLS de l'API, importée seulement si son empreinte est absente (RouterOS < 7.19 n'a pas de magasin intégré :
 *  banc CHR du 14/11/2026, ADR 0003). Nommée « wakatnet racine <début de l'empreinte> » (un nom par racine : deux jeux
 *  de racines ne se marchent pas dessus), retirée par la désinstallation. Une copie déjà présente mais non approuvée
 *  n'est pas touchée (c'est un objet du propriétaire) : on le dit, car l'enrôlement échouera. Contrôlée ici aussi : le
 *  texte va tel quel dans la ligne collée par le propriétaire. */
function ligneRacine(r: { pem: string; empreinte: string }): string {
  if (!/^[0-9a-f]{64}$/.test(r.empreinte)) throw new ValeurInterdite("empreinte de racine invalide");
  const l = r.pem.trim().split("\n");
  if (l.length < 3 || l[0] !== "-----BEGIN CERTIFICATE-----" || l.at(-1) !== "-----END CERTIFICATE-----"
      || !l.slice(1, -1).every((x) => /^[A-Za-z0-9+/=]{1,76}$/.test(x))) throw new ValeurInterdite("racine PEM invalide");
  const court = r.empreinte.slice(0, 16);
  const fichier = `wakatnet-racine-${court}.pem`, nom = `wakatnet racine ${court}`;
  const trouve = `[/certificate find where fingerprint="${r.empreinte}"]`;
  // En 7.15, un fichier créé n'apparaît pas aussitôt dans /file (banc CHR) : attente bornée, pas un délai fixe.
  return `:if ([:len ${trouve}] = 0) do={ `
    + `/file add name="${fichier}" contents="${l.join("\\n")}\\n"; `
    + `:local n 0; :while (([:len [/file find where name="${fichier}"]] = 0) && ($n < 30)) do={ :delay 1s; :set n ($n + 1) }; `
    + `:do { /certificate import file-name="${fichier}" passphrase="" name="${nom}"; /certificate set ${trouve} trusted=yes } `
    + `on-error={ :put "WAKATNET : la racine ${nom} n'a pas pu etre importee ; l'enrolement va echouer. Recollez la commande." }; `
    + `:do { /file remove [find where name="${fichier}"] } on-error={} } `
    + `else={ :if ([:len [/certificate find where fingerprint="${r.empreinte}" && !trusted]] > 0) do={ `
    + `:put "WAKATNET : un certificat racine ${court}... est present mais non approuve (trusted=no) ; l'enrolement va echouer. Approuvez-le ou retirez-le, puis recollez la commande." } }`;
}

/** Étape 1 : contrôles, interface WireGuard (clé privée générée sur le routeur), inventaire, POST. */
export function etape1(urlPublique: string, jeton: string, expireLe: Date): string {
  const url = chaine(`${urlPublique}/enroll/${jeton}`);
  return `# WAKATNET - enrolement, etape 1. Valable jusqu'au ${expireLe.toISOString()} (UTC), une seule fois.
# Ne modifie AUCUN objet existant. Cree seulement l'interface wg-wakatnet si elle manque.
{
:local url ${url}
:local fin do={ /file remove [find where name="wakatnet-enroll.rsc"] }

# --- Version : RouterOS 7.15 ou plus recent (ADR 0003) ---
:local v [/system resource get version]
:local p [:find $v "."]
:local maj [:tonum [:pick $v 0 $p]]
:local reste [:pick $v ($p + 1) [:len $v]]
:local q [:find $reste "."]
:if ([:typeof $q] = "nil") do={ :set q [:find $reste " "] }
:if ([:typeof $q] = "nil") do={ :set q [:len $reste] }
:local min [:tonum [:pick $reste 0 $q]]
:if (($maj < 7) || (($maj = 7) && ($min < 15))) do={ $fin; :error "WAKATNET : RouterOS 7.15 ou plus recent est exige (version actuelle : $v). Rien n'a ete modifie." }

# --- Conflit avec la plage de la plateforme (10.213.0.0/16) ---
:if ([:len [/ip address find where address in 10.213.0.0/16 and !(comment~"^wakatnet")]] > 0) do={ $fin; :error "WAKATNET : une adresse de ce routeur est dans 10.213.0.0/16, la plage de la plateforme. Rien n'a ete modifie." }
:if ([:len [/ip route find where dst-address in 10.213.0.0/16 and !(comment~"^wakatnet")]] > 0) do={ $fin; :error "WAKATNET : une route de ce routeur couvre 10.213.0.0/16, la plage de la plateforme. Rien n'a ete modifie." }

# --- Pas d'autre serveur RADIUS pour le hotspot (ADR 0012 section 9) ---
:if ([:len [/radius find where service~"hotspot" and !(comment~"^wakatnet")]] > 0) do={ $fin; :error "WAKATNET : un autre serveur RADIUS est declare pour le hotspot. Retirez-le ou contactez le support. Rien n'a ete modifie." }

# --- Inventaire des serveurs hotspot et de leurs profils (valeurs d'origine, pour la desinstallation) ---
:local hs [:toarray ""]
:foreach s in=[/ip hotspot find] do={
  :local prof [/ip hotspot get $s profile]
  :local pid [/ip hotspot profile find where name=$prof]
  :if ([/ip hotspot profile get $pid use-radius] = true) do={ $fin; :error "WAKATNET : le profil hotspot $prof utilise deja RADIUS. Rien n'a ete modifie." }
  :local adr ""
  :local dns ""
  :do { :set adr [:tostr [/ip hotspot profile get $pid hotspot-address]] } on-error={}
  :do { :set dns [:tostr [/ip hotspot profile get $pid dns-name]] } on-error={}
  :set ($hs->[:len $hs]) {"serveur"=[/ip hotspot get $s name]; "profil"=$prof; "use_radius"=[/ip hotspot profile get $pid use-radius]; "html_directory"=[/ip hotspot profile get $pid html-directory]; "radius_accounting"=[/ip hotspot profile get $pid radius-accounting]; "radius_interim_update"=[:tostr [/ip hotspot profile get $pid radius-interim-update]]; "adresse"=$adr; "dns"=$dns}
}
:if ([:len $hs] = 0) do={ $fin; :error "WAKATNET : aucun serveur hotspot sur ce routeur. Configurez d'abord le hotspot. Rien n'a ete modifie." }

# --- Interface WireGuard : la cle privee est generee ici et ne quitte jamais le routeur ---
:if ([:len [/interface wireguard find where name="wg-wakatnet"]] = 0) do={
  :local lp 13231
  :while ([:len [/interface wireguard find where listen-port=$lp]] > 0) do={ :set lp ($lp + 1) }
  /interface wireguard add name="wg-wakatnet" listen-port=$lp mtu=1420 comment="wakatnet tunnel vers la plateforme"
}
:local wg [/interface wireguard find where name="wg-wakatnet"]

# --- Inscription aupres de la plateforme ; la reponse est l'etape 2 ---
:local corps [:serialize to=json value={"cle"=[/interface wireguard get $wg public-key]; "identity"=[/system identity get name]; "modele"=[/system resource get board-name]; "version"=$v; "listen_port"=[/interface wireguard get $wg listen-port]; "coa_port"=[/radius incoming get port]; "coa_accept"=[/radius incoming get accept]; "hotspots"=$hs}]
:do {
  /tool fetch url=$url check-certificate=yes http-method=post http-header-field="Content-Type: application/json" http-data=$corps dst-path="wakatnet-etape2.rsc" output=file
} on-error={ $fin; :error "WAKATNET : la plateforme a refuse l'inscription (commande expiree ou deja utilisee, version, hotspot). Le hotspot n'a pas ete modifie ; l'interface wg-wakatnet peut etre retiree par la desinstallation." }
:delay 1s
:do { /import file-name="wakatnet-etape2.rsc" verbose=no } on-error={ $fin; :error "WAKATNET : etape 2 interrompue. Le hotspot n'a pas ete modifie. Corrigez la cause affichee puis relancez : /import file-name=wakatnet-etape2.rsc" }
$fin
}
`;
}

export type Etape2 = {
  overlayIp: string;
  secret: string;
  noeuds: Noeud[];
  inventaire: Inventaire;
  /** Portail de paiement, joignable AVANT connexion (walled garden, SPEC §6.2 étape 2 et §7.1) : nom d'hôte, et IP
   *  dédiées (WAKATNET_PORTAIL_IPS) qui autorisent le HTTPS sans dépendre du nom d'hôte (LABO-14). */
  portail: { hote: string; ips: string[] };
  /** Étape 3 (ADR 0023) : URL d'entretien propre au routeur (jeton compris) ; absente, aucun script planifié. */
  urlEntretien?: string;
};

/** Ce que l'entretien (étape 3, ADR 0023) regénère : tout sauf l'inventaire, la preuve du tunnel et l'activation. */
/** Le secret RADIUS n'en fait PAS partie (relecture de sécurité n° 7) : le script le relit sur le routeur, il ne
 *  voyage jamais par l'URL d'entretien. */
export type Entretien = Omit<Etape2, "inventaire" | "urlEntretien" | "secret"> & { coaPort: number; listenPort: number };

/** Objets marqués « wakatnet », créés s'ils manquent, remis à jour s'ils existent (nouvelle IP d'un nœud, nouveau
 *  nœud, IP du portail) : commun à l'étape 2 et à l'entretien. Additif : rien d'autre n'est touché ni réordonné. */
/** `secret` : la valeur (étape 2) ou null (entretien : variable $wkSecret, relue sur le routeur). */
function blocsWakatnet(e: Omit<Entretien, "coaPort" | "listenPort">, secret: string | null, coa: number, lp: number): string[] {
  const moi = ip(e.overlayIp);
  if (secret !== null && !/^[A-Za-z0-9]{32}$/.test(secret)) throw new ValeurInterdite("secret RADIUS de forme inattendue");
  if (e.noeuds.length === 0) throw new ValeurInterdite("aucun noeud configure");
  const valeurSecret = secret === null ? "$wkSecret" : chaine(secret);
  const lignes: string[] = [];
  const marque = (n: Noeud) => chaine(`wakatnet noeud ${n.nom}`);
  lignes.push(`# --- Pairs WireGuard (un par noeud) ; IP ou port d'un noeud deplace : mis a jour ---`);
  for (const n of e.noeuds) {
    const k = chaine(cle(n.cle));
    const attributs = `endpoint-address=${ip(n.endpoint)} endpoint-port=${port(n.port)} allowed-address=${ip(n.overlay)}/32`;
    lignes.push(`:if ([:len [/interface wireguard peers find where interface="wg-wakatnet" public-key=${k}]] = 0) do={ /interface wireguard peers add interface="wg-wakatnet" public-key=${k} ${attributs} persistent-keepalive=25s comment=${marque(n)} } else={ /interface wireguard peers set [find where interface="wg-wakatnet" public-key=${k}] ${attributs} }`);
  }
  lignes.push(`# --- Adresse du routeur dans le tunnel, routes vers les noeuds ---`);
  lignes.push(`:if ([:len [/ip address find where address="${moi}/32" interface="wg-wakatnet"]] = 0) do={ /ip address add address=${moi}/32 interface="wg-wakatnet" comment="wakatnet adresse du tunnel" }`);
  for (const n of e.noeuds) {
    lignes.push(`:if ([:len [/ip route find where dst-address="${ip(n.overlay)}/32" comment~"^wakatnet"]] = 0) do={ /ip route add dst-address=${ip(n.overlay)}/32 gateway="wg-wakatnet" comment=${marque(n)} }`);
  }
  lignes.push(`# --- Serveurs RADIUS : l'ordre fait la priorite (A, puis B) ---`);
  for (const n of e.noeuds) {
    const o = ip(n.overlay);
    lignes.push(`:if ([:len [/radius find where address=${o} comment~"^wakatnet"]] = 0) do={ /radius add service=hotspot address=${o} src-address=${moi} secret=${valeurSecret} timeout=3s require-message-auth=yes-for-request-resp comment=${marque(n)} } else={ /radius set [find where address=${o} comment~"^wakatnet"] service=hotspot src-address=${moi} secret=${valeurSecret} }`);
  }
  lignes.push(`# --- Pare-feu : insertion EN TETE de la chaine input, sans reordonner l'existant (ADR 0012 section 9) ---`);
  const regles: string[] = [];
  for (const n of e.noeuds) {
    const o = ip(n.overlay);
    regles.push(`chain=input in-interface="wg-wakatnet" src-address=${o} protocol=udp dst-port=${coa} action=accept comment=${chaine(`wakatnet CoA noeud ${n.nom}`)}`);
    regles.push(`chain=input in-interface="wg-wakatnet" src-address=${o} protocol=udp src-port=1812,1813 action=accept comment=${chaine(`wakatnet reponses RADIUS noeud ${n.nom}`)}`);
    regles.push(`chain=input in-interface="wg-wakatnet" src-address=${o} protocol=icmp action=accept comment=${chaine(`wakatnet ICMP noeud ${n.nom}`)}`);
    regles.push(`chain=input src-address=${ip(n.endpoint)} protocol=udp src-port=${port(n.port)} dst-port=${lp} action=accept comment=${chaine(`wakatnet WireGuard noeud ${n.nom}`)}`);
  }
  for (const r of regles) {
    const commentaire = /comment=("(?:[^"\\]|\\.)*")$/.exec(r)![1];
    const sansCommentaire = r.slice(0, r.length - `comment=${commentaire}`.length).trim();
    lignes.push(`:if ([:len [/ip firewall filter find where comment=${commentaire}]] = 0) do={ :local tete [/ip firewall filter find where chain=input dynamic=no]; :if ([:len $tete] > 0) do={ /ip firewall filter add ${r} place-before=[:pick $tete 0] } else={ /ip firewall filter add ${r} } } else={ /ip firewall filter set [find where comment=${commentaire}] ${sansCommentaire} }`);
  }
  lignes.push(`# --- Walled garden : le portail de paiement, joignable AVANT connexion (SPEC section 6.2, 7.1) ---`);
  // HTTPS : par l'IP dédiée du portail (le nom d'hôte n'est pas lisible dans TLS ; LABO-14). HTTP : par nom d'hôte,
  // pour la redirection vers HTTPS. Additif : rien d'existant n'est modifié ; retiré à la désinstallation.
  const hote = hoteDns(e.portail.hote);
  lignes.push(`:if ([:len [/ip hotspot walled-garden find where comment="wakatnet portail http"]] = 0) do={ /ip hotspot walled-garden add dst-host=${chaine(hote)} action=allow comment="wakatnet portail http" } else={ /ip hotspot walled-garden set [find where comment="wakatnet portail http"] dst-host=${chaine(hote)} action=allow }`);
  for (const a of e.portail.ips) {
    const c = chaine(`wakatnet portail ${ip(a)}`);
    lignes.push(`:if ([:len [/ip hotspot walled-garden ip find where comment=${c}]] = 0) do={ /ip hotspot walled-garden ip add action=accept dst-address=${ip(a)} protocol=tcp dst-port=443 comment=${c} }`);
  }
  // Relecture de sécurité n° 5 : une ancienne IP du portail ne reste pas ouverte avant connexion. Seules les entrées
  // « wakatnet portail <ip> » sont retirées, et jamais toutes (liste vide : rien n'est retiré).
  if (e.portail.ips.length > 0) {
    const garder = e.portail.ips.map((a) => `$c != ${chaine(`wakatnet portail ${ip(a)}`)}`).join(" && ");
    lignes.push(`:foreach i in=[/ip hotspot walled-garden ip find where comment~"^wakatnet portail "] do={ :local c [/ip hotspot walled-garden ip get $i comment]; :if (${garder}) do={ /ip hotspot walled-garden ip remove $i } }`);
  }
  return lignes;
}

/** Étape 2 : pairs, adresse, routes, /radius, pare-feu, preuve du tunnel, puis activation. */
export function etape2(e: Etape2): string {
  const moi = ip(e.overlayIp);
  const coa = port(e.inventaire.coa_port);
  const lp = port(e.inventaire.listen_port);
  if (!/^[A-Za-z0-9]{32}$/.test(e.secret)) throw new ValeurInterdite("secret RADIUS de forme inattendue");
  if (e.noeuds.length === 0) throw new ValeurInterdite("aucun noeud configure");

  const lignes: string[] = [];
  lignes.push(`# WAKATNET - enrolement, etape 2 : configuration de ${moi}.`);
  lignes.push(`# Contient le secret RADIUS du routeur : ce fichier se supprime lui-meme a la fin.`);
  lignes.push(`{`);
  lignes.push(...blocsWakatnet(e, e.secret, coa, lp));
  // CoA accepté : posé à l'étape 2 seulement ; l'entretien ne le réactive pas (relecture de sécurité n° 5).
  lignes.push(`/radius incoming set accept=yes`);
  lignes.push(`# --- Preuve du tunnel : chaque noeud repond au ping A TRAVERS wg-wakatnet (donc handshake fait) ---`);
  lignes.push(`:local ok false`);
  lignes.push(`:for i from=1 to=15 do={`);
  lignes.push(`  :if (!$ok) do={`);
  lignes.push(`    :local tous true`);
  for (const n of e.noeuds) {
    lignes.push(`    :if ([/ping ${ip(n.overlay)} src-address=${moi} count=1] = 0) do={ :set tous false }`);
  }
  lignes.push(`    :if ($tous) do={ :set ok true } else={ :delay 2s }`);
  lignes.push(`  }`);
  lignes.push(`}`);
  lignes.push(`:if (!$ok) do={ :error "WAKATNET : le tunnel vers la plateforme ne repond pas. Le hotspot n'a PAS ete modifie. Verifiez que le routeur peut envoyer de l'UDP vers ${e.noeuds.map((n) => `${n.endpoint}:${n.port}`).join(", ")}, puis relancez : /import file-name=wakatnet-etape2.rsc" }`);
  if (e.urlEntretien !== undefined) {
    lignes.push(`# --- Etape 3 (entretien) : configuration WAKATNET tiree toutes les 6 h ; desactivable : /system scheduler disable wakatnet-entretien ---`);
    lignes.push(...planificateur(e.urlEntretien));
  }
  lignes.push(`# --- Activation, en dernier (R5) ---`);
  for (const h of e.inventaire.hotspots) {
    lignes.push(`/ip hotspot profile set [find where name=${chaine(h.profil)}] use-radius=yes radius-accounting=yes radius-interim-update=received`);
  }
  lignes.push(`/file remove [find where name="wakatnet-etape2.rsc"]`);
  lignes.push(`:put "WAKATNET : routeur enrole, adresse ${moi}. Les utilisateurs locaux existants restent valables."`);
  lignes.push(`}`);
  return lignes.join("\n") + "\n";
}

/** Script planifié de l'étape 3 (ADR 0023). Un échec (réseau, 404 d'un routeur révoqué) ne change rien sur le routeur.
 *  Un planificateur existant n'est pas réactivé : s'il a été désactivé par le propriétaire, il le reste. */
export function planificateur(url: string): string[] {
  if (!/^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?\/entretien\/[A-Za-z0-9_-]{43}$/.test(url)) throw new ValeurInterdite("URL d'entretien invalide");
  // check-certificate=yes : sans lui, quiconque est sur le chemin réseau servirait le script importé (relecture de
  // sécurité n° 1, SPEC §6.2 exigence 6). Pas de droit « policy » : rien dans l'entretien ne touche aux utilisateurs.
  // Sans fichier : le script est téléchargé en mémoire (`output=user`) et exécuté par `:parse`. Un fichier intermédiaire
  // exigeait le droit « ftp » (banc CHR 7.19.4, 14/11/2026 : « cannot open file: permission denied ») ; ce droit
  // aurait permis à un script importé de lire les sauvegardes et de réécrire les pages du portail, et un compte local
  // « ftp » aurait pu remplacer le fichier entre le téléchargement et l'import (relecture du 14/11/2026). `:parse`
  // analyse tout avant d'exécuter : un script tronqué ou mal formé n'applique rien.
  // Le `set` réécrit droits, intervalle et événement ; seul `disabled` est préservé.
  const evenement = `:do { :local r [/tool fetch url="${url}" check-certificate=yes output=user as-value]; `
    + `:if (($r->"status") != "finished") do={ :error "telechargement incomplet" }; `
    + `:local f [:parse ($r->"data")]; $f } `
    + `on-error={ :log warning "wakatnet : entretien indisponible, configuration inchangee" }`;
  const e = chaine(evenement);
  return [`:if ([:len [/system scheduler find where name="wakatnet-entretien"]] = 0) do={ /system scheduler add name="wakatnet-entretien" interval=6h policy=read,write,test,sensitive on-event=${e} comment="wakatnet entretien (desactivable)" } else={ /system scheduler set [find where name="wakatnet-entretien"] interval=6h policy=read,write,test,sensitive on-event=${e} }`];
}

/** `fetch output=user` garde la réponse dans une variable, de taille limitée (environ 64 Kio d'après la documentation
 *  MikroTik, non mesuré) : on refuse bien avant. L'entretien d'un routeur à deux nœuds fait environ 6 Kio. */
export const TAILLE_MAX_ENTRETIEN = 32 * 1024;

/** Étape 3, entretien (SPEC §6.2, ADR 0023) : regénère les objets « wakatnet » ; jamais l'activation ni l'inventaire.
 *  Aucun secret dans le script : le secret RADIUS est relu sur le routeur (relecture de sécurité n° 7). Exécuté en
 *  mémoire par le planificateur, sans fichier ; sa taille est bornée (TAILLE_MAX_ENTRETIEN). */

export function entretien(e: Entretien): string {
  const coa = port(e.coaPort);
  const lp = port(e.listenPort);
  const lignes = [`# WAKATNET - entretien (etape 3) de ${ip(e.overlayIp)} : objets wakatnet seulement.`, `{`];
  // Secret RADIUS relu sur le routeur (droit « sensitive » du planificateur) : il ne voyage jamais par l'entretien.
  lignes.push(`:local wkSecret ""`);
  lignes.push(`:do { :set wkSecret [/radius get [:pick [/radius find where comment~"^wakatnet"] 0] secret] } on-error={}`);
  lignes.push(`:if ([:len $wkSecret] = 0) do={ :error "WAKATNET : entretien impossible, aucun serveur RADIUS wakatnet sur ce routeur. Rien n'a ete modifie." }`);
  lignes.push(...blocsWakatnet(e, null, coa, lp));
  lignes.push(`:log info "wakatnet : entretien applique"`);
  lignes.push(`}`);
  const texte = lignes.join("\n") + "\n";
  if (Buffer.byteLength(texte) > TAILLE_MAX_ENTRETIEN) throw new ValeurInterdite("entretien trop long pour output=user");
  return texte;
}

/** Désinstallation (R6) : désactive RADIUS d'abord, puis retire tout objet marqué « wakatnet ». */
export function desinstallation(inventaire: Inventaire): string {
  const lignes: string[] = [];
  lignes.push(`# WAKATNET - desinstallation : retablit les profils hotspot et retire tout ce qui porte le commentaire " wakatnet ".`);
  lignes.push(`# Ne touche a aucun autre objet. Peut etre rejoue sans dommage.`);
  lignes.push(`{`);
  lignes.push(`# --- Profils hotspot : valeurs d'origine relevees a l'enrolement ---`);
  const vus = new Set<string>();
  for (const h of inventaire.hotspots) {
    if (vus.has(h.profil)) continue;
    vus.add(h.profil);
    const interim = /^[0-9a-z:.]{1,16}$/.test(h.radius_interim_update) ? h.radius_interim_update : "received";
    lignes.push(`:if ([:len [/ip hotspot profile find where name=${chaine(h.profil)}]] > 0) do={ /ip hotspot profile set [find where name=${chaine(h.profil)}] use-radius=${h.use_radius ? "yes" : "no"} radius-accounting=${h.radius_accounting ? "yes" : "no"} radius-interim-update=${interim} }`);
  }
  lignes.push(`/radius incoming set accept=${inventaire.coa_accept ? "yes" : "no"}`);
  lignes.push(`/system scheduler remove [find where comment~"^wakatnet"]`);
  lignes.push(`/radius remove [find where comment~"^wakatnet"]`);
  lignes.push(`/ip hotspot walled-garden remove [find where comment~"^wakatnet"]`);
  lignes.push(`/ip hotspot walled-garden ip remove [find where comment~"^wakatnet"]`);
  lignes.push(`/ip firewall filter remove [find where comment~"^wakatnet"]`);
  lignes.push(`/ip route remove [find where comment~"^wakatnet"]`);
  lignes.push(`/ip address remove [find where comment~"^wakatnet"]`);
  lignes.push(`/interface wireguard peers remove [find where comment~"^wakatnet"]`);
  lignes.push(`/interface wireguard remove [find where name="wg-wakatnet" comment~"^wakatnet"]`);
  lignes.push(`/certificate remove [find where name~"^wakatnet racine "]`);
  lignes.push(`/file remove [find where name~"^wakatnet-"]`);
  lignes.push(`:put "WAKATNET : desinstallation terminee. Le hotspot fonctionne de nouveau avec ses seuls utilisateurs locaux."`);
  lignes.push(`:put "Les certificats racines importes a l'enrolement (wakatnet racine ...) sont retires : un autre service qui s'en servait doit les reimporter."`);
  lignes.push(`}`);
  return lignes.join("\n") + "\n";
}
