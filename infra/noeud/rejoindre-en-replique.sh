#!/bin/bash
# WAKATNET — retour de l'ancien primaire (A) en RÉPLIQUE du nouveau primaire (B) (ADR 0015 §3).
# Ticket : .scratch/phase-5-haute-disponibilite/issues/03-promotion.md ; procédure : docs/RUNBOOK.md.
#
# A ne redémarre JAMAIS en primaire après une promotion de B : son unité PostgreSQL reste désactivée
# tant que ce script n'a pas réussi (clôture par la procédure). À lancer sur A, PostgreSQL ARRÊTÉ.
#   1. refus si le PostgreSQL local tourne, ou si B n'est pas primaire ;
#   2. slot `noeud_a` créé sur B (protocole de réplication, rôle wk_replication) ;
#   3. pg_rewind depuis B (rôle wk_rewind, droits minimaux), avec standby.signal et primary_conninfo ;
#      en cas d'échec, l'ancien répertoire est MIS DE CÔTÉ (jamais effacé) et A est reconstruit par
#      pg_basebackup ;
# Le démarrage de PostgreSQL en réplique est laissé à l'appelant (systemd, ou la pile de test).
#
# Variables : PGDATA (obligatoire), WAKATNET_PG_PAIR (défaut 10.213.255.2, adresse de B sur wk-noeuds),
#   mots de passe dans ~/.pgpass (production) ou PGPASSFILE (test) : jamais en argument.
set -euo pipefail
PGDATA="${PGDATA:?PGDATA manquant}"
PAIR="${WAKATNET_PG_PAIR:-10.213.255.2}"
SLOT="${WAKATNET_SLOT:-noeud_a}"
JOURNAL="${WAKATNET_JOURNAL_NOEUD:-/var/log/wakatnet/noeud.log}"

journal() {
  mkdir -p "$(dirname "$JOURNAL")"
  printf '%s retour-en-replique %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$JOURNAL"
  if command -v logger >/dev/null; then logger -t wakatnet-retour -- "$*" || true; fi
}

if pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
  echo "REFUS : PostgreSQL tourne sur ce nœud ; arrêtez-le d'abord (systemctl stop postgresql)." >&2
  exit 1
fi
primaire_b="$(psql -X -q -tA -h "$PAIR" -U wk_rewind -d wakatnet -c 'SELECT NOT pg_is_in_recovery()')"
[ "$primaire_b" = t ] || { echo "REFUS : B ($PAIR) n'est pas primaire." >&2; exit 1; }

debut="$(date +%s.%N)"
journal "lancé vers $PAIR"
# Slot sur B : idempotent (un slot déjà présent est réutilisé).
if ! psql -X -q -tA -h "$PAIR" -U wk_rewind -d wakatnet \
      -c "SELECT 1 FROM pg_replication_slots WHERE slot_name = '$SLOT'" | grep -q 1; then
  pg_receivewal -h "$PAIR" -U wk_replication -S "$SLOT" --create-slot --if-not-exists
fi
conninfo_rep="host=$PAIR user=wk_replication application_name=$(hostname -s 2>/dev/null || echo noeud)"
# Fichier de mots de passe explicite (test) : le processus de réception des WAL ne lit pas PGPASSFILE.
[ -n "${PGPASSFILE:-}" ] && conninfo_rep="$conninfo_rep passfile=$PGPASSFILE"

methode=rewind
if ! pg_rewind -D "$PGDATA" --source-server="host=$PAIR user=wk_rewind dbname=wakatnet" -R --progress; then
  methode=basebackup
  cote="${PGDATA%/}.avant-$(date -u +%Y%m%dT%H%M%SZ)"
  journal "pg_rewind en échec : ancien répertoire mis de côté dans $cote"
  echo "pg_rewind en échec : reconstruction par pg_basebackup (ancien répertoire : $cote)" >&2
  mv "$PGDATA" "$cote"
  install -d -m 0700 "$PGDATA"
  pg_basebackup -h "$PAIR" -U wk_replication -D "$PGDATA" -R -S "$SLOT" -X stream -c fast
fi
# primary_conninfo écrit par -R vise wk_rewind (pg_rewind) : on le remplace par le rôle de réplication
# et le slot, dans postgresql.auto.conf (dernière valeur lue gagne).
{
  echo "primary_conninfo = '$conninfo_rep'"
  echo "primary_slot_name = '$SLOT'"
} >> "$PGDATA/postgresql.auto.conf"
touch "$PGDATA/standby.signal"
fin="$(date +%s.%N)"
duree="$(awk -v a="$debut" -v b="$fin" 'BEGIN { printf "%.1f", b - a }')"
journal "réussi par $methode en ${duree} s"
echo "A est prêt à redémarrer en RÉPLIQUE de B ($methode, ${duree} s). Démarrez PostgreSQL, puis vérifiez pg_is_in_recovery()."
