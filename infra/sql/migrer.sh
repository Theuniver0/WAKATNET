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
#   WAKATNET_PG_MAINT_PASSWORD    mot de passe du rôle wk_maint (tâches planifiées, ticket 06)
#   WAKATNET_PG_COA_PASSWORD      mot de passe du rôle wk_coa (déclencheur de coupure, ticket 09)
#   WAKATNET_PG_API_PASSWORD      mot de passe du rôle wk_api (API, phase 2)
#
# Garanties :
#   - chaque fichier NNNN_*.sql de app/ et radius/ est appliqué une seule fois,
#     dans l'ordre de son numéro, dans une transaction (psql -1) ;
#   - son empreinte SHA-256 est enregistrée ; un fichier déjà appliqué puis
#     MODIFIÉ arrête le script (un fichier appliqué ne change jamais) ;
#   - un verrou consultatif empêche deux exécutions simultanées ;
#   - aucune migration n'attend un verrou plus de WAKATNET_MIGRATION_ATTENTE_VERROU (200 ms par
#     défaut) : une attente plus longue ferait patienter derrière elle toutes les lectures
#     d'authorize, au-delà de leur statement_timeout (nœud muet). Le fichier est alors
#     réessayé (au plus 30 fois, une seconde d'écart), puis le script échoue ;
#   - un fichier « NNNN_*.sans_transaction.sql » est appliqué HORS transaction, pour permettre
#     CREATE / DROP INDEX CONCURRENTLY sur une table vivante. Il doit être idempotent (une
#     reprise après un échec partiel repart proprement) ; il n'est enregistré qu'après succès.
set -euo pipefail

ICI="$(cd "$(dirname "$0")" && pwd)"
export PGUSER="${PGUSER:-${POSTGRES_USER:?POSTGRES_USER manquant}}"
export PGDATABASE="${PGDATABASE:-${POSTGRES_DB:?POSTGRES_DB manquant}}"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
ATTENTE_VERROU="${WAKATNET_MIGRATION_ATTENTE_VERROU:-200ms}"

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
  essai=1
  while :; do
    if [[ "$nom" == *.sans_transaction.sql ]]; then
      # Hors transaction : verrou consultatif de SESSION, rendu à la fin de psql.
      sortie="$({
        echo "SELECT pg_advisory_lock(hashtext('wakatnet_migrations'));"
        echo "SET lock_timeout = :'attente';"
        cat "$f"
        echo "INSERT INTO public.schema_migrations (fichier, sha256) VALUES (:'nom', :'empreinte');"
      } | "${PSQL[@]}" -v nom="$nom" -v empreinte="$empreinte" -v attente="$ATTENTE_VERROU" -f - 2>&1)" && code=0 || code=$?
    else
      sortie="$({
        echo "SELECT pg_advisory_xact_lock(hashtext('wakatnet_migrations'));"
        echo "SET LOCAL lock_timeout = :'attente';"
        cat "$f"
        echo "INSERT INTO public.schema_migrations (fichier, sha256) VALUES (:'nom', :'empreinte');"
      } | "${PSQL[@]}" -1 -v nom="$nom" -v empreinte="$empreinte" -v attente="$ATTENTE_VERROU" -f - 2>&1)" && code=0 || code=$?
    fi
    [ -n "$sortie" ] && printf '%s\n' "$sortie"
    [ "$code" = 0 ] && break
    if grep -q "lock timeout" <<<"$sortie" && [ "$essai" -lt 30 ]; then
      echo "verrou indisponible pour $nom (essai $essai) : nouvel essai dans 1 s"
      essai=$((essai + 1))
      sleep 1
      continue
    fi
    echo "ERREUR : échec de $nom" >&2
    exit 1
  done
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
    echo "ATTENTION : $variable absent — $role n'a pas de mot de passe : ce rôle ne pourra pas se connecter." >&2
  fi
}
poser_mot_de_passe wk_radius WAKATNET_PG_RADIUS_PASSWORD
poser_mot_de_passe wk_acct WAKATNET_PG_ACCT_PASSWORD
poser_mot_de_passe wk_maint WAKATNET_PG_MAINT_PASSWORD
poser_mot_de_passe wk_coa WAKATNET_PG_COA_PASSWORD
poser_mot_de_passe wk_api WAKATNET_PG_API_PASSWORD
echo "migrations à jour"

# Test de fumée du chemin critique (ADR 0009 §3) : une migration qui casse un droit ou une
# fonction rendrait tout le parc muet. Les migrations sont déjà validées à ce point : le
# script ne les annule pas, il échoue pour que le défaut soit vu et corrigé aussitôt.
bash "$ICI/fumee.sh"
