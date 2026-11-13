#!/usr/bin/env bash
# WAKATNET — tests de l'API en une commande : apps/api/tests/run.sh
# Pile neuve et jetable (PostgreSQL 16.15, migrations de production par migrer.sh), typage,
# puis tests (node --test). Exige Docker et Docker Compose. Jamais contre une base réelle.
set -euo pipefail

ICI="$(cd "$(dirname "$0")" && pwd)"
DEPOT="$(cd "$ICI/../../.." && pwd)"
cd "$ICI"
C="docker compose -f compose.yml"
nettoyer() { $C down -v --remove-orphans >/dev/null 2>&1 || true; rm -f jeu.secrets; }
trap nettoyer EXIT
etape() { printf '\n=== %s ===\n' "$*"; }

etape "Pile neuve, secrets jetables"
$C down -v --remove-orphans >/dev/null 2>&1 || true
umask 077
alea() { head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
ADMIN="$(alea)"; API="$(alea)"
{
  echo "POSTGRES_PASSWORD=$ADMIN"
  echo "WAKATNET_PG_API_PASSWORD=$API"
  echo "WAKATNET_PG_SANTE_PASSWORD=$(alea)"
  echo "WAKATNET_PG_RAPPROCHEMENT_PASSWORD=$(alea)"
  echo "WAKATNET_TEST_ADMIN_URL=postgresql://wakatnet_admin:$ADMIN@postgres:5432/wakatnet"
  echo "WAKATNET_API_DATABASE_URL=postgresql://wk_api:$API@postgres:5432/wakatnet"
} > jeu.secrets
umask 022

etape "Construction du conteneur de test"
docker build -q --network host -f "$ICI/Dockerfile" -t wakatnet-test-api:local \
  --build-arg http_proxy --build-arg https_proxy "$DEPOT" >/dev/null

etape "PostgreSQL et migrations de production"
$C up -d --wait postgres >/dev/null
$C exec -T -e PGUSER=wakatnet_admin -e PGDATABASE=wakatnet postgres bash /depot/infra/sql/migrer.sh 2>&1 \
  | grep -v "^ATTENTION : WAKATNET_PG_\(RADIUS\|ACCT\|MAINT\|COA\|REPLICATION\|REWIND\)_PASSWORD absent"
$C up -d api >/dev/null

etape "Typage"
$C exec -T api npx tsc --noEmit -p .

etape "Tests"
$C exec -T api node --test --test-concurrency=1 "tests/**/*.test.ts"
etape "SUCCÈS"
