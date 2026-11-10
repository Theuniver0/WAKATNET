#!/usr/bin/env bash
# test-serveur-vm.sh — test PARTIEL de serveur-vm.sh, sans VM ni systemd.
#
# Isolement : nouvel espace de noms de montage ET réseau (unshare -m -n) ;
# /etc/wireguard, /etc/systemd/system et /etc/nftables.conf masqués par des
# tmpfs / fichiers temporaires ; systemctl remplacé par un bouchon qui affiche
# l'appel. Les règles nftables ne touchent que l'espace de noms réseau isolé.
# Les paquets (irtt, wireguard-tools, nftables, chrony, iputils-ping) doivent
# déjà être installés : l'espace de noms isolé n'a pas de réseau pour apt-get.
# Aucune clé n'est affichée : la clé publique est remplacée par un marqueur.
#
# Usage (root) : outils/test-serveur-vm.sh > evidence/serveur-vm-partiel.txt
set -u
ICI="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
printf '#!/bin/sh\necho "[stub] systemctl $*"\n' > "$TMP/bin/systemctl"
chmod +x "$TMP/bin/systemctl"
cp "$ICI/serveur-vm.sh" "$TMP/serveur-vm.sh"
: > "$TMP/nftables.conf"
CLE_TEST_1=$(wg genkey | wg pubkey)
CLE_TEST_2=$(wg genkey | wg pubkey)

unshare -m -n bash -s "$TMP" "$CLE_TEST_1" "$CLE_TEST_2" <<'EOF'
set -u
TMP="$1" C1="$2" C2="$3"
mount -t tmpfs tmpfs /etc/wireguard
mount -t tmpfs tmpfs /etc/systemd/system
mount --bind "$TMP/nftables.conf" /etc/nftables.conf
ip link set lo up
export PATH="$TMP/bin:$PATH"
S="$TMP/serveur-vm.sh"
masque() { sed -E 's#[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=#<clé publique>#g'; }
echo "### 1er passage : WG_ADRESSE=10.254.213.1/24 WG_ADRESSE_R=10.254.214.1/24 installer"
WG_ADRESSE=10.254.213.1/24 WG_ADRESSE_R=10.254.214.1/24 "$S" installer 2>&1 | masque; echo "rc=${PIPESTATUS[0]}"
echo "### 2e passage (idempotence)"
WG_ADRESSE=10.254.213.1/24 WG_ADRESSE_R=10.254.214.1/24 "$S" installer 2>&1 | masque; echo "rc=${PIPESTATUS[0]}"
echo "### fichiers créés"
ls -l /etc/wireguard | sed 's/ [A-Z][a-z][a-z] [ 0-9][0-9] [0-9:]* / /'
echo "### PrivateKey dans wg-labo.conf (attendu 0) : $(grep -c PrivateKey /etc/wireguard/wg-labo.conf)"
echo "### ligne Address de wg-labo.conf"
grep '^Address' /etc/wireguard/wg-labo.conf
echo "### override irtt"
cat /etc/systemd/system/irtt.service.d/wakatnet-labo.conf
echo "### ruleset nftables dans le netns"
nft list ruleset
echo "### ajouter-pair sonde-l 10.254.213.11 (variante L)"
"$S" ajouter-pair ouaga1-fibre "$C1" 10.254.213.11 2>&1 | masque; echo "rc=${PIPESTATUS[0]}"
echo "### ajouter-pair routeur-r 10.254.214.21 (variante R)"
"$S" ajouter-pair ouaga1-fibre-r "$C2" 10.254.214.21 2>&1 | masque; echo "rc=${PIPESTATUS[0]}"
echo "### refus : IP 10.254.213.11 déjà attribuée à ouaga1-fibre"
"$S" ajouter-pair autre-sonde "$C2" 10.254.213.11 2>&1 | masque; echo "rc=${PIPESTATUS[0]}"
echo "### même NOM, nouvelle clé, même IP : mise à jour acceptée"
"$S" ajouter-pair ouaga1-fibre "$C2" 10.254.213.11 2>&1 | masque; echo "rc=${PIPESTATUS[0]}"
echo "### fichier des pairs (NOM CLE IP)"
masque < /etc/wireguard/wg-labo.pairs
echo "### refus clé invalide"
"$S" ajouter-pair x pas-une-cle 10.254.213.12; echo "rc=$?"
echo "### refus IP hors plage"
"$S" ajouter-pair x "$C1" 10.213.0.5; echo "rc=$?"
echo "### refus WG_ADRESSE_R hors plage"
WG_ADRESSE_R=10.213.0.1/24 "$S" etat >/dev/null 2>"$TMP/err"; echo "rc=$? $(cat "$TMP/err")"
EOF
