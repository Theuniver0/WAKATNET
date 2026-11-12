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

function port(v: number): number {
  if (!Number.isInteger(v) || v < 1 || v > 65535) throw new ValeurInterdite(`port invalide : ${v}`);
  return v;
}

/** Commande à coller par le propriétaire (SPEC §6.2). */
export function commande(urlPublique: string, jeton: string): string {
  const url = chaine(`${urlPublique}/enroll/${jeton}`);
  return [
    `/tool fetch url=${url} check-certificate=yes dst-path="wakatnet-enroll.rsc"`,
    `/import file-name="wakatnet-enroll.rsc"`,
  ].join("\n");
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
};

/** Étape 2 : pairs, adresse, routes, /radius, pare-feu, preuve du tunnel, puis activation. */
export function etape2(e: Etape2): string {
  const moi = ip(e.overlayIp);
  const coa = port(e.inventaire.coa_port);
  const lp = port(e.inventaire.listen_port);
  if (!/^[A-Za-z0-9]{32}$/.test(e.secret)) throw new ValeurInterdite("secret RADIUS de forme inattendue");
  if (e.noeuds.length === 0) throw new ValeurInterdite("aucun noeud configure");

  const lignes: string[] = [];
  const marque = (n: Noeud) => chaine(`wakatnet noeud ${n.nom}`);

  lignes.push(`# WAKATNET - enrolement, etape 2 : configuration de ${moi}.`);
  lignes.push(`# Contient le secret RADIUS du routeur : ce fichier se supprime lui-meme a la fin.`);
  lignes.push(`{`);
  lignes.push(`# --- Pairs WireGuard (un par noeud) ---`);
  for (const n of e.noeuds) {
    const k = chaine(cle(n.cle));
    lignes.push(`:if ([:len [/interface wireguard peers find where interface="wg-wakatnet" public-key=${k}]] = 0) do={ /interface wireguard peers add interface="wg-wakatnet" public-key=${k} endpoint-address=${ip(n.endpoint)} endpoint-port=${port(n.port)} allowed-address=${ip(n.overlay)}/32 persistent-keepalive=25s comment=${marque(n)} }`);
  }
  lignes.push(`# --- Adresse du routeur dans le tunnel, routes vers les noeuds ---`);
  lignes.push(`:if ([:len [/ip address find where address="${moi}/32" interface="wg-wakatnet"]] = 0) do={ /ip address add address=${moi}/32 interface="wg-wakatnet" comment="wakatnet adresse du tunnel" }`);
  for (const n of e.noeuds) {
    lignes.push(`:if ([:len [/ip route find where dst-address="${ip(n.overlay)}/32" comment~"^wakatnet"]] = 0) do={ /ip route add dst-address=${ip(n.overlay)}/32 gateway="wg-wakatnet" comment=${marque(n)} }`);
  }
  lignes.push(`# --- Serveurs RADIUS : l'ordre fait la priorite (A, puis B) ---`);
  for (const n of e.noeuds) {
    const o = ip(n.overlay);
    lignes.push(`:if ([:len [/radius find where address=${o} comment~"^wakatnet"]] = 0) do={ /radius add service=hotspot address=${o} src-address=${moi} secret=${chaine(e.secret)} timeout=3s require-message-auth=yes-for-request-resp comment=${marque(n)} } else={ /radius set [find where address=${o} comment~"^wakatnet"] service=hotspot src-address=${moi} secret=${chaine(e.secret)} }`);
  }
  lignes.push(`/radius incoming set accept=yes`);
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
    lignes.push(`:if ([:len [/ip firewall filter find where comment=${commentaire}]] = 0) do={ :local tete [/ip firewall filter find where chain=input dynamic=no]; :if ([:len $tete] > 0) do={ /ip firewall filter add ${r} place-before=[:pick $tete 0] } else={ /ip firewall filter add ${r} } }`);
  }
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
  lignes.push(`# --- Activation, en dernier (R5) ---`);
  for (const h of e.inventaire.hotspots) {
    lignes.push(`/ip hotspot profile set [find where name=${chaine(h.profil)}] use-radius=yes radius-accounting=yes radius-interim-update=received`);
  }
  lignes.push(`/file remove [find where name="wakatnet-etape2.rsc"]`);
  lignes.push(`:put "WAKATNET : routeur enrole, adresse ${moi}. Les utilisateurs locaux existants restent valables."`);
  lignes.push(`}`);
  return lignes.join("\n") + "\n";
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
  lignes.push(`/radius remove [find where comment~"^wakatnet"]`);
  lignes.push(`/ip firewall filter remove [find where comment~"^wakatnet"]`);
  lignes.push(`/ip route remove [find where comment~"^wakatnet"]`);
  lignes.push(`/ip address remove [find where comment~"^wakatnet"]`);
  lignes.push(`/interface wireguard peers remove [find where comment~"^wakatnet"]`);
  lignes.push(`/interface wireguard remove [find where name="wg-wakatnet" comment~"^wakatnet"]`);
  lignes.push(`/file remove [find where name~"^wakatnet-"]`);
  lignes.push(`:put "WAKATNET : desinstallation terminee. Le hotspot fonctionne de nouveau avec ses seuls utilisateurs locaux."`);
  lignes.push(`}`);
  return lignes.join("\n") + "\n";
}
