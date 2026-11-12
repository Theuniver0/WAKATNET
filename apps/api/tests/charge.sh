#!/usr/bin/env bash
# WAKATNET — charge HTTP du portail et du paiement (phase 5, ticket 07) : apps/api/tests/charge.sh
# PostgreSQL neuf et jetable (migrations de production), l'API de PRODUCTION (src/serveur.ts) dans son
# processus, le générateur (tests/charge/http.ts) dans un autre. MockProvider : aucun argent réel.
# Variables : WAKATNET_CHARGE_CONCURRENCE (défaut 20), WAKATNET_CHARGE_DUREE_S (défaut 20).
set -euo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
DEPOT="$(cd "$ICI/../../.." && pwd)"
NOM="wakatnet-charge-$$"
SECRETS="$(mktemp)"
JOURNAL="$(mktemp)"
SERVEUR=""
nettoyer() { [ -n "$SERVEUR" ] && kill "$SERVEUR" 2>/dev/null; docker rm -f "$NOM" >/dev/null 2>&1 || true; rm -f "$SECRETS" "$JOURNAL"; }
trap nettoyer EXIT
alea() { head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
ADMIN="$(alea)"; API="$(alea)"
chmod 600 "$SECRETS"
printf 'POSTGRES_PASSWORD=%s\nWAKATNET_PG_API_PASSWORD=%s\n' "$ADMIN" "$API" > "$SECRETS"

echo "=== PostgreSQL neuf ==="
docker run -d --name "$NOM" -e POSTGRES_USER=wakatnet_admin -e POSTGRES_DB=wakatnet --env-file "$SECRETS" \
  -p 127.0.0.1::5432 -v "$DEPOT/infra/sql:/depot/infra/sql:ro" \
  postgres:16.15@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657 >/dev/null
for _ in $(seq 1 60); do docker exec "$NOM" pg_isready -h 127.0.0.1 -U wakatnet_admin -d wakatnet >/dev/null 2>&1 && break; sleep 1; done
sleep 1
docker exec -e PGUSER=wakatnet_admin -e PGDATABASE=wakatnet --env-file "$SECRETS" "$NOM" \
  bash /depot/infra/sql/migrer.sh 2>&1 | grep -E "à jour|ERREUR" || true
PORT="$(docker port "$NOM" 5432/tcp | head -1 | sed 's/.*://')"

export WAKATNET_TEST_ADMIN_URL="postgresql://wakatnet_admin:$ADMIN@127.0.0.1:$PORT/wakatnet"
export WAKATNET_API_DATABASE_URL="postgresql://wk_api:$API@127.0.0.1:$PORT/wakatnet"
WAKATNET_CLE_MARCHANDS="$(head -c 32 /dev/urandom | base64)"
WAKATNET_CLE_HMAC="$(head -c 32 /dev/urandom | base64)"
export WAKATNET_CLE_MARCHANDS WAKATNET_CLE_HMAC WAKATNET_MOCK=1
cd "$DEPOT/apps/api"
# Client Prisma généré (genere/, ignoré par git), comme le fait tests/Dockerfile : indispensable sur un clone neuf (CI).
npm run generer >/dev/null

echo "=== API de production (src/serveur.ts), processus à part, journal d'accès actif ==="
WAKATNET_API_PORT=3917 node src/serveur.ts > "$JOURNAL" 2>&1 &
SERVEUR=$!
for _ in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:3917/etat && break; sleep 0.5; done

echo "=== Charge (concurrence ${WAKATNET_CHARGE_CONCURRENCE:-20}, ${WAKATNET_CHARGE_DUREE_S:-20} s par palier) ==="
WAKATNET_CHARGE_URL=http://127.0.0.1:3917 node tests/charge/http.ts
echo "=== Matériel ==="
nproc; grep -m1 "model name" /proc/cpuinfo
grep -c '"level":50' "$JOURNAL" | sed 's/^/erreurs internes journalisées par l API : /'
