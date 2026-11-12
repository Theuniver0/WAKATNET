#!/usr/bin/env bash
# WAKATNET — mesure A/B de radius.post_auth : corps de la migration 0009 contre celui de 0012,
# sur la MÊME base et les MÊMES données, en alternance (3 tours). Rejeu : radius/tests/perf/ab-post-auth.sh
# Résultat : resultats/<date>/ab-post-auth.txt. Pile jetable, jamais une base réelle.
set -euo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
DEPOT="$(cd "$ICI/../../.." && pwd)"
cd "$ICI/.."
C="docker compose -f compose.yml -f perf/compose.perf.yml"
R="$ICI/resultats/${RESULTATS:-$(date -u +%Y-%m-%d-%H%M)}"
mkdir -p "$R"
TMP="$(mktemp -d)"
nettoyer() { $C down -v --remove-orphans >/dev/null 2>&1 || true; rm -f jeu.secrets jeu-radius.secrets; rm -rf "$TMP"; }
trap nettoyer EXIT
umask 077
for v in POSTGRES_PASSWORD WAKATNET_PG_RADIUS_PASSWORD WAKATNET_PG_ACCT_PASSWORD WAKATNET_PG_MAINT_PASSWORD \
         WAKATNET_PG_COA_PASSWORD WAKATNET_PG_TEST_PASSWORD WAKATNET_SECRET_R1 WAKATNET_SECRET_R2 WAKATNET_SECRET_R3; do
  echo "$v=$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
done > jeu.secrets
grep -E '^WAKATNET_PG_(RADIUS|ACCT)_PASSWORD=' jeu.secrets > jeu-radius.secrets
umask 022
python3 - "$DEPOT" "$TMP" <<'PY'
import pathlib, sys
depot, tmp = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
def corps(f):
    t = (depot / f).read_text(); i = t.index("CREATE OR REPLACE FUNCTION radius.post_auth(")
    return t[i:t.index("$$;", t.index("RETURN 'ok';", i)) + 3] + "\n"
for nom, f in (("ancien", "infra/sql/radius/0009_radius_devinette.sql"),
               ("nouveau", "infra/sql/radius/0012_radius_devinette_sous_attaque.sans_transaction.sql")):
    (tmp / f"pa-{nom}.sql").write_text("SET ROLE wakatnet_owner;\n" + corps(f) + "RESET ROLE;\n")
PY
$C up -d postgres testeur >/dev/null 2>&1
until $C exec -T postgres pg_isready -h 127.0.0.1 -U wakatnet_admin -d wakatnet >/dev/null 2>&1; do sleep 1; done
$C exec -T postgres bash /depot/infra/sql/migrer.sh >/dev/null
$C exec -T testeur sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -h 172.29.215.5 -U wakatnet_admin -d wakatnet \
  -v routeurs=50 -v tickets=100000 -v sessions=1000 -v jours=90 -v par_jour=300 -f /depot/radius/tests/perf/donnees.sql >/dev/null'
for v in ancien nouveau; do $C cp "$TMP/pa-$v.sql" "testeur:/tmp/pa-$v.sql" >/dev/null 2>&1; done
for tour in 1 2 3; do
  for v in ancien nouveau; do
    printf 'tour %s %-8s ' "$tour" "$v"
    $C exec -T testeur sh -c "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -X -q -h 172.29.215.5 -U wakatnet_admin -d wakatnet \
      -f /tmp/pa-$v.sql -f /depot/radius/tests/perf/ab-post-auth.sql" 2>&1 | grep -o "RESULTAT.*"
  done
done | tee "$R/ab-post-auth.txt"
