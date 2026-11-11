#!/usr/bin/env bash
# WAKATNET — matrice T du cœur RADIUS, en une commande (ADR 0008 §3).
#
#   radius/tests/run.sh            # passage PROBANT : pile neuve, tous les tests, preuves, secrets
#   radius/tests/run.sh -k t02     # sous-ensemble (arguments transmis à pytest) ; la preuve
#                                  # T10 dans le journal n'est alors pas exigée
#   GARDER_PILE=1 radius/tests/run.sh   # garde la pile pour un diagnostic LOCAL (jamais publié)
#
# Code de sortie non nul au premier échec. Exige Docker et Docker Compose
# (sous Windows : depuis WSL2).
set -euo pipefail

ICI="$(cd "$(dirname "$0")" && pwd)"
cd "$ICI"
C="docker compose -f compose.yml"

# Toute la sortie de ce script (pytest compris) est aussi écrite dans un fichier,
# analysé par la recherche de secrets à la fin (ADR 0008 §6).
SORTIE_RUN="$(mktemp)"
exec > >(tee -a "$SORTIE_RUN") 2>&1

etape() { printf '\n=== %s ===\n' "$*"; }
echec() { echo "ÉCHEC : $*" >&2; exit 1; }

nettoyer() {
  if [ "${GARDER_PILE:-0}" != 1 ]; then
    $C down -v --remove-orphans >/dev/null 2>&1 || true
    rm -f jeu.secrets jeu-radius.secrets
  fi
  rm -f "$SORTIE_RUN"
}
trap nettoyer EXIT

etape "Pile neuve"
$C down -v --remove-orphans >/dev/null 2>&1 || true

etape "Secrets jetables (non versionnés)"
umask 077
alea() { head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
{
  echo "POSTGRES_PASSWORD=$(alea)"
  echo "WAKATNET_PG_RADIUS_PASSWORD=$(alea)"
  echo "WAKATNET_PG_ACCT_PASSWORD=$(alea)"
  echo "WAKATNET_PG_TEST_PASSWORD=$(alea)"
  echo "WAKATNET_SECRET_R1=$(alea)"
  echo "WAKATNET_SECRET_R2=$(alea)"
  echo "WAKATNET_SECRET_R3=$(alea)"
} > jeu.secrets
grep -E '^WAKATNET_PG_(RADIUS|ACCT)_PASSWORD=' jeu.secrets > jeu-radius.secrets
umask 022

etape "Construction du conteneur de test"
# --build-arg sans valeur : Docker lit le proxy dans l'environnement, sans l'écrire
# sur la ligne de commande ni dans l'historique de l'image.
docker build -q --network host -f Dockerfile.testeur -t wakatnet-testeur:local \
  --build-arg http_proxy --build-arg https_proxy . >/dev/null

etape "Démarrage de PostgreSQL et migrations de production"
$C up -d postgres testeur
PRET=0
for _ in $(seq 1 60); do
  if $C exec -T postgres pg_isready -h 127.0.0.1 -U wakatnet_admin -d wakatnet >/dev/null 2>&1; then PRET=1; break; fi
  sleep 1
done
[ "$PRET" = 1 ] || echec "PostgreSQL n'est pas prêt après 60 s"
$C exec -T postgres bash /depot/infra/sql/migrer.sh

etape "Garde-fou ADR 0007 : les migrations seules ne créent aucun objet de test"
OBJETS_TEST="$($C exec -T postgres psql -X -tA -U wakatnet_admin -d wakatnet -c "
  SELECT string_agg(x, ', ') FROM (
    SELECT 'rôle ' || rolname AS x FROM pg_roles
     WHERE rolname NOT LIKE 'pg\_%' AND rolname NOT IN ('wakatnet_admin', 'wakatnet_owner', 'wk_radius', 'wk_acct')
    UNION ALL
    SELECT 'fonction ' || p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('app', 'radius') AND p.proname ILIKE '%test%'
    UNION ALL
    SELECT 'extension ' || extname FROM pg_extension WHERE extname NOT IN ('plpgsql', 'pgcrypto')
  ) t")"
[ -z "$OBJETS_TEST" ] || echec "objets inattendus après les seules migrations : $OBJETS_TEST"
echo "aucun rôle, aucune fonction ni extension de test"

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
$C exec -T freeradius freeradius -C >/dev/null || echec "configuration invalide"
echo "configuration valide"
# FreeRADIUS accepte un lifetime vide (= 0 : cache sans fin, désactivation en base
# sans effet ; constaté le 11/11/2026). La garde verifier-env.sh doit donc le refuser.
$C exec -T freeradius sh /opt/wakatnet/verifier-env.sh >/dev/null || echec "garde : environnement de test refusé"
for v in WAKATNET_CLIENT_LIFETIME WAKATNET_PG_RADIUS_PASSWORD WAKATNET_PG_ACCT_PASSWORD; do
  if $C exec -T freeradius env -u "$v" sh /opt/wakatnet/verifier-env.sh >/dev/null 2>&1; then
    echec "la garde accepte un environnement sans $v"
  fi
done
if $C exec -T freeradius env WAKATNET_CLIENT_LIFETIME=0 sh /opt/wakatnet/verifier-env.sh >/dev/null 2>&1; then
  echec "la garde accepte WAKATNET_CLIENT_LIFETIME=0"
fi
echo "garde verifier-env.sh : refuse une variable absente ou un lifetime nul (attendu)"

PRET=0
for _ in $(seq 1 30); do
  if $C logs freeradius 2>&1 | grep -q "Ready to process requests"; then PRET=1; break; fi
  sleep 1
done
[ "$PRET" = 1 ] || echec "FreeRADIUS n'est pas prêt après 30 s"

etape "Tests (pytest)"
set +e
$C exec -T testeur pytest -p no:cacheprovider -q "$@"
CODE=$?
set -e

T10=0
if [ "$#" = 0 ]; then
  etape "Preuve T10 dans le journal du serveur"
  # Écrite seulement en debug niveau 1 (-x), et stdout est mis en tampon : on attend
  # jusqu'à 15 s. Exigée pour le premier paquet (r4) ET pour un client en cache (r1) :
  # sinon un rejet pour une autre cause (rate_limit…) passerait pour une preuve.
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
fi

INDISPO=0
if [ "$#" = 0 ]; then
  etape "Base indisponible : accounting découplé (ticket 04)"
  # Le conteneur de test ne pilote pas Docker : run.sh arrête, fige et relance la base
  # entre deux étapes de test_t04_indispo.py (ADR 0008, amendement du ticket 04).
  # Chaque étape doit compter exactement « 1 passed » : une étape ignorée est un échec.
  pas() {
    local sortie
    sortie="$($C exec -T -e WAKATNET_ETAPE="$1" -e WAKATNET_SANS_FIXTURES=1 testeur \
              pytest -p no:cacheprovider -q test_t04_indispo.py 2>&1)" || true
    printf '%s\n' "$sortie" | tail -3
    if ! grep -q "1 passed" <<<"$sortie" || grep -qE "[0-9]+ (failed|errors?)" <<<"$sortie"; then
      printf '%s\n' "$sortie" | grep -E '^E |Error|assert' | head -20
      echo "étape $1 : ÉCHEC"
      INDISPO=1
    fi
  }
  pret_pg() {
    for _ in $(seq 1 60); do
      $C exec -T postgres pg_isready -h 127.0.0.1 -U wakatnet_admin -d wakatnet >/dev/null 2>&1 && return 0
      sleep 1
    done
    echo "PostgreSQL ne redémarre pas"; INDISPO=1
  }
  pas a
  echo "--- base ARRÊTÉE"
  $C stop postgres >/dev/null 2>&1
  pas b
  sleep 10   # ATTENTE_S de test_t04_indispo.py : l'activation doit valoir la réception, pas le rejeu
  $C start postgres >/dev/null 2>&1 && pret_pg
  pas c
  echo "--- base FIGÉE (docker compose pause)"
  $C pause postgres >/dev/null 2>&1
  pas d
  sleep 10
  $C unpause postgres >/dev/null 2>&1 && pret_pg
  pas e
  [ "$INDISPO" = 0 ] && echo "accounting : réponse immédiate base arrêtée et figée ; rejeu complet, sans perte ni doublon"
fi

etape "Recherche de secrets dans les sorties (ADR 0008 §6)"
TROUVE=0
SORTIES="$(mktemp)"
{
  cat "$SORTIE_RUN"
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
[ "$TROUVE" = 0 ] && echo "aucun secret dans les sorties (script, pytest, journaux, lignes de commande)"

if [ "$CODE" != 0 ] || [ "$TROUVE" != 0 ] || [ "$T10" != 0 ] || [ "$INDISPO" != 0 ]; then
  etape "ÉCHEC (pytest=$CODE, secrets=$TROUVE, t10_journal=$T10, base_indisponible=$INDISPO)"
  $C logs --no-color --tail 60 freeradius || true
  exit 1
fi
etape "SUCCÈS"
