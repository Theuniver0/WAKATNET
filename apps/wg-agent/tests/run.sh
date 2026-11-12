#!/usr/bin/env bash
# WAKATNET — tests de wg-agent et du pare-feu du nœud en une commande : apps/wg-agent/tests/run.sh
# Pile neuve et jetable (PostgreSQL 16.15 + migrations de production), tests Go avec -race
# (unitaires, puis intégration sur une vraie interface WireGuard), preuve fonctionnelle nftables.
set -euo pipefail

ICI="$(cd "$(dirname "$0")" && pwd)"
cd "$ICI"
C="docker compose -f compose.yml"
nettoyer() { $C down -v --remove-orphans >/dev/null 2>&1 || true; rm -f jeu.secrets; }
trap nettoyer EXIT
[ -n "${GARDER:-}" ] && trap - EXIT
etape() { printf '\n=== %s ===\n' "$*"; }

etape "Pile neuve, secrets jetables"
$C down -v --remove-orphans >/dev/null 2>&1 || true
umask 077
alea() { head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
ADMIN="$(alea)"; WG="$(alea)"
{
  echo "POSTGRES_PASSWORD=$ADMIN"
  echo "WAKATNET_PG_WG_PASSWORD=$WG"
  echo "PGPASSWORD=$WG"
  echo "WAKATNET_TEST_ADMIN_URL=postgresql://wakatnet_admin:$ADMIN@postgres:5432/wakatnet"
} > jeu.secrets
umask 022

etape "Construction du conteneur de test"
docker build -q --network host -f Dockerfile -t wakatnet-test-wg:local \
  --build-arg http_proxy --build-arg https_proxy .. >/dev/null

etape "PostgreSQL et migrations de production"
$C up -d --wait postgres >/dev/null
$C exec -T -e PGUSER=wakatnet_admin -e PGDATABASE=wakatnet postgres bash /depot/infra/sql/migrer.sh 2>&1 \
  | grep -v "^ATTENTION : WAKATNET_PG_\(RADIUS\|ACCT\|MAINT\|COA\|API\)_PASSWORD absent" \
  | grep -vE '^(\(1 row\)| pg_advisory_xact_lock *|-+|application : .*| *)$'
$C up -d agent >/dev/null

etape "Tests Go (-race) : planification, puis interface WireGuard réelle et boucle NOTIFY"
$C exec -T agent go test -race -count=1 -v -tags integration ./... 2>&1 | grep -E '^(=== RUN|--- |ok|FAIL|PASS)|appliquée en'

etape "Pare-feu du nœud (nftables), dans des espaces de noms réseau"
$C exec -T agent bash /src/tests/pare-feu.sh /depot/infra/nftables/wakatnet.nft

etape "SUCCÈS"
