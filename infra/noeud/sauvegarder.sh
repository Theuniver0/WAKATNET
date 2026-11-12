#!/bin/bash
# WAKATNET — sauvegarde nocturne par pgBackRest (ADR 0015 §5). Lancé par wakatnet-sauvegarde.timer
# sur LES DEUX nœuds, en tant que postgres : il ne fait rien sur une réplique (la sauvegarde suit le
# primaire après une bascule). Complète le jour WAKATNET_JOUR_COMPLETE (7 = dimanche), différentielle
# sinon (pgBackRest la change en complète s'il n'en existe aucune).
# Écrit, SEULEMENT en cas de réussite, l'état lu par le collecteur de santé : un échec laisse vieillir
# l'heure de la dernière réussite, et l'alerte « sauvegarde » se lève au-delà de 26 h.
set -euo pipefail
STANZA="${WAKATNET_STANZA:-wakatnet}"
ETAT="${WAKATNET_ETAT_SAUVEGARDE:-/var/lib/wakatnet/sauvegarde.json}"
JOUR_COMPLETE="${WAKATNET_JOUR_COMPLETE:-7}"

if [ "$(psql -X -q -tA -d postgres -c 'SELECT pg_is_in_recovery()')" = t ]; then
  echo "wakatnet-sauvegarde : réplique, rien à faire sur ce nœud"
  exit 0
fi
type="diff"
[ "$(date +%u)" = "$JOUR_COMPLETE" ] && type="full"
debut="$(date +%s)"
pgbackrest --stanza="$STANZA" backup --type="$type"
fin="$(date +%s)"
etiquette="$(pgbackrest --stanza="$STANZA" info --output=json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["backup"][-1]["label"])')"
tmp="$(mktemp "$(dirname "$ETAT")/.sauvegarde.XXXXXX")"
printf '{"fin":"%s","ok":true,"type":"%s","etiquette":"%s","duree_s":%d}\n' \
  "$(date -u -d "@$fin" +%Y-%m-%dT%H:%M:%SZ)" "$type" "$etiquette" "$((fin - debut))" > "$tmp"
chmod 0644 "$tmp"
mv "$tmp" "$ETAT"
echo "wakatnet-sauvegarde : $type $etiquette en $((fin - debut)) s"
