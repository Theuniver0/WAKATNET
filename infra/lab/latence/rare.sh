#!/usr/bin/env bash
# rare.sh — flux CLAIRSEMÉ de mesure : un ping toutes les MIN à MAX secondes
# (intervalle tiré au hasard), pour voir ce que le flux continu d'irtt masque :
#   - le délai de réveil radio en 4G (premier paquet après un silence) ;
#   - l'expiration d'une traduction NAT / CGNAT entre deux keepalive WireGuard,
#     dans le sens VM -> routeur (chemin du CoA, SPEC §6.1).
# RADIUS est un trafic clairsemé : c'est ce flux qui lui ressemble.
#
# Le ping vise une adresse DANS le tunnel WireGuard : à l'extérieur, c'est de
# l'UDP WireGuard, comme RADIUS. Pendant la phase clairsemée, aucun flux dense
# ne doit tourner sur le même accès (voir PROTOCOLE §5.6 bis) : sinon la radio
# ne retombe jamais au repos et la mesure ne prouve rien.
#
# Usage :
#   rare.sh -s SITE -a ACCES -n NOM -c IP -o DOSSIER [-m 20] [-M 60] [-W 5]
#           [-F FIN_UTC | -D SECONDES]
#     -n NOM   nom du flux, [a-z0-9-] ; « <cible>-rare » (ex. fsn-wg-rare) pour que
#              analyse.py le compare au flux dense <cible> ; « retour-fsn » pour le
#              sens VM -> routeur (lancé sur la VM, vers l'adresse de la sonde
#              dans le tunnel)
#     -c IP    adresse visée (dans le tunnel)
#     -m / -M  intervalle mini / maxi en secondes (défaut 20 / 60)
#     -W SEC   attente maximale d'une réponse (défaut 5)
#
# Sortie : DOSSIER/AAAA-MM-JJ-<site>-<acces>-<nom>.rare.log, une ligne par ping :
#   <ISO UTC> epoch_ms=<ms> nom=<nom> ip=<ip> rtt_ms=<x> | perdu=oui
# Aucun secret. Code de sortie : 0 fin normale, 2 usage, 3 environnement,
# 4 date -F déjà passée.

set -u
SITE="" ACCES="" NOM="" IP="" DOSSIER="" MIN=20 MAX=60 ATTENTE=5 FIN_ABS="" DUREE_S=0
usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
while getopts "s:a:n:c:o:m:M:W:F:D:h" opt; do
  case "$opt" in
    s) SITE="$OPTARG" ;; a) ACCES="$OPTARG" ;; n) NOM="$OPTARG" ;; c) IP="$OPTARG" ;;
    o) DOSSIER="$OPTARG" ;; m) MIN="$OPTARG" ;; M) MAX="$OPTARG" ;; W) ATTENTE="$OPTARG" ;;
    F) FIN_ABS="$OPTARG" ;; D) DUREE_S="$OPTARG" ;; *) usage ;;
  esac
done
[ -n "$SITE" ] && [ -n "$ACCES" ] && [ -n "$NOM" ] && [ -n "$IP" ] && [ -n "$DOSSIER" ] || usage
[[ "$SITE" =~ ^[a-z0-9]+$ && "$ACCES" =~ ^[a-z0-9]+$ && "$NOM" =~ ^[a-z0-9-]+$ ]] || { echo "SITE/ACCES [a-z0-9], NOM [a-z0-9-]" >&2; exit 2; }
[[ "$IP" =~ ^[0-9.]+$ ]] || { echo "IP : IPv4 attendue" >&2; exit 2; }
[[ "$MIN" =~ ^[0-9]+$ && "$MAX" =~ ^[0-9]+$ && "$ATTENTE" =~ ^[0-9]+$ && "$DUREE_S" =~ ^[0-9]+$ ]] || { echo "-m -M -W -D : entiers" >&2; exit 2; }
[ "$MIN" -ge 1 ] && [ "$MAX" -ge "$MIN" ] || { echo "1 <= MIN <= MAX" >&2; exit 2; }
command -v ping >/dev/null || { echo "ping absent (apt-get install iputils-ping)" >&2; exit 3; }
mkdir -p "$DOSSIER" || exit 3

FIN=0
if [ -n "$FIN_ABS" ]; then
  FIN=$(date -u -d "$FIN_ABS" +%s) || { echo "-F : date invalide" >&2; exit 2; }
  [ "$FIN" -gt "$(date -u +%s)" ] || { echo "-F : date déjà passée" >&2; exit 4; }
elif [ "$DUREE_S" -gt 0 ]; then
  FIN=$(( $(date -u +%s) + DUREE_S ))
fi

trap 'exit 0' TERM INT
while :; do
  [ "$FIN" -gt 0 ] && [ "$(date -u +%s)" -ge "$FIN" ] && exit 0
  sleep $(( MIN + RANDOM % (MAX - MIN + 1) ))
  t_ms=$(date -u +%s%3N)
  sortie=$(ping -n -c 1 -W "$ATTENTE" "$IP" 2>&1)
  rtt=$(printf '%s\n' "$sortie" | sed -n 's/.*time=\([0-9.]*\) ms.*/\1/p' | head -1)
  jour=$(date -u -d "@${t_ms%???}" +%Y-%m-%d)
  if [ -n "$rtt" ]; then res="rtt_ms=$rtt"; else res="perdu=oui"; fi
  printf '%s epoch_ms=%s nom=%s ip=%s %s\n' "$(date -u -d "@${t_ms%???}" +%Y-%m-%dT%H:%M:%SZ)" "$t_ms" "$NOM" "$IP" "$res" \
    >> "$DOSSIER/$jour-$SITE-$ACCES-$NOM.rare.log"
done
