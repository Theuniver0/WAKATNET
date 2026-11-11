#!/usr/bin/env bash
# WAKATNET — matrice T du cœur RADIUS, en une commande (ADR 0008 §3).
#
#   radius/tests/run.sh            # pile neuve, tous les tests, recherche de secrets
#   radius/tests/run.sh -k t02     # arguments transmis à pytest
#
# Code de sortie non nul au premier échec. Exige Docker et Docker Compose.
set -euo pipefail

ICI="$(cd "$(dirname "$0")" && pwd)"
cd "$ICI"
C="docker compose -f compose.yml"

etape() { printf '\n=== %s ===\n' "$*"; }

nettoyer() {
  # GARDER_PILE=1 : pile et jeu.secrets conservés pour un diagnostic local (jamais publié).
  if [ "${GARDER_PILE:-0}" != 1 ]; then
    $C down -v --remove-orphans >/dev/null 2>&1 || true
    rm -f jeu.secrets
  fi
}
trap nettoyer EXIT

etape "Pile neuve"
$C down -v --remove-orphans >/dev/null 2>&1 || true

etape "Secrets jetables (jeu.secrets, non versionné)"
umask 077
alea() { head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
{
  echo "POSTGRES_PASSWORD=$(alea)"
  echo "WAKATNET_PG_RADIUS_PASSWORD=$(alea)"
  echo "WAKATNET_PG_TEST_PASSWORD=$(alea)"
  echo "WAKATNET_SECRET_R1=$(alea)"
  echo "WAKATNET_SECRET_R2=$(alea)"
  echo "WAKATNET_SECRET_R3=$(alea)"
} > jeu.secrets
umask 022

etape "Construction du conteneur de test"
docker build -q --network host -f Dockerfile.testeur -t wakatnet-testeur:local \
  --build-arg http_proxy="${HTTP_PROXY:-${http_proxy:-}}" \
  --build-arg https_proxy="${HTTPS_PROXY:-${https_proxy:-}}" . >/dev/null

etape "Démarrage de PostgreSQL et migrations de production"
$C up -d postgres testeur
for _ in $(seq 1 60); do
  $C exec -T postgres pg_isready -U wakatnet_admin -d wakatnet >/dev/null 2>&1 && break
  sleep 1
done
$C exec -T postgres bash /depot/infra/sql/migrer.sh

etape "Démarrage de FreeRADIUS (configuration de production)"
$C up -d freeradius

etape "Garde de version FreeRADIUS (>= 3.2.10, jamais 3.2.9)"
VERSION="$($C exec -T freeradius freeradius -v 2>/dev/null | sed -n 's/.*FreeRADIUS Version \([0-9.]*\).*/\1/p' | head -1)"
echo "FreeRADIUS $VERSION"
python3 - "$VERSION" <<'PY'
import sys
v = tuple(int(x) for x in sys.argv[1].split("."))
if v == (3, 2, 9) or v < (3, 2, 10):
    sys.exit(f"version refusée : {sys.argv[1]} (exigé : >= 3.2.10, jamais 3.2.9 — E-FR-1)")
PY

etape "radiusd -C sur la configuration de production"
$C exec -T freeradius freeradius -C >/dev/null
echo "configuration valide"

for _ in $(seq 1 30); do
  $C logs freeradius 2>&1 | grep -q "Ready to process requests" && break
  sleep 1
done

etape "Tests (pytest)"
set +e
$C exec -T testeur pytest -p no:cacheprovider -q "$@"
CODE=$?
set -e

etape "Preuve T10 dans le journal du serveur"
# Le journal n'est écrit qu'en debug niveau 1 (-x) et stdout est mis en tampon :
# on attend jusqu'à 15 s. Exigé pour le premier paquet (r4, 10.213.1.40) ET pour
# un client en cache (r1, 10.213.1.10) : sinon un rejet pour une autre cause
# (rate_limit, par exemple) passerait pour une preuve.
T10=1
for _ in $(seq 1 15); do
  J="$($C logs --no-color freeradius 2>&1 | grep "does not contain required Message-Authenticator" || true)"
  if grep -q "host 10.213.1.40:" <<<"$J" && grep -q "host 10.213.1.10:" <<<"$J"; then T10=0; break; fi
  sleep 1
done
if [ "$T10" = 0 ]; then
  echo "lignes trouvées pour 10.213.1.40 (premier paquet) et 10.213.1.10 (en cache)"
else
  echo "ABSENTES : rejet T10 non tracé pour les deux routeurs"
fi

etape "Recherche de secrets dans les sorties (ADR 0008 §6)"
TROUVE=0
SORTIES="$(mktemp)"
{
  for s in postgres freeradius testeur; do
    $C logs --no-color "$s" 2>&1 || true
    $C exec -T "$s" sh -c 'cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\0" " "' 2>/dev/null || true
  done
} > "$SORTIES"
while IFS='=' read -r cle valeur; do
  [ -z "$cle" ] && continue
  if grep -qF -- "$valeur" "$SORTIES"; then
    echo "SECRET TROUVÉ dans les sorties : $cle"
    TROUVE=1
  fi
done < jeu.secrets
rm -f "$SORTIES"
[ "$TROUVE" = 0 ] && echo "aucun secret dans les sorties"

if [ "$CODE" != 0 ] || [ "$TROUVE" != 0 ] || [ "$T10" != 0 ]; then
  etape "ÉCHEC (pytest=$CODE, secrets=$TROUVE, t10_journal=$T10)"
  $C logs --no-color --tail 80 freeradius || true
  exit 1
fi
etape "SUCCÈS"
