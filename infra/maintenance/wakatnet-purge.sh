#!/bin/sh
# WAKATNET — purge quotidienne du journal des tentatives à 90 jours (ADR 0005 ; ticket 07).
# Lancé par wakatnet-purge.timer. Installé en /usr/local/sbin/wakatnet-purge.
# Idempotent ; chaque passage est journalisé dans app.audit_log par radius.purge_auth_log().
# Variables (EnvironmentFile réservé, jamais en argument) :
#   WAKATNET_PG_MAINT_PASSWORD (secret), WAKATNET_PG_HOST (défaut 127.0.0.1).
set -eu
PGPASSWORD="${WAKATNET_PG_MAINT_PASSWORD:?WAKATNET_PG_MAINT_PASSWORD manquant}"
PGCONNECT_TIMEOUT=10
export PGPASSWORD PGCONNECT_TIMEOUT
# Par lots : on rappelle tant qu'un lot est plein (rattrapage d'un retard), 1000 lots au plus.
LOT=50000
total=0
i=0
while [ "$i" -lt 1000 ]; do
  n="$(psql -X -q -tA -v ON_ERROR_STOP=1 -h "${WAKATNET_PG_HOST:-127.0.0.1}" -U wk_maint -d wakatnet \
         -c "SELECT radius.purge_auth_log($LOT)")"
  total=$((total + n))
  i=$((i + 1))
  [ "$n" -lt "$LOT" ] && break
done
echo "wakatnet-purge : $total ligne(s) supprimée(s) en $i lot(s)"
