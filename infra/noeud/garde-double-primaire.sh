#!/bin/bash
# WAKATNET — garde au démarrage de PostgreSQL : jamais deux primaires (revue de sécurité E1 ; ADR 0015 §3).
# Installé en /usr/local/sbin/wakatnet-garde-double-primaire ; appelé par ExecStartPre= de l'unité
# PostgreSQL (drop-in déployé par Ansible) et par le rôle Ansible avant de démarrer un primaire.
#
# Scénario couvert : B a été promu pendant que A était injoignable ; l'hébergeur redémarre A, dont
# l'unité est restée activée. Sans cette garde, A repartirait en PRIMAIRE avec ses données d'avant la
# panne : deux grands livres divergeraient, et les routeurs reviendraient sur A.
#   - ce nœud a un standby.signal : il démarre en réplique, aucun risque, sortie 0 ;
#   - sinon il démarrerait en primaire : il demande à l'autre nœud, par wk-noeuds (rôle wk_rewind,
#     /var/lib/postgresql/.pgpass), s'il est primaire. Oui ⇒ REFUS (sortie 1, PostgreSQL ne démarre pas).
#   - l'autre nœud RÉPOND mais son état ne peut pas être lu (mot de passe, droits) ⇒ REFUS aussi : on ne
#     démarre pas un primaire à l'aveugle (constaté au banc Ansible : sans fichier de mots de passe lisible,
#     la garde laissait passer) ;
#   - l'autre nœud est INJOIGNABLE ⇒ démarrage permis. C'est un choix de disponibilité, assumé : la garde
#     ne peut rien prouver si le lien entre nœuds est coupé (ADR 0015 §3). D'où l'étape manuelle du
#     RUNBOOK §3 : faire couper le réseau de A par l'hébergeur quand A est injoignable.
# L'unité PostgreSQL de Debian n'a pas de User= (pg_ctlcluster abandonne ses droits lui-même) : la garde
# peut tourner en root, d'où le fichier de mots de passe désigné explicitement.
# Variables : PGDATA (obligatoire), WAKATNET_PG_PAIR (adresse de l'autre nœud sur wk-noeuds),
#             PGPASSFILE (défaut /var/lib/postgresql/.pgpass).
set -uo pipefail
PGDATA="${PGDATA:?PGDATA manquant}"
PAIR="${WAKATNET_PG_PAIR:?WAKATNET_PG_PAIR manquant}"
if [ -f "$PGDATA/standby.signal" ]; then
  exit 0
fi
export PGPASSFILE="${PGPASSFILE:-/var/lib/postgresql/.pgpass}"
refuser() {
  echo "$1" >&2
  if command -v logger >/dev/null; then logger -t wakatnet-garde -- "$1" || true; fi
  exit 1
}
# pg_isready : 0 = accepte, 1 = refuse (démarrage), 2 = aucune réponse, 3 = paramètres invalides.
pg_isready -q -h "$PAIR" -p 5432 -t 3
joignable=$?
[ "$joignable" = 2 ] && exit 0                  # pair injoignable : démarrage permis (choix assumé)
etat="$(PGCONNECT_TIMEOUT=3 psql -X -q -tA -h "$PAIR" -U wk_rewind -d wakatnet -c 'SELECT pg_is_in_recovery()' 2>/dev/null)"
case "$etat" in
  t) exit 0 ;;
  f) refuser "REFUS : l'autre nœud ($PAIR) est PRIMAIRE ; ce nœud ne démarre pas en primaire (deux grands livres divergeraient). Le faire revenir en réplique : rejoindre-en-replique.sh (RUNBOOK §4)." ;;
  *) refuser "REFUS : l'autre nœud ($PAIR) répond (pg_isready $joignable) mais son état est illisible (mot de passe de wk_rewind dans $PGPASSFILE ?). Démarrage en primaire refusé : vérifier à la main, RUNBOOK §3." ;;
esac
