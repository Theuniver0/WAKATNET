#!/usr/bin/env bash
# serveur-vm.sh — prépare une VM cible temporaire pour la mesure de latence WAKATNET.
#
# À lancer en root sur une VM Debian neuve (testé seulement sur Ubuntu 24.04,
# voir README.md « Ce qui est prouvé »). Idempotent : le relancer ne casse rien.
#
#   serveur-vm.sh installer
#       paquets (irtt, wireguard-tools, nftables, chrony), irtt en service,
#       interface WireGuard wg-labo, pare-feu minimal. La clé privée WireGuard
#       est générée SUR la VM et n'en sort pas ; seule la clé publique s'affiche.
#   serveur-vm.sh ajouter-pair NOM CLE_PUBLIQUE IP_DANS_LE_TUNNEL
#       ajoute (ou met à jour) une sonde : une clé publique n'est pas un secret.
#       IP en 10.254.213.0/24 (variante L, tunnel sur la sonde) ou en
#       10.254.214.0/24 (variante R, tunnel sur le routeur). Refus si l'IP est
#       déjà attribuée à un autre NOM (deux pairs aux mêmes AllowedIPs : le
#       second prendrait silencieusement la place du premier).
#   serveur-vm.sh etat
#       versions, services, pairs WireGuard (sans clé privée), règles nftables.
#
# Variables (facultatives) :
#   WG_ADRESSE   adresse de la VM dans le tunnel de labo (défaut 10.254.213.1/24)
#   WG_ADRESSE_R seconde adresse, pour la variante R (ex. 10.254.214.1/24) ;
#                vide par défaut. L et R peuvent alors tourner EN MÊME TEMPS.
#   WG_PORT      port d'écoute WireGuard (défaut 51820)
#   IRTT_PORT    port du serveur irtt (défaut 2112)
#   SSH_PORT     port SSH à garder ouvert (défaut 22)
#
# Plages du tunnel de labo : 10.254.213.0/24 (L) et 10.254.214.0/24 (R), HORS de l'overlay
# de production 10.213.0.0/16 (SPEC §6.1), pour qu'aucune route de labo ne
# survive en conflit avec un futur enrôlement.

set -euo pipefail

WG_IF=wg-labo
WG_ADRESSE="${WG_ADRESSE:-10.254.213.1/24}"
WG_ADRESSE_R="${WG_ADRESSE_R:-}"
[[ -z "$WG_ADRESSE_R" || "$WG_ADRESSE_R" =~ ^10\.254\.214\.[0-9]{1,3}/24$ ]] || { echo "WG_ADRESSE_R attendue en 10.254.214.x/24" >&2; exit 2; }
WG_PORT="${WG_PORT:-51820}"
IRTT_PORT="${IRTT_PORT:-2112}"
SSH_PORT="${SSH_PORT:-22}"
WG_DIR=/etc/wireguard
CLE_PRIVEE="$WG_DIR/$WG_IF.cle-privee"   # 600, root ; jamais copiée ailleurs
CONF="$WG_DIR/$WG_IF.conf"
PAIRS="$WG_DIR/$WG_IF.pairs"             # NOM CLE_PUBLIQUE IP (aucune donnée secrète)

[ "$(id -u)" -eq 0 ] || { echo "à lancer en root" >&2; exit 1; }

installer_paquets() {
  export DEBIAN_FRONTEND=noninteractive
  local manquants=()
  for p in irtt wireguard-tools nftables chrony iputils-ping; do
    dpkg -s "$p" >/dev/null 2>&1 || manquants+=("$p")
  done
  if [ "${#manquants[@]}" -gt 0 ]; then
    apt-get update -q
    apt-get install -y -q "${manquants[@]}"
  fi
}

configurer_irtt() {
  # Limites côté serveur : intervalle mini 10 ms, tranche maxi 2 h, et --timeout
  # de 20 min : une coupure réseau de quelques minutes ne doit pas fermer la
  # session irtt avant la fin de la tranche (sinon toute la fin de tranche
  # paraîtrait perdue).
  mkdir -p /etc/systemd/system/irtt.service.d
  cat > /etc/systemd/system/irtt.service.d/wakatnet-labo.conf <<EOF
# wakatnet-labo : limites du serveur irtt de mesure
[Service]
ExecStart=
ExecStart=/usr/bin/irtt server -b 0.0.0.0:$IRTT_PORT -i 10ms -d 2h --timeout=20m
EOF
  systemctl daemon-reload
  systemctl enable irtt >/dev/null 2>&1 || true
  systemctl restart irtt
}

configurer_wireguard() {
  install -d -m 700 "$WG_DIR"
  if [ ! -s "$CLE_PRIVEE" ]; then
    ( umask 077; wg genkey > "$CLE_PRIVEE" )
    echo "clé privée WireGuard générée sur place ($CLE_PRIVEE, 600)"
  fi
  chmod 600 "$CLE_PRIVEE"
  touch "$PAIRS"
  ecrire_conf_wg
  systemctl enable "wg-quick@$WG_IF" >/dev/null 2>&1 || true
  if ip link show "$WG_IF" >/dev/null 2>&1; then
    wg syncconf "$WG_IF" <(wg-quick strip "$WG_IF")
    # La conf « strip » ne porte pas la clé privée : on la recharge depuis son fichier.
    wg set "$WG_IF" private-key "$CLE_PRIVEE"
  else
    systemctl start "wg-quick@$WG_IF"
  fi
}

# La conf ne contient PAS la clé privée : elle est chargée au démarrage depuis
# le fichier dédié (PostUp). Elle peut donc être affichée sans risque.
ecrire_conf_wg() {
  {
    echo "# wakatnet-labo : tunnel de mesure de latence (aucune clé privée ici)"
    echo "[Interface]"
    echo "Address = $WG_ADRESSE${WG_ADRESSE_R:+, $WG_ADRESSE_R}"
    echo "ListenPort = $WG_PORT"
    echo "PostUp = wg set %i private-key $CLE_PRIVEE"
    while read -r nom cle ip; do
      [ -n "${nom:-}" ] || continue
      echo
      echo "# sonde $nom"
      echo "[Peer]"
      echo "PublicKey = $cle"
      echo "AllowedIPs = $ip/32"
    done < "$PAIRS"
  } > "$CONF.tmp"
  chmod 600 "$CONF.tmp"
  mv -f "$CONF.tmp" "$CONF"
}

configurer_pare_feu() {
  # Politique « drop » en entrée, mais SSH accepté AVANT tout (anti-lockout).
  # Les mêmes ports sont ouverts sur toutes les interfaces (aucune règle par
  # interface) : SSH, WireGuard, irtt (sans HMAC : risque faible, irtt renvoie
  # des paquets de la taille de la requête et le serveur borne -i et -d), ICMP.
  # Pas de transfert : la VM ne route rien. Un pare-feu de l'hébergeur (Hetzner
  # Cloud Firewall, à vérifier) s'ajoute à celui-ci : y ouvrir aussi UDP 51820
  # et UDP 2112, sinon la mesure ne démarre pas.
  cat > /etc/nftables.conf <<EOF
#!/usr/sbin/nft -f
# wakatnet-labo : pare-feu minimal de la VM de mesure
flush ruleset
table inet wakatnet_labo {
  chain entree {
    type filter hook input priority 0; policy drop;
    iif "lo" accept
    ct state established,related accept
    ct state invalid drop
    tcp dport $SSH_PORT accept
    udp dport $WG_PORT accept
    udp dport $IRTT_PORT accept
    ip protocol icmp accept
    meta l4proto ipv6-icmp accept
  }
  chain transfert {
    type filter hook forward priority 0; policy drop;
  }
}
EOF
  nft -c -f /etc/nftables.conf
  nft -f /etc/nftables.conf
  systemctl enable nftables >/dev/null 2>&1 || true
}

afficher_cle_publique() {
  echo "clé publique WireGuard de la VM (à recopier dans la sonde) :"
  wg pubkey < "$CLE_PRIVEE"
  echo "adresse dans le tunnel : ${WG_ADRESSE%/*}   port WireGuard : UDP $WG_PORT   irtt : UDP $IRTT_PORT"
}

case "${1:-}" in
  installer)
    installer_paquets
    configurer_irtt
    configurer_wireguard
    configurer_pare_feu
    systemctl enable --now chrony >/dev/null 2>&1 || true
    afficher_cle_publique
    ;;
  ajouter-pair)
    [ $# -eq 4 ] || { echo "usage : $0 ajouter-pair NOM CLE_PUBLIQUE IP" >&2; exit 2; }
    nom="$2" cle="$3" ip="$4"
    [[ "$nom" =~ ^[a-z0-9-]+$ ]] || { echo "NOM : [a-z0-9-]" >&2; exit 2; }
    [[ "$cle" =~ ^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$ ]] || { echo "clé publique invalide" >&2; exit 2; }
    [[ "$ip" =~ ^10\.254\.21[34]\.[0-9]{1,3}$ ]] || { echo "IP attendue dans 10.254.213.0/24 ou 10.254.214.0/24" >&2; exit 2; }
    touch "$PAIRS"
    if awk -v n="$nom" -v i="$ip" '$3 == i && $1 != n { found=1 } END { exit !found }' "$PAIRS"; then
      echo "IP $ip déjà attribuée à : $(awk -v i="$ip" '$3 == i { print $1 }' "$PAIRS")" >&2; exit 2
    fi
    grep -v -E "^$nom " "$PAIRS" > "$PAIRS.tmp" || true
    echo "$nom $cle $ip" >> "$PAIRS.tmp"
    mv -f "$PAIRS.tmp" "$PAIRS"
    configurer_wireguard
    wg show "$WG_IF" peers 2>/dev/null || echo "(interface $WG_IF absente : pair enregistré, pris en compte au démarrage de wg-quick@$WG_IF)"
    ;;
  etat)
    irtt -v | head -1; wg --version; nft --version
    systemctl --no-pager --lines=0 status irtt "wg-quick@$WG_IF" nftables chrony || true
    wg show "$WG_IF"          # n'affiche jamais la clé privée
    nft list ruleset
    chronyc tracking 2>/dev/null | head -4 || true
    ;;
  *)
    sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
