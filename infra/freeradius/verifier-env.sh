#!/bin/sh
# WAKATNET — garde de démarrage de FreeRADIUS (systemd : ExecStartPre=).
# Le langage de configuration de FreeRADIUS ne sait pas exiger une variable :
# $ENV{X} absente vaut "", et un « lifetime » vide vaut 0, soit un cache des
# clients SANS FIN (une désactivation en base n'aurait plus d'effet). Ce script
# refuse le démarrage si une variable manque ou sort de ses bornes.
set -u
erreur=0
dire() { echo "verifier-env : $*" >&2; erreur=1; }

case "${WAKATNET_CLIENT_LIFETIME:-}" in
  ''|*[!0-9]*) dire "WAKATNET_CLIENT_LIFETIME absente ou non entière" ;;
  *) [ "$WAKATNET_CLIENT_LIFETIME" -ge 10 ] && [ "$WAKATNET_CLIENT_LIFETIME" -le 3600 ] \
       || dire "WAKATNET_CLIENT_LIFETIME hors bornes [10 ; 3600]" ;;
esac
[ -n "${WAKATNET_RADIUS_LISTEN:-}" ] || dire "WAKATNET_RADIUS_LISTEN absente"
[ -n "${WAKATNET_PG_HOST:-}" ] || dire "WAKATNET_PG_HOST absente"
[ -n "${WAKATNET_PG_RADIUS_PASSWORD:-}" ] || dire "WAKATNET_PG_RADIUS_PASSWORD absente"
[ -n "${WAKATNET_PG_ACCT_PASSWORD:-}" ] || dire "WAKATNET_PG_ACCT_PASSWORD absente"

[ "$erreur" = 0 ] && echo "verifier-env : environnement complet"
exit "$erreur"
