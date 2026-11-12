#!/bin/bash
# WAKATNET — promotion MANUELLE du nœud B en primaire (ADR 0015 §3 ; SPEC §10.2).
# Ticket : .scratch/phase-5-haute-disponibilite/issues/03-promotion.md ; procédure : docs/RUNBOOK.md.
#
# À lancer sur B, par l'exploitant, APRÈS avoir arrêté A (console de l'hébergeur). Deux primaires
# en même temps (« split-brain ») feraient diverger deux grands livres : c'est le pire cas, pire
# que quelques minutes de mode dégradé. Gardes :
#   1. B doit être une réplique (sinon : déjà primaire, rien à faire, sortie 0) ;
#   2. refus si le PostgreSQL de A RÉPOND sur wk-noeuds (A n'est pas mort) ;
#   3. confirmation tapée « PROMOUVOIR » et raison écrite, inscrites au journal du nœud ;
#   4. pg_promote(), attente de la fin de la récupération, puis test de fumée.
# Le script ne PEUT PAS prouver que A est arrêté si le lien entre nœuds est coupé : c'est la
# raison de l'étape manuelle d'arrêt de A, que la confirmation rappelle.
#
# Usage : promouvoir-b.sh --raison "texte"        (confirmation lue sur l'entrée standard)
# Variables : WAKATNET_PG_PAIR (défaut 10.213.255.1, adresse de A sur wk-noeuds),
#             PGUSER / PGHOST locaux (défaut : postgres, socket locale),
#             WAKATNET_JOURNAL_NOEUD (défaut /var/log/wakatnet/noeud.log).
set -euo pipefail
PAIR="${WAKATNET_PG_PAIR:-10.213.255.1}"
JOURNAL="${WAKATNET_JOURNAL_NOEUD:-/var/log/wakatnet/noeud.log}"
ICI="$(cd "$(dirname "$0")" && pwd)"
FUMEE="${WAKATNET_FUMEE:-$ICI/../sql/fumee.sh}"
export PGUSER="${PGUSER:-postgres}" PGDATABASE="${PGDATABASE:-wakatnet}"
PSQL=(psql -X -q -tA -v ON_ERROR_STOP=1)

raison=""
while [ $# -gt 0 ]; do
  case "$1" in
    --raison) raison="${2:-}"; shift 2 ;;
    *) echo "usage : $0 --raison \"texte\"" >&2; exit 2 ;;
  esac
done
[ -n "$raison" ] || { echo "promotion refusée : --raison obligatoire" >&2; exit 2; }

journal() {
  mkdir -p "$(dirname "$JOURNAL")"
  printf '%s promotion %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$JOURNAL"
  if command -v logger >/dev/null; then logger -t wakatnet-promotion -- "$*" || true; fi
}

if [ "$("${PSQL[@]}" -c 'SELECT pg_is_in_recovery()')" != t ]; then
  echo "ce nœud est déjà primaire : rien à faire"
  exit 0
fi

# pg_isready : 0 = accepte, 1 = refuse (démarrage), 2 = aucune réponse, 3 = paramètres invalides.
set +e
pg_isready -q -h "$PAIR" -p 5432 -t 3
etat_pair=$?
set -e
if [ "$etat_pair" = 0 ] || [ "$etat_pair" = 1 ]; then
  echo "PROMOTION REFUSÉE : le PostgreSQL de A répond sur $PAIR (code pg_isready $etat_pair)." >&2
  echo "Arrêtez A (console de l'hébergeur) avant de promouvoir B : deux primaires feraient diverger le grand livre." >&2
  journal "refusée : A répond sur $PAIR ; raison=« $raison »"
  exit 1
fi

echo "A ne répond pas sur $PAIR. Avez-vous ARRÊTÉ A (console de l'hébergeur), et pas seulement constaté qu'il ne répond pas ?"
echo "Tapez PROMOUVOIR pour continuer :"
read -r reponse || reponse=""
if [ "$reponse" != PROMOUVOIR ]; then
  echo "promotion abandonnée" >&2
  journal "abandonnée par l'exploitant ; raison=« $raison »"
  exit 1
fi

debut="$(date +%s.%N)"
journal "lancée ; raison=« $raison »"
"${PSQL[@]}" -c "SELECT pg_promote(true, 60)" >/dev/null
for _ in $(seq 1 60); do
  [ "$("${PSQL[@]}" -c 'SELECT pg_is_in_recovery()')" = f ] && break
  sleep 1
done
[ "$("${PSQL[@]}" -c 'SELECT pg_is_in_recovery()')" = f ] || { journal "échec : toujours en récupération"; echo "ÉCHEC : B est toujours en récupération" >&2; exit 1; }
bash "$FUMEE"
fin="$(date +%s.%N)"
duree="$(awk -v a="$debut" -v b="$fin" 'BEGIN { printf "%.1f", b - a }')"
journal "réussie en ${duree} s ; raison=« $raison »"
echo "B est PRIMAIRE (promotion et fumée en ${duree} s)."
echo "Suite (docs/RUNBOOK.md) : démarrer l'API, le portail et les tâches sur B, puis basculer le DNS ; A ne redémarre"
echo "qu'en réplique, par rejoindre-en-replique.sh."
