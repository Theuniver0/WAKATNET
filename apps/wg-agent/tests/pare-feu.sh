#!/usr/bin/env bash
# WAKATNET — preuve fonctionnelle de infra/nftables/wakatnet.nft (ADR 0012 §8), dans des espaces
# de noms réseau jetables. Lancé par tests/run.sh dans le conteneur de test (privilégié).
#
#   noeud : interface « wg0 » (un pont, pour y raccorder deux routeurs), 10.213.0.1/16, transfert IP actif
#   r1    : 10.213.1.1/32, route vers le nœud     r2 : 10.213.1.2/32, route vers le nœud
# Sans les règles, r1 joint r2 À TRAVERS le nœud. Avec les règles, plus jamais.
set -euo pipefail
NFT="$1"
echec() { echo "ÉCHEC : $*" >&2; exit 1; }
ok() { echo "ok : $*"; }

nft -c -f "$NFT" && ok "nft -c -f valide le fichier"

for n in noeud r1 r2; do ip netns del "$n" 2>/dev/null || true; ip netns add "$n"; ip -n "$n" link set lo up; done
ip -n noeud link add wg0 type bridge
ip -n noeud link set wg0 up
ip -n noeud addr add 10.213.0.1/16 dev wg0
ip netns exec noeud sysctl -qw net.ipv4.ip_forward=1
ip netns exec noeud sysctl -qw net.ipv4.conf.all.send_redirects=0 net.ipv4.conf.wg0.send_redirects=0
for i in 1 2; do
  ip link add "v$i" netns "r$i" type veth peer name "p$i" netns noeud
  ip -n noeud link set "p$i" master wg0 up
  ip -n "r$i" link set "v$i" up
  ip -n "r$i" addr add "10.213.1.$i/32" dev "v$i"
  ip -n "r$i" route add 10.213.0.1/32 dev "v$i"
  ip -n "r$i" route add 10.213.0.0/16 via 10.213.0.1 dev "v$i"
done
# Le pont ne commute pas r1 → r2 directement : chaque routeur n'a qu'un /32 et passe par le nœud.

ip netns exec r1 ping -c1 -W1 10.213.1.2 >/dev/null || echec "banc : sans règles, r1 devrait joindre r2 par le nœud"
ok "sans règles, r1 joint r2 par le nœud (le banc montre bien un transfert)"

ip netns exec noeud nft -f "$NFT"
ip netns exec noeud nft -f "$NFT" && ok "rechargement atomique, rejouable"

ip netns exec r1 ping -c1 -W1 10.213.1.2 >/dev/null 2>&1 && echec "r1 joint r2 : transfert wg0 → wg0 permis"
ok "r1 ne joint plus r2 (aucun transfert wg0 → wg0)"
ip netns exec r1 ping -c1 -W1 10.213.0.1 >/dev/null || echec "le nœud ne répond plus au ping"
ok "le nœud répond au ping depuis le tunnel"

# UDP 1812 accepté, TCP 22 rejeté (pas de service à l'écoute : on lit les compteurs).
ip netns exec noeud nft reset counters table inet wakatnet >/dev/null
ip netns exec r1 bash -c 'echo x > /dev/udp/10.213.0.1/1812' || true
ip netns exec r1 timeout 2 bash -c 'echo > /dev/tcp/10.213.0.1/22' 2>/dev/null && echec "TCP 22 ouvert depuis le tunnel"
rejets=$(ip netns exec noeud nft -j list chain inet wakatnet entree | grep -o '"packets": [0-9]*' | awk '{s+=$2} END {print s+0}')
[ "$rejets" -ge 1 ] || echec "le rejet de TCP 22 n'a pas été compté"
ok "TCP 22 depuis le tunnel : rejeté et compté ($rejets)"

# Sortie : le nœud émet vers 1700/3799 ; vers un autre port, refusé.
ip netns exec noeud bash -c 'echo x > /dev/udp/10.213.1.1/3799' || echec "sortie UDP 3799 refusée"
ip netns exec noeud bash -c 'echo x > /dev/udp/10.213.1.1/5353' 2>/dev/null && echec "sortie UDP 5353 permise"
ok "sortie : CoA 3799 permis, autre port refusé"

for n in noeud r1 r2; do ip netns del "$n"; done
echo "pare-feu : SUCCÈS"
