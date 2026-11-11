#!/bin/sh
# WAKATNET — fermeture des sessions fantômes (ADR 0006 §8, §17 ; ticket 06).
# Lancé toutes les 60 s par wakatnet-fantomes.timer. Installé en /usr/local/sbin/wakatnet-fantomes.
#
# Ne ferme RIEN tant que le spool d'accounting n'est pas vidé : un Interim en attente de
# rejeu prouverait qu'une session « silencieuse » est en fait vivante.
# Variables (EnvironmentFile réservé, jamais en argument) :
#   WAKATNET_PG_MAINT_PASSWORD (secret), WAKATNET_PG_HOST (défaut 127.0.0.1),
#   WAKATNET_SPOOL (défaut /var/log/freeradius/radacct/wakatnet).
set -eu
SPOOL="${WAKATNET_SPOOL:-/var/log/freeradius/radacct/wakatnet}"

for f in "$SPOOL"/detail-* "$SPOOL"/detail.work; do
  if [ -e "$f" ]; then
    echo "wakatnet-fantomes : rejeu en cours ($(basename "$f")), aucune fermeture"
    exit 0
  fi
done

# Le mot de passe passe par l'environnement de psql, jamais par la ligne de commande.
PGPASSWORD="${WAKATNET_PG_MAINT_PASSWORD:?WAKATNET_PG_MAINT_PASSWORD manquant}"
export PGPASSWORD
n="$(psql -X -q -tA -h "${WAKATNET_PG_HOST:-127.0.0.1}" -U wk_maint -d wakatnet \
       -c "SELECT radius.close_ghost_sessions()")"
echo "wakatnet-fantomes : $n session(s) fermée(s)"
