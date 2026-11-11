#!/bin/sh
# WAKATNET — fermeture des sessions fantômes (ADR 0006 §8, §17 ; ticket 06).
# Lancé toutes les 60 s par wakatnet-fantomes.timer. Installé en /usr/local/sbin/wakatnet-fantomes.
#
# La fermeture se mesure par rapport à l'AVANCEMENT du lecteur detail (radius.lecteur_battement),
# jamais à l'heure courante : un Interim encore dans le spool ne peut pas faire fermer sa session.
# Ce script fait avancer ce repère quand il voit le spool VIDE (instant relevé avant de regarder).
# Spool illisible ou introuvable : échec, rien n'est marqué ni fermé.
# Variables (EnvironmentFile réservé, jamais en argument) :
#   WAKATNET_PG_MAINT_PASSWORD (secret), WAKATNET_PG_HOST (défaut 127.0.0.1),
#   WAKATNET_SPOOL (défaut /var/log/freeradius/radacct/wakatnet).
set -eu
SPOOL="${WAKATNET_SPOOL:-/var/log/freeradius/radacct/wakatnet}"
PARENT="$(dirname "$SPOOL")"

# Le répertoire du spool n'existe qu'après le premier accounting ; son parent, lui, doit exister.
if [ ! -d "$PARENT" ] || [ ! -r "$PARENT" ] || [ ! -x "$PARENT" ]; then
  echo "wakatnet-fantomes : $PARENT introuvable ou illisible, rien n'est fait" >&2
  exit 1
fi
if [ -e "$SPOOL" ] && { [ ! -d "$SPOOL" ] || [ ! -r "$SPOOL" ] || [ ! -x "$SPOOL" ]; }; then
  echo "wakatnet-fantomes : spool $SPOOL illisible, rien n'est fait" >&2
  exit 1
fi

AVANT="$(date +%s)"
VIDE=oui
for f in "$SPOOL"/detail-* "$SPOOL"/detail.work; do
  [ -e "$f" ] && VIDE=non && break
done

# Le mot de passe passe par l'environnement de psql, jamais par la ligne de commande.
PGPASSWORD="${WAKATNET_PG_MAINT_PASSWORD:?WAKATNET_PG_MAINT_PASSWORD manquant}"
PGCONNECT_TIMEOUT=10
export PGPASSWORD PGCONNECT_TIMEOUT
n="$(psql -X -q -tA -v ON_ERROR_STOP=1 -v avant="$AVANT" -v vide="$VIDE" \
       -h "${WAKATNET_PG_HOST:-127.0.0.1}" -U wk_maint -d wakatnet <<'SQL'
SELECT CASE WHEN :'vide' = 'oui' THEN radius.marquer_spool_vide(:'avant') END AS marque \gset
SELECT radius.close_ghost_sessions();
SQL
)"
echo "wakatnet-fantomes : spool vide=$VIDE ; $n session(s) fermée(s)"
