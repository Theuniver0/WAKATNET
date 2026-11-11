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
n="$(psql -X -q -tA -v ON_ERROR_STOP=1 -h "${WAKATNET_PG_HOST:-127.0.0.1}" -U wk_maint -d wakatnet \
       -c "SELECT radius.purge_auth_log()")"
echo "wakatnet-purge : $n ligne(s) supprimée(s)"
