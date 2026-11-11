#!/usr/bin/env bash
# WAKATNET — applique les migrations SQL de production (ADR 0008 §1).
#
# Lancé par le SUPERUTILISATEUR PostgreSQL (il crée les rôles ; les objets
# appartiennent ensuite à wakatnet_owner, via SET ROLE dans chaque fichier) :
#   bash infra/sql/migrer.sh
# Variables lues (aucune n'est passée en argument de commande) :
#   POSTGRES_USER / POSTGRES_DB   superutilisateur et base (défauts de l'image postgres)
#   WAKATNET_PG_RADIUS_PASSWORD   mot de passe du rôle wk_radius (posé après les migrations)
#   WAKATNET_PG_ACCT_PASSWORD     mot de passe du rôle wk_acct (lecteur detail, ticket 04)
#
# Garanties :
#   - chaque fichier NNNN_*.sql de app/ et radius/ est appliqué une seule fois,
#     dans l'ordre de son numéro, dans une transaction (psql -1) ;
#   - son empreinte SHA-256 est enregistrée ; un fichier déjà appliqué puis
#     MODIFIÉ arrête le script (un fichier appliqué ne change jamais) ;
#   - un verrou consultatif empêche deux exécutions simultanées.
set -euo pipefail

ICI="$(cd "$(dirname "$0")" && pwd)"
export PGUSER="${PGUSER:-${POSTGRES_USER:?POSTGRES_USER manquant}}"
export PGDATABASE="${PGDATABASE:-${POSTGRES_DB:?POSTGRES_DB manquant}}"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)

"${PSQL[@]}" -c "CREATE TABLE IF NOT EXISTS public.schema_migrations (
  fichier text PRIMARY KEY,
  sha256 text NOT NULL,
  applique_le timestamptz NOT NULL DEFAULT now())"

mapfile -t FICHIERS < <(find "$ICI/app" "$ICI/radius" -maxdepth 1 -name '[0-9][0-9][0-9][0-9]_*.sql' -printf '%f\t%p\n' | sort | cut -f2)
for f in "${FICHIERS[@]}"; do
  nom="$(basename "$f")"
  empreinte="$(sha256sum "$f" | cut -d' ' -f1)"
  connue="$("${PSQL[@]}" -tA -v nom="$nom" <<'SQL'
SELECT sha256 FROM public.schema_migrations WHERE fichier = :'nom';
SQL
)"
  if [ -n "$connue" ]; then
    if [ "$connue" != "$empreinte" ]; then
      echo "ERREUR : $nom a été modifié après application (empreinte différente)." >&2
      exit 1
    fi
    echo "déjà appliquée : $nom"
    continue
  fi
  echo "application : $nom"
  {
    echo "SELECT pg_advisory_xact_lock(hashtext('wakatnet_migrations'));"
    cat "$f"
    echo "INSERT INTO public.schema_migrations (fichier, sha256) VALUES (:'nom', :'empreinte');"
  } | "${PSQL[@]}" -1 -v nom="$nom" -v empreinte="$empreinte" -f -
done

# Mots de passe des rôles de FreeRADIUS : lus dans l'environnement par psql (\getenv),
# jamais sur une ligne de commande ni dans un fichier versionné. La session coupe
# la journalisation des instructions pour qu'aucun mot de passe n'apparaisse dans
# un journal, même en cas d'erreur. Le nom du rôle est une constante du script.
poser_mot_de_passe() {
  local role="$1" variable="$2"
  if [ -n "${!variable:-}" ]; then
    "${PSQL[@]}" -v role="$role" -v variable="$variable" <<'SQL'
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
\getenv mdp :variable
ALTER ROLE :"role" PASSWORD :'mdp';
SQL
    echo "mot de passe de $role posé"
  else
    echo "ATTENTION : $variable absent — $role n'a pas de mot de passe : FreeRADIUS ne pourra pas se connecter avec ce rôle." >&2
  fi
}
poser_mot_de_passe wk_radius WAKATNET_PG_RADIUS_PASSWORD
poser_mot_de_passe wk_acct WAKATNET_PG_ACCT_PASSWORD
echo "migrations à jour"
