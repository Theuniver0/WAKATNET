#!/usr/bin/env bash
# WAKATNET — achat de bout en bout dans Chromium sans interface : apps/api/tests/e2e.sh
# Ticket : .scratch/phase-3-portail-paiement/issues/07-achat-bout-en-bout.md
# PostgreSQL neuf et jetable (migrations de production), puis tests/e2e/achat.ts et
# tests/e2e/tableau.ts (ticket 08 de la phase 4) sur l'hôte. Exige aussi pdftotext (poppler-utils).
# Exige Docker, Node 22 officiel et Playwright avec Chromium (préinstallés dans le conteneur
# de développement ; sur un poste : npx playwright install chromium).
set -euo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
DEPOT="$(cd "$ICI/../../.." && pwd)"
NOM="wakatnet-e2e-$$"
SECRETS="$(mktemp)"
nettoyer() { docker rm -f "$NOM" >/dev/null 2>&1 || true; rm -f "$SECRETS"; }
trap nettoyer EXIT
alea() { head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
ADMIN="$(alea)"; API="$(alea)"
# Mots de passe jetables, passés par un fichier 0600 : jamais en argument d'une commande (S1).
chmod 600 "$SECRETS"
printf 'POSTGRES_PASSWORD=%s\nWAKATNET_PG_API_PASSWORD=%s\n' "$ADMIN" "$API" > "$SECRETS"

echo "=== PostgreSQL neuf ==="
docker run -d --name "$NOM" -e POSTGRES_USER=wakatnet_admin -e POSTGRES_DB=wakatnet --env-file "$SECRETS" \
  -p 127.0.0.1::5432 -v "$DEPOT/infra/sql:/depot/infra/sql:ro" \
  postgres:16.15@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657 >/dev/null
for _ in $(seq 1 60); do docker exec "$NOM" pg_isready -h 127.0.0.1 -U wakatnet_admin -d wakatnet >/dev/null 2>&1 && break; sleep 1; done
sleep 1
docker exec -e PGUSER=wakatnet_admin -e PGDATABASE=wakatnet --env-file "$SECRETS" "$NOM" \
  bash /depot/infra/sql/migrer.sh 2>&1 | grep -E "à jour|ERREUR|fumée"
PORT="$(docker port "$NOM" 5432/tcp | head -1 | sed 's/.*://')"

# Client Prisma généré (apps/api/genere, ignoré par git), comme le fait tests/Dockerfile : sans lui,
# un dépôt fraîchement cloné (CI) ne trouve pas genere/prisma/client.ts.
echo "=== Client Prisma généré ==="
(cd "$DEPOT" && npm run generer -w apps/api >/dev/null)

echo "=== Tableau de bord construit (vite build) ==="
(cd "$DEPOT" && npm run build -w apps/dashboard >/dev/null)

cd "$DEPOT/apps/api"
export WAKATNET_TEST_ADMIN_URL="postgresql://wakatnet_admin:$ADMIN@127.0.0.1:$PORT/wakatnet"
export WAKATNET_API_DATABASE_URL="postgresql://wk_api:$API@127.0.0.1:$PORT/wakatnet"
echo "=== Achat de bout en bout (Chromium sans interface) ==="
node tests/e2e/achat.ts
echo "=== Parcours 1, 2, 4 et 5 dans le tableau de bord, axe-core (Chromium sans interface) ==="
node tests/e2e/tableau.ts
