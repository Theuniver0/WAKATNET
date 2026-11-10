#!/usr/bin/env bash
# test-local.sh — test de bout en bout du protocole de latence, sur une seule machine Linux.
#
# Topologie : deux espaces de noms réseau reliés par une paire veth.
#   wkl-sonde (10.77.0.1) ── veth ── wkl-cible (10.77.0.2)
# Dans wkl-cible : serveur irtt (mêmes options que serveur-vm.sh), WireGuard
# (10.254.213.1), et deux dégradeurs UDP (outils/degradeur.py) qui appliquent
# le profil à la fois au trafic irtt hors tunnel (port 3112) et au trafic
# WireGuard (port 51821). Dans wkl-sonde : WireGuard (10.254.213.11) et sonde.sh
# vers trois cibles :
#   vm-udp  (hors tunnel, dégradé)      vm-wg (dans le tunnel, dégradé)
#   ref-udp (hors tunnel, NON dégradé) : le « témoin » qui permet de reconnaître
#           une panne locale (analyse.py --groupes-hetzner vm).
#
# Pourquoi un dégradeur en espace utilisateur et pas tc netem : le noyau du
# conteneur de test n'a pas sch_netem (« Specified qdisc kind is unknown »).
# Pourquoi wireguard-go : pas de module noyau wireguard dans ce conteneur.
#
# Usage (root) : WG_GO=/chemin/vers/wireguard-go outils/test-local.sh DOSSIER_SORTIE
# Les clés WireGuard de test sont générées dans un dossier temporaire et
# détruites à la fin ; elles ne sont jamais écrites dans DOSSIER_SORTIE.

set -u
ICI="$(cd "$(dirname "$0")/.." && pwd)"
SORTIE="${1:?dossier de sortie}"
WG_GO="${WG_GO:-wireguard-go}"
TMP="$(mktemp -d)"
mkdir -p "$SORTIE"
RESUME="$SORTIE/00-test-local.log"
: > "$RESUME"
r() { echo "$*" | tee -a "$RESUME"; }
NS_S=wkl-sonde NS_C=wkl-cible

PIDS_BG=()   # processus lancés par ce script (arrêtés par PID, jamais par motif)
nettoyer() {
  [ "${#PIDS_BG[@]}" -gt 0 ] && kill "${PIDS_BG[@]}" 2>/dev/null
  PIDS_BG=()
  sleep 1
  ip netns del $NS_S 2>/dev/null; ip netns del $NS_C 2>/dev/null
  rm -rf "$TMP"
}
trap 'arreter_degradeurs; nettoyer' EXIT

mettre_en_place() {
  nettoyer; TMP="$(mktemp -d)"
  ip netns add $NS_S; ip netns add $NS_C
  ip link add wkl-s type veth peer name wkl-c
  ip link set wkl-s netns $NS_S; ip link set wkl-c netns $NS_C
  ip -n $NS_S addr add 10.77.0.1/24 dev wkl-s; ip -n $NS_C addr add 10.77.0.2/24 dev wkl-c
  for n in $NS_S $NS_C; do ip -n $n link set lo up; done
  ip -n $NS_S link set wkl-s up; ip -n $NS_C link set wkl-c up
  # WireGuard (wireguard-go) ; clés jetables dans $TMP
  ( umask 077; wg genkey > "$TMP/c.key"; wg genkey > "$TMP/s.key" )
  ip netns exec $NS_C "$WG_GO" -f wgl-c >/dev/null 2>&1 & PIDS_BG+=("$!")
  ip netns exec $NS_S "$WG_GO" -f wgl-s >/dev/null 2>&1 & PIDS_BG+=("$!")
  sleep 1
  ip netns exec $NS_C wg set wgl-c private-key "$TMP/c.key" listen-port 51820 \
    peer "$(wg pubkey < "$TMP/s.key")" allowed-ips 10.254.213.11/32
  ip netns exec $NS_S wg set wgl-s private-key "$TMP/s.key" \
    peer "$(wg pubkey < "$TMP/c.key")" allowed-ips 10.254.213.1/32 \
    endpoint 10.77.0.2:51821 persistent-keepalive 25
  ip -n $NS_C addr add 10.254.213.1/24 dev wgl-c; ip -n $NS_C link set wgl-c mtu 1420 up
  ip -n $NS_S addr add 10.254.213.11/24 dev wgl-s; ip -n $NS_S link set wgl-s mtu 1420 up
  ip netns exec $NS_C irtt server -b 0.0.0.0:2112 -i 10ms -d 2h --timeout=20m >"$TMP/irtt-serveur.txt" 2>&1 & PIDS_BG+=("$!")
  sleep 0.5
  printf 'vm-udp 10.77.0.2:3112\nvm-wg 10.254.213.1:2112\nref-udp 10.77.0.2:2112\n' > "$TMP/cibles.conf"
}

DEG=()
degradeurs() {  # arguments du profil
  ip netns exec $NS_C python3 "$ICI/outils/degradeur.py" --ecoute 10.77.0.2:3112 --cible 127.0.0.1:2112 "$@" \
    >> "$SORTIE/$PROFIL.degradeur-udp.log" 2>&1 & DEG+=("$!")
  ip netns exec $NS_C python3 "$ICI/outils/degradeur.py" --ecoute 10.77.0.2:51821 --cible 127.0.0.1:51820 "$@" \
    >> "$SORTIE/$PROFIL.degradeur-wg.log" 2>&1 & DEG+=("$!")
  sleep 2
}

sonde() {  # ACCES DUREE_S TRANCHE_S INTERVALLE
  ip netns exec $NS_S "$ICI/sonde.sh" -s labo -a "$1" -c "$TMP/cibles.conf" -o "$SORTIE/$1" -i "$4" -t "$3" -D "$2"
}

amorcer_tunnel() {
  # Première poignée de main WireGuard : jusqu'à 20 s d'essais (ping dans le tunnel).
  : > "$SORTIE/$PROFIL.ping-tunnel.log"
  for _ in $(seq 1 10); do
    ip netns exec $NS_S ping -c 1 -W 2 10.254.213.1 >> "$SORTIE/$PROFIL.ping-tunnel.log" 2>&1 && break
  done
  ip netns exec $NS_S wg show wgl-s latest-handshakes | awk '{print "poignee_de_main_epoch=" $2}' >> "$SORTIE/$PROFIL.ping-tunnel.log"
}

arreter_degradeurs() { [ "${#DEG[@]}" -gt 0 ] || return 0; kill -TERM "${DEG[@]}" 2>/dev/null; wait "${DEG[@]}" 2>/dev/null; DEG=(); }

r "test-local.sh  $(date -u +%Y-%m-%dT%H:%M:%SZ)  noyau $(uname -r)  irtt $(irtt version | head -1 | awk '{print $NF}')  $(wg --version)  python $(python3 -V 2>&1)"

# P1 et P2 tournent à 50 ms (et non 200 ms, la valeur de terrain) pour avoir assez de pertes
# en quelques minutes : la comparaison avec le profil injecté a alors un sens statistique.
# P3 à P5 tournent à 200 ms, la valeur par défaut du protocole. Le cas 200 ms sur de longues
# durées (creuses / pic, soirées) est couvert par test-analyse.py sur des captures synthétiques.

# P1 — « fibre » : ~90 ms ± 10 ms, 0,5 % de perte indépendante, 180 s.
# En parallèle : flux clairsemé rare.sh dans les deux sens (intervalle 2 à 4 s au lieu de 20 à 60 s,
# pour avoir des mesures en 3 min) et réception syslog de lignes au format du routeur (SIMULÉES :
# le format réel des messages RouterOS n'est pas vérifié ici).
PROFIL=simfibre; mettre_en_place
degradeurs --delai-ms 90 --gigue-ms 10 --perte 0.5 --graine 1
amorcer_tunnel
mkdir -p "$SORTIE/simfibre"
ip netns exec $NS_S python3 "$ICI/recepteur-syslog.py" -s labo -a simfibre -o "$SORTIE/simfibre" \
  --ecoute 127.0.0.1:5514 --source 127.0.0.1 --duree 178 2>> "$SORTIE/simfibre.syslog.txt" & PIDS_BG+=("$!")
ip netns exec $NS_S "$ICI/rare.sh" -s labo -a simfibre -n vm-wg-rare -c 10.254.213.1 -m 2 -M 4 -D 170 \
  -o "$SORTIE/simfibre" & PIDS_BG+=("$!")
ip netns exec $NS_C "$ICI/rare.sh" -s labo -a simfibre -n retour-vm -c 10.254.213.11 -m 2 -M 4 -D 170 \
  -o "$SORTIE/simfibre" & PIDS_BG+=("$!")
ip netns exec $NS_S python3 - <<'EOF' & PIDS_BG+=("$!")
# Faux routeur : une ligne de compteurs WAN par minute (≈ 1 Mbit/s reçu, 0,2 Mbit/s émis),
# un repère de démarrage, et une ligne étrangère qui doit être ignorée.
import socket, time
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
envoi = lambda m: s.sendto(m.encode(), ("127.0.0.1", 5514))
time.sleep(1)
envoi("<12>script,warning wakatnet-labo demarrage routeur uptime=00:00:41 ntp=synchronized attente_ntp_s=35")
envoi("<14>script,info autre-script ligne sans rapport")
for k in range(3):
    envoi(f"<14>script,info wakatnet-labo wan iface=ether1 rx={1_000_000 + k * 7_500_000} tx={500_000 + k * 1_500_000}")
    if k < 2:
        time.sleep(60)
EOF
r "P1 $PROFIL début $(date -u +%T)"; sonde simfibre 180 60 50ms; r "P1 fin $(date -u +%T)"
arreter_degradeurs

# P2 — « 4G » : ~150 ms ± 40 ms, perte moyenne 2 % en rafales (Gilbert p=0,51 %, r=25 % :
# rafale moyenne 4 paquets), 180 s. Arrêt à mi-parcours par SIGTERM envoyé à TOUT le groupe de
# processus (sonde.sh, sous-shells et clients irtt en même temps : c'est ce que fait systemd avec
# KillMode=control-group, sa valeur par défaut), puis reprise.
PROFIL=sim4g; mettre_en_place
degradeurs --delai-ms 150 --gigue-ms 40 --ge-p 0.51 --ge-r 25 --graine 2
amorcer_tunnel
r "P2 $PROFIL début $(date -u +%T)"
ip netns exec $NS_S setsid "$ICI/sonde.sh" -s labo -a sim4g -c "$TMP/cibles.conf" -o "$SORTIE/sim4g" -i 50ms -t 60 -D 90 &
PSONDE=$!; sleep 45
PGID=$(ps -o pgid= -p "$PSONDE" | tr -d ' ')
if [ -n "$PGID" ] && [ "$PGID" != "$(ps -o pgid= -p $$ | tr -d ' ')" ]; then
  r "P2 SIGTERM au groupe de processus $PGID ($(ps -o pid= -g "$PGID" | wc -l) processus) $(date -u +%T)"
  kill -TERM -- "-$PGID"
else
  r "P2 ATTENTION : groupe de processus propre introuvable, SIGTERM au seul processus principal"
  kill -TERM "$PSONDE"
fi
wait $PSONDE
r "P2 reprise $(date -u +%T)"; sonde sim4g 95 60 50ms; r "P2 fin $(date -u +%T)"
arreter_degradeurs

# Les tranches de sonde.sh sont alignées sur l'horloge (multiples de -t). Un profil dont la fenêtre
# chevauche une frontière voit sa panne coupée en deux (fin de tranche + échec d'ouverture), et ses
# contrôles de rafale deviennent dépendants de l'heure de démarrage. On attend donc la frontière
# suivante quand le profil (durée + marge) la franchirait.
eviter_frontiere() {  # DUREE_S TRANCHE_S
  local duree=$1 tranche=$2 now reste
  now=$(date -u +%s); reste=$(( tranche - now % tranche ))
  if (( reste < duree + 15 )); then
    r "attente de la frontière de tranche ($reste s) pour un test déterministe"
    sleep $(( reste + 2 ))
  fi
}

# P3 — coupure franche de 15 s (t = 40 s à 55 s) sur fond 90 ms ± 10 ms sans perte, 90 s, une seule
# tranche. Le témoin ref-udp, non dégradé, reste joignable : la coupure n'est PAS une panne locale.
PROFIL=simcoupure; mettre_en_place
eviter_frontiere 90 600
degradeurs --delai-ms 90 --gigue-ms 10 --coupure 40:15 --graine 3
amorcer_tunnel
r "P3 $PROFIL début $(date -u +%T) (coupure prévue de +40 s à +55 s)"; sonde simcoupure 90 600 200ms; r "P3 fin $(date -u +%T)"
arreter_degradeurs

# P4 — cible injoignable au démarrage de la sonde pendant 20 s : échec d'ouverture journalisé, puis reprise
PROFIL=simouverture; mettre_en_place
# (pas d'amorçage du tunnel : la cible est coupée dès le départ)
eviter_frontiere 60 600
degradeurs --delai-ms 90 --gigue-ms 10 --coupure 0:20 --graine 4
# Fin donnée en date absolue (-F), comme sur le terrain avec systemd.
r "P4 $PROFIL début $(date -u +%T) (cible coupée de +0 s à +20 s du dégradeur, soit environ 18 s vues par la sonde)"
ip netns exec $NS_S "$ICI/sonde.sh" -s labo -a simouverture -c "$TMP/cibles.conf" -o "$SORTIE/simouverture" \
  -i 200ms -t 600 -F "$(date -u -d '+60 seconds' +%Y-%m-%dT%H:%M:%SZ)"
r "P4 fin $(date -u +%T)"
arreter_degradeurs

# P5 — pannes LOCALES, 200 ms, 150 s :
#   +40 s : panne amont de 12 s (tout l'UDP vers la cible jeté, témoin compris) ;
#   +95 s : interface de la sonde tombée pendant 6 s (irtt s'arrête sur erreur d'envoi).
PROFIL=simlocale; mettre_en_place
degradeurs --delai-ms 90 --gigue-ms 10 --graine 5
amorcer_tunnel
eviter_frontiere 150 600
r "P5 $PROFIL début $(date -u +%T)"
sonde simlocale 150 600 200ms &
PSONDE=$!
sleep 40
ip netns exec $NS_C nft add table inet wkl_panne
ip netns exec $NS_C nft add chain inet wkl_panne entree '{ type filter hook input priority 0; policy accept; }'
ip netns exec $NS_C nft add rule inet wkl_panne entree ip saddr 10.77.0.1 meta l4proto udp drop
r "P5 panne amont : début $(date -u +%T)"; sleep 12
ip netns exec $NS_C nft delete table inet wkl_panne
r "P5 panne amont : fin $(date -u +%T)"
sleep 43
ip -n $NS_S link set wkl-s down
r "P5 interface tombée : début $(date -u +%T)"; sleep 6
ip -n $NS_S link set wkl-s up
r "P5 interface tombée : fin $(date -u +%T)"
wait $PSONDE
r "P5 fin $(date -u +%T)"
arreter_degradeurs

r "fin des captures $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Analyse et vérification automatique
python3 "$ICI/analyse.py" "$SORTIE" --sortie "$SORTIE/resultat" --groupes-hetzner vm | tee -a "$RESUME"
python3 "$ICI/outils/verifier-test.py" "$SORTIE" | tee -a "$RESUME"
python3 "$ICI/outils/test-analyse.py" | tee -a "$RESUME"
r "fin $(date -u +%Y-%m-%dT%H:%M:%SZ)"
