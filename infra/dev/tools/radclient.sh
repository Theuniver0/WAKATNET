#!/bin/sh
# WAKATNET — enveloppe de radclient pour le profil "tools" (DÉVELOPPEMENT).
#
# Lit le secret partagé dans $RADIUS_DEV_SECRET (infra/dev/.env), l'écrit dans
# un fichier temporaire lisible par root seul et le passe à radclient par -S :
# le secret n'apparaît jamais en argument de commande (SPEC §13, règle 5).
#
# Tous les arguments sont transmis à radclient, par exemple :
#   -x freeradius:1812 auth      (requête lue sur l'entrée standard)
set -eu

if [ -z "${RADIUS_DEV_SECRET:-}" ] || [ "$RADIUS_DEV_SECRET" = "CHANGE_ME" ]; then
	echo "RADIUS_DEV_SECRET absent ou non modifié dans infra/dev/.env" >&2
	exit 2
fi

umask 077
secret_file="$(mktemp)"
trap 'rm -f "$secret_file"' EXIT INT TERM
printf '%s' "$RADIUS_DEV_SECRET" > "$secret_file"

radclient -S "$secret_file" "$@"
