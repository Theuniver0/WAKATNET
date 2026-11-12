#!/bin/bash
# WAKATNET — démarrage du PostgreSQL du nœud B de TEST : réplique par flux du nœud A (T13).
# ADR 0015 §1 ; ticket .scratch/phase-5-haute-disponibilite/issues/02-t13-replique.md.
# Premier démarrage : copie de base par pg_basebackup, avec le slot noeud_b, et -R (fichier
# standby.signal et primary_conninfo). En production, le mot de passe est dans ~postgres/.pgpass
# (Ansible) ; ici, il vient de l'environnement jetable du test, jamais d'une ligne de commande.
set -euo pipefail
PRIMAIRE="${WAKATNET_PRIMAIRE:?WAKATNET_PRIMAIRE manquant}"
export PGPASSWORD="${WAKATNET_PG_REPLICATION_PASSWORD:?WAKATNET_PG_REPLICATION_PASSWORD manquant}"
export PGDATA="${PGDATA:-/var/lib/postgresql/data}"
install -d -o postgres -g postgres -m 0700 "$PGDATA"
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  for _ in $(seq 1 120); do
    pg_isready -q -h "$PRIMAIRE" -U wk_replication -d postgres && break
    sleep 1
  done
  gosu postgres pg_basebackup -h "$PRIMAIRE" -U wk_replication -D "$PGDATA" -R -S noeud_b -X stream -c fast
  echo "réplique : copie de base faite depuis $PRIMAIRE"
fi
unset PGPASSWORD
exec gosu postgres postgres -c track_functions=all -c hot_standby=on -c wal_log_hints=on
