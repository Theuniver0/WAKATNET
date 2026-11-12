#!/usr/bin/env bash
# WAKATNET — mesure de performance du cœur RADIUS (ticket 10). Rejeu : radius/tests/perf/perf.sh
#
# Pile de test (compose.yml) avec la surcharge compose.perf.yml : serveur sur les cœurs 0-2,
# générateur sur le cœur 3, durée de vie de production des clients (300 s). Jeu de données
# donnees.sql (50 routeurs, puis 500 pour l'essai ×10). Résultats bruts : resultats/*.json et
# resultats/*.txt ; le rapport (RAPPORT.md) est écrit à partir d'eux.
# Exige Docker et Docker Compose. Jamais contre une base réelle : la pile est neuve et jetable.
set -euo pipefail

ICI="$(cd "$(dirname "$0")" && pwd)"
TESTS="$(cd "$ICI/.." && pwd)"
cd "$TESTS"
C="docker compose -f compose.yml -f perf/compose.perf.yml --profile ha"
# Un répertoire daté par passe : une passe n'écrase jamais les preuves d'une autre (revue).
R="$ICI/resultats/${RESULTATS:-$(date -u +%Y-%m-%d-%H%M)}"
mkdir -p "$R"
ROUTEURS_X10="${ROUTEURS_X10:-500}"
# PHASES : sous-ensemble à rejouer (défaut : toutes). Ex. PHASES="spool x10" perf/perf.sh
PHASES="${PHASES:-debit serveur plans spool x10}"
phase() { [[ " $PHASES " == *" $1 "* ]]; }

etape() { printf '\n=== %s ===\n' "$*"; }
nettoyer() { $C down -v --remove-orphans >/dev/null 2>&1 || true; rm -f jeu.secrets jeu-radius.secrets; }
trap nettoyer EXIT

etape "Pile neuve, secrets jetables"
$C down -v --remove-orphans >/dev/null 2>&1 || true
umask 077
alea() { head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
{
  for v in POSTGRES_PASSWORD WAKATNET_PG_RADIUS_PASSWORD WAKATNET_PG_ACCT_PASSWORD WAKATNET_PG_MAINT_PASSWORD \
           WAKATNET_PG_COA_PASSWORD WAKATNET_PG_TEST_PASSWORD WAKATNET_PG_REPLICATION_PASSWORD WAKATNET_PG_REWIND_PASSWORD \
           WAKATNET_PG_SANTE_PASSWORD WAKATNET_SECRET_R1 WAKATNET_SECRET_R2 WAKATNET_SECRET_R3; do
    echo "$v=$(alea)"
  done
} > jeu.secrets
grep -E '^WAKATNET_PG_(RADIUS|ACCT)_PASSWORD=' jeu.secrets > jeu-radius.secrets
umask 022
docker build -q --network host -f Dockerfile.testeur -t wakatnet-testeur:local \
  --build-arg http_proxy --build-arg https_proxy . >/dev/null

pret_pg() {
  for _ in $(seq 1 600); do
    $C exec -T postgres pg_isready -h 127.0.0.1 -U wakatnet_admin -d wakatnet >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  echo "PostgreSQL ne répond pas" >&2; exit 1
}
psql_t() { $C exec -T -e PGHOST=172.29.215.5 -e PGUSER=wakatnet_admin -e PGDATABASE=wakatnet testeur \
             sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -v ON_ERROR_STOP=1 "$@"' psql "$@"; }

charger() {   # charger ROUTEURS : base neuve, migrations, données, FreeRADIUS, IP des routeurs, clients créés
  local n="$1"
  $C down -v --remove-orphans >/dev/null 2>&1 || true
  $C up -d postgres testeur >/dev/null 2>&1
  pret_pg
  $C exec -T postgres bash /depot/infra/sql/migrer.sh >/dev/null
  etape "Jeu de données : $n routeurs"
  local debut=$SECONDS
  psql_t -q -v routeurs="$n" -v tickets=100000 -v sessions=1000 -v jours=90 -v par_jour=300 \
         -f /depot/radius/tests/perf/donnees.sql | tee "$R/donnees-$n.txt"
  echo "chargé en $((SECONDS - debut)) s" | tee -a "$R/donnees-$n.txt"
  $C up -d freeradius >/dev/null 2>&1
  for _ in $(seq 1 30); do
    grep -q "Ready to process requests" <<<"$($C logs freeradius 2>&1)" && break
    sleep 1
  done
  $C exec -T -e PYTHONPATH=/depot/radius/tests testeur python3 /depot/radius/tests/perf/preparer.py --routeurs "$n" | tee "$R/preparation-$n.txt"
}

mesure() {   # mesure NOM ARGUMENTS… : une passe du générateur, résultat JSON dans resultats/NOM.json
  local nom="$1"; shift
  $C exec -T -e PYTHONPATH=/depot/radius/tests testeur python3 /depot/radius/tests/perf/charge.py "$@" | tee "$R/$nom.json"
}

# ---------------------------------------------------------------------------------------
charger 50

if phase debit; then
etape "Débit : Accept puis Reject, paliers de 20 s (journalisation des instructions coupée)"
for d in 100 200 400 800; do mesure "accept-$d" --mode accept --debit "$d" --duree 20; done
for d in 100 200 400 800; do mesure "reject-$d" --mode reject --debit "$d" --duree 20; done
fi

if phase serveur; then
etape "p95 côté serveur : durée de chaque instruction de FreeRADIUS (log_min_duration_statement = 0)"
# Mesure seulement : les codes de cette base sont jetables. Les connexions existantes sont
# fermées pour prendre le réglage (rlm_sql se reconnecte et rejoue une fois).
psql_t -q -c "ALTER ROLE wk_radius SET log_min_duration_statement = 0" \
       -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = 'wk_radius'"
DEPUIS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mesure "serveur-accept-200" --mode accept --debit 200 --duree 30
mesure "serveur-reject-200" --mode reject --debit 200 --duree 30
$C logs --no-color --since "$DEPUIS" postgres > "$R/journal-pg-200.txt" 2>&1
python3 "$ICI/durees.py" "$R/journal-pg-200.txt" | tee "$R/serveur-200.json"
psql_t -q -c "ALTER ROLE wk_radius SET log_min_duration_statement = -1"
fi

if phase plans; then
etape "Plans d'exécution (auto_explain, instructions imbriquées de authorize)"
psql_t -f /depot/radius/tests/perf/plans.sql > "$R/plans.txt" 2>&1 || true
fi

if phase spool; then
etape "Rattrapage du lecteur detail : une heure de panne pour 1 000 sessions (30 Interim chacune)"
mesure "spool-cibles" --exporter /tmp/perf-cibles.json
$C stop postgres >/dev/null 2>&1
mesure "spool-remplissage" --mode interim --sessions 1000 --debit 1000 --duree 30 --depuis /tmp/perf-cibles.json
DEBUT_REJEU="$(date +%s.%N)"
$C start postgres >/dev/null 2>&1
pret_pg
$C exec -T -e PYTHONPATH=/depot/radius/tests testeur python3 /depot/radius/tests/perf/vidage.py --debut "$DEBUT_REJEU" | tee "$R/spool-vidage.json"
fi

if phase x10; then
etape "Essai ×10 : $ROUTEURS_X10 routeurs"
charger "$ROUTEURS_X10"
mesure "x10-accept-200" --mode accept --debit 200 --duree 30 --routeurs "$ROUTEURS_X10"
etape "Essai ×10, 6 min plus tard : clients dynamiques expirés (lifetime 300 s) et recréés"
sleep 360
mesure "x10-accept-200-apres-expiration" --mode accept --debit 200 --duree 60 --routeurs "$ROUTEURS_X10"
fi

if phase ha; then
etape "Deux nœuds (phase 5, ticket 07) : B en réplique par flux de A"
psql_t -q -c "SELECT pg_create_physical_replication_slot('noeud_b')" >/dev/null
$C exec -T postgres bash -c 'echo "host replication wk_replication 172.29.215.0/24 scram-sha-256" >> "$PGDATA/pg_hba.conf"'
psql_t -q -c "SELECT pg_reload_conf()" >/dev/null
DEBUT_COPIE=$SECONDS
$C up -d postgres_b >/dev/null 2>&1
for _ in $(seq 1 300); do $C exec -T postgres_b pg_isready -q -h 127.0.0.1 -U wakatnet_admin -d wakatnet 2>/dev/null && break; sleep 1; done
echo "réplique prête (copie de base comprise) en $((SECONDS - DEBUT_COPIE)) s" | tee "$R/ha-copie.txt"
$C up -d freeradius_b >/dev/null 2>&1
for _ in $(seq 1 30); do grep -q "Ready to process requests" <<<"$($C logs freeradius_b 2>&1)" && break; sleep 1; done
$C exec -T -e PYTHONPATH=/depot/radius/tests -e WAKATNET_PERF_SERVEUR=10.213.0.2 testeur \
  python3 /depot/radius/tests/perf/preparer.py --routeurs 50 | tee "$R/ha-preparation-b.txt"
mesure "ha-cibles" --exporter /tmp/perf-cibles-ha.json

etape "A à 200 auth/s, réplication active : retard de B relevé chaque seconde"
( for _ in $(seq 1 22); do
    psql_t -tA -c "SELECT now()::time(0), coalesce(round(extract(epoch FROM max(replay_lag)) * 1000), 0) AS retard_ms,
                          coalesce(max(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)), 0) AS octets_en_retard
                     FROM pg_stat_replication" 2>/dev/null
    sleep 1
  done ) > "$R/ha-retard-replication.txt" &
SONDE=$!
mesure "ha-a-accept-200" --mode accept --debit 200 --duree 20 --depuis /tmp/perf-cibles-ha.json
wait "$SONDE" || true
python3 - "$R/ha-retard-replication.txt" <<'PY' | tee "$R/ha-retard-synthese.json"
import json, sys
l = [x.split("|") for x in open(sys.argv[1]).read().split() if "|" in x]
r = [int(float(a[1])) for a in l]; o = [int(float(a[2])) for a in l]
print(json.dumps({"mesures": len(l), "retard_max_ms": max(r, default=None), "octets_max": max(o, default=None)}))
PY

etape "PostgreSQL de A arrêté : B à 200 auth/s depuis sa réplique (mode dégradé, T13)"
$C stop postgres >/dev/null 2>&1
$C exec -T -e PYTHONPATH=/depot/radius/tests -e WAKATNET_PERF_SERVEUR=10.213.0.2 testeur \
  python3 /depot/radius/tests/perf/charge.py --mode accept --debit 200 --duree 20 --depuis /tmp/perf-cibles-ha.json \
  | tee "$R/ha-b-accept-200.json"
$C exec -T -e PYTHONPATH=/depot/radius/tests -e WAKATNET_PERF_SERVEUR=10.213.0.2 testeur \
  python3 /depot/radius/tests/perf/charge.py --mode accept --debit 400 --duree 20 --depuis /tmp/perf-cibles-ha.json \
  | tee "$R/ha-b-accept-400.json"
$C start postgres >/dev/null 2>&1
pret_pg
fi

etape "Matériel"
{ nproc; lscpu | grep -E "Model name|^CPU\(s\)|Thread|MHz" ; free -m | head -2; docker info --format '{{.ServerVersion}}'; } \
  > "$R/materiel.txt" 2>&1
cat "$R/materiel.txt"
etape "FIN : résultats dans $R"
