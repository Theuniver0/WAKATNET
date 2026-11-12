// Scripts RouterOS générés (R1–R7, SPEC §6.2, ADR 0012 §9). Tests sur le TEXTE : l'exécution
// sur CHR reste à faire par Yacouba (écart R8 du PRD de la phase 2, §6).
// Ticket : .scratch/phase-2-multi-proprietaires/issues/04-scripts-routeros.md
import assert from "node:assert/strict";
import { test } from "node:test";
import { chaine, commande, desinstallation, etape1, etape2, ValeurInterdite, type Inventaire } from "../src/routeros.ts";
import { NOEUDS } from "./aide-sans-base.ts";

const PIEGE = 'p"] ; /system reset-configuration ; :put [ "$x?\\';

function inventaire(profil = "hsprof1"): Inventaire {
  return {
    identity: "Zone", modele: "hAP", version: "7.15.3 (stable)", listen_port: 13231, coa_port: 3799, coa_accept: false,
    hotspots: [
      { serveur: "hs1", profil, use_radius: false, html_directory: "hotspot", radius_accounting: true, radius_interim_update: "received" },
      { serveur: "hs2", profil, use_radius: false, html_directory: "hotspot", radius_accounting: false, radius_interim_update: "5m" },
    ],
  };
}

const E2 = () => etape2({ overlayIp: "10.213.1.7", secret: "S".repeat(32), noeuds: NOEUDS, inventaire: inventaire() });

/**
 * Découpe les chaînes "…" d'une ligne RouterOS ; échoue si un guillemet reste ouvert.
 * strict : aucune substitution « $ » ni « ? » nu (scripts qui recopient des valeurs du routeur).
 * L'étape 1 interpole volontairement ses propres variables ($v, $prof) dans ses messages.
 */
function chaines(ligne: string, strict = true): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < ligne.length) {
    if (ligne[i] === "#" && out.length === 0 && ligne.slice(0, i).trim() === "") return out;
    if (ligne[i] !== '"') { i++; continue; }
    let v = "";
    i++;
    while (true) {
      assert.ok(i < ligne.length, `guillemet non fermé : ${ligne}`);
      if (ligne[i] === "\\") { v += ligne[i + 1]; i += 2; continue; }
      if (ligne[i] === '"') { i++; break; }
      assert.ok(!strict || (ligne[i] !== "$" && ligne[i] !== "?"), `« ${ligne[i]} » non échappé dans une chaîne : ${ligne}`);
      v += ligne[i++];
    }
    out.push(v);
  }
  return out;
}

const lignesUtiles = (s: string) => s.split("\n").filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));

test("chaine : échappe \\ \" $ ? et refuse les caractères de contrôle", () => {
  assert.equal(chaine('a"b\\c$d?e'), '"a\\"b\\\\c\\$d\\?e"');
  assert.deepEqual(chaines(`x=${chaine(PIEGE)}`), [PIEGE]);
  for (const c of ["\n", "\r", "\t", "\u0000", "\u007f"]) assert.throws(() => chaine(`a${c}b`), ValeurInterdite);
});

test("un nom de profil piégé reste une seule chaîne, dans chaque script", () => {
  const inv = inventaire(PIEGE);
  for (const s of [etape2({ overlayIp: "10.213.1.7", secret: "S".repeat(32), noeuds: NOEUDS, inventaire: inv }), desinstallation(inv)]) {
    const avec = lignesUtiles(s).filter((l) => l.includes("reset-configuration"));
    assert.ok(avec.length > 0);
    for (const l of avec) assert.ok(chaines(l).includes(PIEGE), l);
  }
});

test("scripts en ASCII seul, guillemets équilibrés, un seul bloc { }", () => {
  for (const [s, strict] of [[etape1("https://api.x", "j".repeat(43), new Date(0)), false], [E2(), true],
                             [desinstallation(inventaire()), true]] as const) {
    assert.match(s, /^[\x09\x0a\x20-\x7e]*$/, "caractère non ASCII");
    const utiles = lignesUtiles(s);
    assert.equal(utiles[0], "{");
    assert.equal(utiles.at(-1), "}");
    for (const l of utiles) chaines(l, strict);
  }
});

test("R3 : tout objet ajouté porte un commentaire « wakatnet »", () => {
  for (const s of [etape1("https://api.x", "j".repeat(43), new Date(0)), E2()]) {
    const ajouts = lignesUtiles(s).flatMap((l) => [...l.matchAll(/\/(?:[a-z-]+ )+add ([^}]*)/g)].map((m) => m[1]));
    assert.ok(ajouts.length > 0);
    for (const a of ajouts) assert.match(a, /comment="wakatnet[^"]*"/, a);
  }
});

test("R2 : aucune suppression hors objets marqués ; R7 : toute modification par [find …]", () => {
  for (const s of [etape1("https://api.x", "j".repeat(43), new Date(0)), E2()]) {
    for (const l of lignesUtiles(s)) {
      for (const m of l.matchAll(/(\/[a-z /-]+) remove (\[[^\]]*\])/g)) {
        assert.match(m[0], /\/file remove \[find where name="wakatnet-(enroll|etape2)\.rsc"\]/, l);
      }
      for (const m of l.matchAll(/ set (\S+)/g)) {
        if (m[1].startsWith("$") || m[1].startsWith("(") || m[1] === "accept=yes") continue;   // :set de variable, /radius incoming
        assert.ok(m[1].startsWith("[find"), l);
      }
    }
  }
});

test("R5 : use-radius=yes vient en dernier, après la preuve du tunnel", () => {
  const l = lignesUtiles(E2());
  const preuve = l.findIndex((x) => x.includes(':if (!$ok) do={ :error'));
  const active = l.map((x, i) => (x.includes("use-radius=yes") ? i : -1)).filter((i) => i >= 0);
  assert.ok(preuve > 0 && active.length === 2);
  assert.ok(active.every((i) => i > preuve));
  // Après l'activation : seulement l'effacement du fichier et le message final.
  assert.ok(l.slice(Math.max(...active) + 1).every((x) => /^(\/file remove|:put|\})/.test(x)));
  // Un ping par nœud, à travers le tunnel (source = adresse du routeur).
  for (const n of NOEUDS) assert.ok(l.some((x) => x.includes(`/ping ${n.overlay} src-address=10.213.1.7`)));
});

test("R4 : pare-feu limité au tunnel et aux nœuds, inséré en tête sans réordonner", () => {
  const regles = lignesUtiles(E2()).filter((l) => l.includes("/ip firewall filter add"));
  assert.equal(regles.length, 4 * NOEUDS.length);
  for (const r of regles) {
    assert.match(r, /action=accept/);
    assert.ok(!/action=(drop|reject)|move|disabled=/.test(r), r);
    assert.ok(NOEUDS.some((n) => r.includes(`src-address=${n.overlay}`) || r.includes(`src-address=${n.endpoint}`)), r);
    // Le hotspot place des règles DYNAMIQUES en tête de input : place-before ne vise que les statiques.
    if (r.includes("place-before")) assert.match(r, /\[\/ip firewall filter find where chain=input dynamic=no\]/, r);
  }
});

test("étape 1 : tous les refus précèdent la première création ; aucune clé privée lue", () => {
  const l = lignesUtiles(etape1("https://api.x", "j".repeat(43), new Date(0)));
  const premiereCreation = l.findIndex((x) => /\/interface wireguard add/.test(x));
  const dernierRefus = Math.max(...l.map((x, i) => (/:error "WAKATNET : (RouterOS 7\.15|une adresse|une route|un autre serveur|le profil|aucun serveur)/.test(x) ? i : -1)));
  assert.ok(premiereCreation > dernierRefus, `${premiereCreation} ${dernierRefus}`);
  assert.ok(!/private-key/.test(l.join("\n")));
});

test("idempotence (R1) : chaque création est gardée par un test d'existence", () => {
  for (const l of lignesUtiles(E2())) {
    if (/ add /.test(l)) assert.match(l, /^:if \(\[:len \[[^\]]*find where /, l);
  }
});

test("désinstallation : profils rétablis à leurs valeurs d'origine, puis retrait des seuls objets marqués", () => {
  const l = lignesUtiles(desinstallation(inventaire()));
  const profils = l.filter((x) => x.includes("/ip hotspot profile set"));
  assert.equal(profils.length, 1, "un profil partagé n'est rétabli qu'une fois");
  assert.match(profils[0], /use-radius=no radius-accounting=yes radius-interim-update=received/);
  assert.ok(l.includes("/radius incoming set accept=no"));
  const retraits = l.filter((x) => / remove /.test(x));
  for (const r of retraits) assert.match(r, /find where (comment~"\^wakatnet"|name="wg-wakatnet" comment~"\^wakatnet"|name~"\^wakatnet-")/, r);
  const ordre = (motif: string) => l.findIndex((x) => x.includes(motif));
  assert.ok(ordre("/ip hotspot profile set") < ordre("/radius remove"));
  assert.ok(ordre("/radius remove") < ordre("/interface wireguard remove"));
});

test("commande à coller : deux lignes, URL échappée, vérification du certificat", () => {
  assert.equal(commande("https://api.x", "a".repeat(43)),
    `/tool fetch url="https://api.x/enroll/${"a".repeat(43)}" check-certificate=yes dst-path="wakatnet-enroll.rsc"\n/import file-name="wakatnet-enroll.rsc"`);
});

test("valeurs serveur invalides : refus de générer", () => {
  const base = { overlayIp: "10.213.1.7", secret: "S".repeat(32), noeuds: NOEUDS, inventaire: inventaire() };
  assert.throws(() => etape2({ ...base, overlayIp: "10.213.1.7; /x" }), ValeurInterdite);
  assert.throws(() => etape2({ ...base, secret: 'a"b'.padEnd(32, "x") }), ValeurInterdite);
  assert.throws(() => etape2({ ...base, noeuds: [] }), ValeurInterdite);
  assert.throws(() => etape2({ ...base, inventaire: { ...inventaire(), coa_port: 0 } }), ValeurInterdite);
});
