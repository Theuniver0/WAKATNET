#!/usr/bin/env bash
# WAKATNET — banc CHR : exécute les VRAIS scripts RouterOS (apps/api/src/routeros.ts) sur un RouterOS réel, émulé par
# qemu, sans matériel ni production. Ce qui est prouvé ici ne l'est que pour la version du CHR employé.
#
#   sudo WAKATNET_CHR_IMG=/chemin/chr-7.19.4.img infra/routeros/essais/chr.sh
#
# Image : https://download.mikrotik.com/routeros/<version>/chr-<version>.img.zip (dézippée). Le script n'en télécharge
# aucune. Il faut : root (interface WireGuard de l'hôte), qemu-system-x86_64, wireguard-go, wg, openssl, sshpass,
# python3, node (≥ 22). Sans KVM, qemu émule (TCG) : compter 1 à 3 minutes de démarrage.
#
# Le CHR joint l'hôte en 10.0.2.2 (réseau « user » de qemu). L'hôte joue la plateforme (plateforme.py, HTTPS par une
# autorité de test) et le nœud A (wireguard-go, 10.213.0.1). Aucun secret réel : clés, certificats et secret RADIUS
# sont créés pour la durée du banc, dans un dossier temporaire supprimé à la fin.
set -euo pipefail

ICI=$(cd "$(dirname "$0")" && pwd)
IMG=${WAKATNET_CHR_IMG:?WAKATNET_CHR_IMG : chemin de l image CHR dezippee}
PORT_SSH=${WAKATNET_CHR_SSH:-2222}
PORT_HTTPS=${WAKATNET_CHR_HTTPS:-8443}
WG=${WAKATNET_BANC_WG:-wg-banc-a}
T=$(mktemp -d)
ECHECS=0

nettoyer() {
  [ -f "$T/qemu.pid" ] && kill "$(cat "$T/qemu.pid")" 2>/dev/null || true
  [ -f "$T/plateforme.pid" ] && kill "$(cat "$T/plateforme.pid")" 2>/dev/null || true
  pkill -f "wireguard-go -f $WG" 2>/dev/null || true
  ip link del "$WG" 2>/dev/null || true
  rm -rf "$T"
}
trap nettoyer EXIT

ros() { timeout 180 sshpass -p '' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no \
          -o LogLevel=ERROR -p "$PORT_SSH" admin@127.0.0.1 "$1" 2>&1 | tr -d '\r' || true; }  # un refus attendu n'arrête pas le banc
# En 7.15, un fichier déposé par SCP n'apparaît pas aussitôt dans /file : on attend qu'il y soit.
envoyer() {
  timeout 60 sshpass -p '' scp -O -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no \
    -o LogLevel=ERROR -P "$PORT_SSH" "$1" admin@127.0.0.1:/
  for _ in $(seq 1 20); do
    [ "$(ros ":put [:len [/file find where name=\"$(basename "$1")\"]]" | tail -1)" = "1" ] && return 0; sleep 1
  done
  echo "fichier absent du routeur : $(basename "$1")" >&2
}
generer() { node --experimental-strip-types --no-warnings "$ICI/generer.ts" "$@"; }
ok() { echo "  OK   $1"; }
ko() { echo "  ECHEC $1"; ECHECS=$((ECHECS + 1)); }
verifier() { if [ "$2" = "$3" ]; then ok "$1"; else ko "$1 (attendu « $3 », obtenu « $2 »)"; fi; }
compter() { ros ":put [:len [$1]]" | tail -1; }
# Sortie de l'import, puis les erreurs de script journalisées depuis un repère : en 7.15, `/import` lancé par SSH
# n'affiche pas le message d'un `:error` ; il n'est que dans le journal.
importer() {
  local REPERE; REPERE=$(date +%s%N); envoyer "$1"   # repère unique : importer tourne dans un sous-shell
  ros ":log info \"banc-repere-$REPERE\"; /import file-name=$(basename "$1")"
  ros ":local vu false; :foreach i in=[/log find] do={ :local m [/log get \$i message]; :if (\$vu and [/log get \$i topics]~\"error\") do={ :put \$m }; :if (\$m = \"banc-repere-$REPERE\") do={ :set vu true } }"
}

echo "== Démarrage du CHR ($(basename "$IMG"))"
cp "$IMG" "$T/chr.img"
accel=tcg; [ -w /dev/kvm ] && accel=kvm
qemu-system-x86_64 -accel "$accel" -m 512 -smp 2 -drive "file=$T/chr.img,format=raw,if=virtio" \
  -netdev "user,id=n0,hostfwd=tcp:127.0.0.1:$PORT_SSH-:22" -device virtio-net-pci,netdev=n0 \
  -display none -serial "file:$T/serie.log" -daemonize -pidfile "$T/qemu.pid"
for _ in $(seq 1 90); do ros ':put pret' | grep -q pret && break; sleep 4; done
ros ':put pret' | grep -q pret || { echo "le CHR ne répond pas en SSH"; exit 1; }
VERSION=$(ros ':put [/system resource get version]' | tail -1)
echo "   RouterOS $VERSION"

echo "== Plateforme et nœud A sur l'hôte"
( cd "$T"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=WAKATNET banc CHR" -keyout ca.key -out ca.crt 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=10.0.2.2" -keyout srv.key -out srv.csr 2>/dev/null
  printf 'subjectAltName=IP:10.0.2.2\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > ext.cnf
  openssl x509 -req -in srv.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 1 -extfile ext.cnf -out srv.crt 2>/dev/null
  umask 077; wg genkey > a.key; wg pubkey < a.key > a.pub )
(nohup wireguard-go -f "$WG" > "$T/wg.log" 2>&1 &)
for _ in $(seq 1 20); do [ -S "/var/run/wireguard/$WG.sock" ] && break; sleep 0.5; done
timeout 10 wg set "$WG" listen-port 51820 private-key "$T/a.key"
ip address add 10.213.0.1/16 dev "$WG"; ip link set "$WG" up
# Paramètres du banc ; le secret RADIUS est tiré ici et n'apparaît sur aucune ligne de commande.
python3 - "$T" "$PORT_HTTPS" <<'EOF'
import json, secrets, string, sys
d, port = sys.argv[1], sys.argv[2]
alpha = string.ascii_letters + string.digits
jeton = lambda: "".join(secrets.choice(alpha + "-_") for _ in range(43))
json.dump({"urlPublique": f"https://10.0.2.2:{port}", "jeton": jeton(), "overlayIp": "10.213.1.10",
           "secret": "".join(secrets.choice(alpha) for _ in range(32)),
           "noeuds": [{"nom": "A", "overlay": "10.213.0.1", "cle": open(f"{d}/a.pub").read().strip(), "endpoint": "10.0.2.2", "port": 51820}],
           "portail": {"hote": "portail.essai.bf", "ips": ["192.0.2.20"]},
           "urlEntretien": f"https://10.0.2.2:{port}/entretien/{jeton()}"}, open(f"{d}/parametres.json", "w"))
EOF
WAKATNET_BANC_WG=$WG python3 "$ICI/plateforme.py" "$T" "$PORT_HTTPS" "$T/srv.crt" "$T/srv.key" > "$T/plateforme.err" 2>&1 &
echo $! > "$T/plateforme.pid"
envoyer "$T/ca.crt"
ros '/certificate import file-name=ca.crt passphrase="" name=wakatnet-banc-ca' > /dev/null
ros '/certificate set [find where name~"wakatnet-banc-ca"] trusted=yes' > /dev/null
generer etape1 "$T/parametres.json" > "$T/wakatnet-enroll.rsc"
posts() { local n; n=$(grep -c '^POST' "$T/plateforme.log" 2>/dev/null || true); echo "${n:-0}"; }

echo "== Étape 1 : refus, sans rien modifier"
sortie=$(importer "$T/wakatnet-enroll.rsc")
echo "$sortie" | grep -q "aucun serveur hotspot" && ok "sans hotspot : refus" || ko "sans hotspot : refus ($sortie)"
ros '/interface bridge add name=bridge-hs; /ip address add address=10.5.50.1/24 interface=bridge-hs; /ip pool add name=hs-pool ranges=10.5.50.10-10.5.50.254; /ip hotspot profile add name=hsprof1 hotspot-address=10.5.50.1 dns-name=login.essai; /ip hotspot add name=hs1 interface=bridge-hs address-pool=hs-pool profile=hsprof1; /ip hotspot user add name=client-local password=banc' > /dev/null
ros '/ip address add address=10.213.9.1/32 interface=bridge-hs comment="a moi"' > /dev/null
sortie=$(importer "$T/wakatnet-enroll.rsc")
echo "$sortie" | grep -q "10.213.0.0/16" && ok "adresse dans 10.213/16 : refus" || ko "adresse dans 10.213/16 : refus ($sortie)"
ros '/ip address remove [find where comment="a moi"]; /radius add address=192.0.2.99 secret=autre service=hotspot comment="autre fournisseur"' > /dev/null
sortie=$(importer "$T/wakatnet-enroll.rsc")
echo "$sortie" | grep -q "autre serveur RADIUS" && ok "autre RADIUS du hotspot : refus" || ko "autre RADIUS du hotspot : refus ($sortie)"
ros '/radius remove [find where comment="autre fournisseur"]' > /dev/null
verifier "aucun envoi à la plateforme pendant les refus" "$(posts)" "0"
verifier "profil hotspot intact après les refus" "$(ros ':put [/ip hotspot profile get [find where name=hsprof1] use-radius]' | tail -1)" "false"

echo "== Étapes 1 et 2 : enrôlement"
# Pare-feu du propriétaire déjà en place (établies, administration, refus du reste) : les règles wakatnet doivent passer
# devant le refus, sinon le tunnel et le CoA seraient bloqués.
ros '/ip firewall filter add chain=input action=accept connection-state=established,related comment="regle du proprietaire"; /ip firewall filter add chain=input action=accept protocol=tcp dst-port=22 comment="regle du proprietaire"; /ip firewall filter add chain=input action=drop comment="regle du proprietaire"' > /dev/null
sortie=$(importer "$T/wakatnet-enroll.rsc")
echo "$sortie" | grep -q "routeur enrole" && ok "enrôlement" || { ko "enrôlement ($sortie)"; ros '/log print without-paging' | tail -25 | sed 's/^/     /'; sed 's/^/     plateforme : /' "$T/plateforme.err" | tail -5; }
verifier "profil : use-radius" "$(ros ':put [/ip hotspot profile get [find where name=hsprof1] use-radius]' | tail -1)" "true"
verifier "profil : accounting" "$(ros ':put [/ip hotspot profile get [find where name=hsprof1] radius-accounting]' | tail -1)" "true"
verifier "RADIUS wakatnet : Message-Authenticator exigé" \
  "$(ros ':put [/radius get [find where comment~"^wakatnet"] require-message-auth]' | tail -1)" "yes-for-request-resp"
verifier "CoA accepté" "$(ros ':put [/radius incoming get accept]' | tail -1)" "true"
premiere=$(ros ':put [/ip firewall filter get [:pick [/ip firewall filter find where chain=input dynamic=no] 0] comment]' | tail -1)
case "$premiere" in wakatnet*) ok "règles wakatnet avant la règle du propriétaire" ;; *) ko "première règle input : « $premiere »" ;; esac
verifier "aucun fichier temporaire" "$(compter '/file find where name~"^wakatnet-"')" "0"
verifier "planificateur : droits" "$(ros ':put [/system scheduler get [find where name="wakatnet-entretien"] policy]' | tail -1)" "read;write;test;sensitive"
verifier "utilisateur local conservé" "$(compter '/ip hotspot user find where name="client-local"')" "1"
regles=$(compter '/ip firewall filter find where comment~"^wakatnet"')

echo "== Étape 2 rejouée : idempotence ; un planificateur désactivé le reste"
ros '/system scheduler disable [find where name="wakatnet-entretien"]' > /dev/null
generer etape2 "$T/parametres.json" "$T/recu-etape1.json" > "$T/wakatnet-etape2.rsc"
sortie=$(importer "$T/wakatnet-etape2.rsc")
echo "$sortie" | grep -q "routeur enrole" && ok "étape 2 rejouée" || ko "étape 2 rejouée ($sortie)"
verifier "pas de règle en double" "$(compter '/ip firewall filter find where comment~"^wakatnet"')" "$regles"
verifier "un seul serveur RADIUS wakatnet" "$(compter '/radius find where comment~"^wakatnet"')" "1"
verifier "planificateur toujours désactivé" "$(ros ':put [/system scheduler get [find where name="wakatnet-entretien"] disabled]' | tail -1)" "true"
ros '/system scheduler enable [find where name="wakatnet-entretien"]' > /dev/null

echo "== Étape 3 : entretien lancé par le vrai planificateur"
verifier "avant l'entretien : IP du portail d'origine ouverte" "$(compter '/ip hotspot walled-garden ip find where comment="wakatnet portail 192.0.2.20"')" "1"
python3 - "$T/parametres.json" <<'EOF'
import json, sys
p = json.load(open(sys.argv[1])); p["portail"]["ips"] = ["192.0.2.30"]; json.dump(p, open(sys.argv[1], "w"))
EOF
ros ':local t ([/system clock get time] + 00:00:05); /system scheduler set [find where name="wakatnet-entretien"] start-time=$t' > /dev/null
for _ in $(seq 1 30); do [ "$(grep -c '^GET /entretien/' "$T/plateforme.log" 2>/dev/null || true)" -ge 1 ] && break; sleep 2; done
sleep 8
verifier "entretien appliqué (journal du routeur)" "$(compter '/log find where message="wakatnet : entretien applique"')" "1"
verifier "nouvelle IP du portail ouverte" "$(compter '/ip hotspot walled-garden ip find where comment="wakatnet portail 192.0.2.30"')" "1"
verifier "ancienne IP du portail fermée" "$(compter '/ip hotspot walled-garden ip find where comment="wakatnet portail 192.0.2.20"')" "0"
verifier "aucun échec d'entretien journalisé" "$(compter '/log find where message="wakatnet : entretien indisponible, configuration inchangee"')" "0"
verifier "fichier d'entretien supprimé" "$(compter '/file find where name~"^wakatnet-"')" "0"
if [ "$ECHECS" -gt 0 ]; then
  echo "  -- diagnostic : appels reçus par la plateforme, journal du routeur, walled garden"
  sed 's|/[A-Za-z0-9_-]\{43\}$|/<jeton>|' "$T/plateforme.log" | sed 's/^/     /'
  ros ':foreach i in=[/log find where (message~"wakatnet" or topics~"script" or topics~"fetch" or message~"fetch")] do={ :put ([/log get $i time] . " " . [/log get $i topics] . " " . [/log get $i message]) }' | sed 's/^/     /'
  ros '/ip hotspot walled-garden ip print terse where comment~"^wakatnet"' | sed 's/^/     /'
fi

echo "== Désinstallation"
generer desinstallation "$T/parametres.json" "$T/recu-etape1.json" > "$T/wakatnet-desinstallation.rsc"
sortie=$(importer "$T/wakatnet-desinstallation.rsc")
echo "$sortie" | grep -q "desinstallation terminee" && ok "désinstallation" || ko "désinstallation ($sortie)"
verifier "profil rétabli : use-radius" "$(ros ':put [/ip hotspot profile get [find where name=hsprof1] use-radius]' | tail -1)" "false"
verifier "CoA rétabli" "$(ros ':put [/radius incoming get accept]' | tail -1)" "false"
for o in '/ip firewall filter' '/radius' '/system scheduler' '/ip hotspot walled-garden' '/ip hotspot walled-garden ip' '/ip address' '/ip route' '/interface wireguard peers'; do
  verifier "plus d'objet wakatnet : $o" "$(compter "$o find where comment~\"^wakatnet\"")" "0"
done
verifier "plus d'interface wg-wakatnet" "$(compter '/interface wireguard find where name="wg-wakatnet"')" "0"
verifier "règles du propriétaire conservées" "$(compter '/ip firewall filter find where comment="regle du proprietaire"')" "3"
verifier "utilisateur local conservé" "$(compter '/ip hotspot user find where name="client-local"')" "1"

echo
if [ "$ECHECS" -eq 0 ]; then echo "SUCCÈS : banc CHR, RouterOS $VERSION"; else echo "ÉCHEC : $ECHECS contrôle(s), RouterOS $VERSION"; exit 1; fi
