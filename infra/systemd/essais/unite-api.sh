#!/bin/bash
# WAKATNET — essai de la VRAIE unité infra/systemd/wakatnet-api.service sous le systemd de Debian 13 (ADR 0016 :
# « non prouvé : sous le systemd de Debian 13 »). Le fichier d'unité est copié tel quel ; seul le programme lancé
# (/opt/wakatnet/apps/api/src/serveur.ts) est remplacé par essais/sonde-api.ts, qui exerce HTTP, fetch, scrypt, fs,
# DNS, worker, zlib et WebAssembly sous le filtre d'appels système, puis lit son état seccomp.
#   infra/systemd/essais/unite-api.sh
# Exige Docker et un Node 22 sur l'hôte (celui de la production : binaire officiel de nodejs.org, copié dans le
# conteneur). Aucun secret : /etc/wakatnet/api.env est créé vide. Conteneur jetable, détruit à la fin.
set -euo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
DEPOT="$(cd "$ICI/../../.." && pwd)"
C="wakatnet-unite-api-$$"
IMAGE="wakatnet-systemd-debian13:local"
nettoyer() { [ "${GARDER:-0}" = 1 ] && return; docker rm -f "$C" >/dev/null 2>&1 || true; }
trap nettoyer EXIT
echec() { echo "ÉCHEC : $*" >&2; docker exec "$C" journalctl -u wakatnet-api --no-pager -n 30 2>/dev/null || true; exit 1; }

NODE="$(command -v node)" || { echo "node absent de l'hôte" >&2; exit 2; }
case "$("$NODE" --version)" in v22.*) ;; *) echo "Node 22 exigé (production : node_version de group_vars), trouvé $("$NODE" --version)" >&2; exit 2 ;; esac

echo "=== Image Debian 13 avec systemd ==="
CA=()
[ -s /root/.ccr/ca-bundle.crt ] && CA=("--secret" "id=ca,src=/root/.ccr/ca-bundle.crt")
docker build -q --network host "${CA[@]}" -f "$ICI/Dockerfile.debian13" -t "$IMAGE" --build-arg https_proxy "$ICI" >/dev/null
docker run -d --name "$C" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  etat="$(docker exec "$C" systemctl is-system-running 2>/dev/null || true)"
  case "$etat" in running|degraded) break ;; esac
  sleep 1
done
echo "systemd $(docker exec "$C" systemctl --version | head -1 | awk '{print $2}') : $etat"

echo "=== Unité de production, sonde à la place de l'API ==="
docker cp "$(readlink -f "$NODE")" "$C:/usr/bin/node"
docker exec "$C" install -d -m 0755 /opt/wakatnet/apps/api/src /var/lib/wakatnet
docker exec "$C" install -d -m 0750 /etc/wakatnet
docker exec "$C" install -m 0600 /dev/null /etc/wakatnet/api.env
docker cp "$ICI/sonde-api.ts" "$C:/opt/wakatnet/apps/api/src/serveur.ts"
docker exec "$C" chmod -R a+rX /opt/wakatnet
docker cp "$DEPOT/infra/systemd/wakatnet-api.service" "$C:/etc/systemd/system/wakatnet-api.service"
docker exec "$C" systemctl daemon-reload
docker exec "$C" systemctl start wakatnet-api || echec "démarrage de l'unité"

reponse=""
for _ in $(seq 1 30); do
  reponse="$(docker exec "$C" curl -sf http://127.0.0.1:3000/sonde 2>/dev/null || true)"
  [ -n "$reponse" ] && break
  sleep 1
done
[ -n "$reponse" ] || echec "la sonde ne répond pas"
echo "$reponse"
grep -q '"ok":true' <<<"$reponse" || echec "une famille d'appels échoue sous le filtre, ou seccomp inactif"
[ "$(docker exec "$C" systemctl is-active wakatnet-api)" = active ] || echec "unité arrêtée après la sonde"
docker exec "$C" journalctl -u wakatnet-api --no-pager | grep -qiE "SIGSYS|bad system call|core-dump" && echec "appel système tué"
grep -qw pku /proc/cpuinfo && pku=oui || pku=non
echo "processeur avec PKU : $pku (V8 tente pkey_* ; sous le filtre, EPERM et repli)"
echo "exposition : $(docker exec "$C" systemd-analyze security wakatnet-api --no-pager 2>/dev/null | tail -1)"
echo "=== SUCCÈS ==="
