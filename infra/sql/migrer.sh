#!/usr/bin/env bash
# WAKATNET — applique les migrations SQL de production (ADR 0008 §1).
#
# Lancé par le superutilisateur PostgreSQL, sur le nœud ou dans la pile de test :
#   PGUSER=... PGDATABASE=... bash infra/sql/migrer.sh
# Variables lues (aucune n'est passée en argument de commande) :
#   POSTGRES_USER / POSTGRES_DB   superutilisateur et base (défauts de l'image postgres)
#   WAKATNET_PG_RADIUS_PASSWORD   mot de passe du rôle wk_radius (posé après les migrations)
#
# Idempotent : chaque fichier NNNN_*.sql de app/ et radius/ est appliqué une seule
# fois, dans l'ordre de son numéro, dans une transaction, et inscrit dans
# public.schema_migrations. Un fichier déjà appliqué n'est jamais modifié.
set -euo pipefail

ICI="$(cd "$(dirname "$0")" && pwd)"
export PGUSER="${PGUSER:-${POSTGRES_USER:?POSTGRES_USER manquant}}"
export PGDATABASE="${PGDATABASE:-${POSTGRES_DB:?POSTGRES_DB manquant}}"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)

"${PSQL[@]}" -c "CREATE TABLE IF NOT EXISTS public.schema_migrations (
  fichier text PRIMARY KEY, applique_le timestamptz NOT NULL DEFAULT now())"

mapfile -t FICHIERS < <(find "$ICI/app" "$ICI/radius" -maxdepth 1 -name '[0-9][0-9][0-9][0-9]_*.sql' -printf '%f\t%p\n' | sort | cut -f2)
for f in "${FICHIERS[@]}"; do
  nom="$(basename "$f")"
  deja="$("${PSQL[@]}" -tA -c "SELECT 1 FROM public.schema_migrations WHERE fichier = '$nom'")"
  if [ "$deja" = 1 ]; then
    echo "déjà appliquée : $nom"
    continue
  fi
  echo "application : $nom"
  { echo "BEGIN;"; cat "$f"; echo "INSERT INTO public.schema_migrations (fichier) VALUES ('$nom');"; echo "COMMIT;"; } \
    | "${PSQL[@]}"
done

# Mot de passe du rôle FreeRADIUS : lu dans l'environnement par psql (\getenv),
# jamais sur une ligne de commande ni dans un fichier versionné.
if [ -n "${WAKATNET_PG_RADIUS_PASSWORD:-}" ]; then
  "${PSQL[@]}" <<'SQL'
\getenv mdp WAKATNET_PG_RADIUS_PASSWORD
ALTER ROLE wk_radius PASSWORD :'mdp';
SQL
  echo "mot de passe de wk_radius posé"
fi
echo "migrations à jour"
