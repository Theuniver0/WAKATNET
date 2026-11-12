#!/bin/bash
# WAKATNET — essai de restauration automatisé (ADR 0015 §5 ; SPEC §10.1 : « test de restauration
# automatisé chaque mois »). Ticket : .scratch/phase-5-haute-disponibilite/issues/04-sauvegardes.md
#
# En tant que postgres, sur un nœud (la base vivante est la base locale, primaire ou réplique) :
#   1. restaure la DERNIÈRE sauvegarde dans un répertoire temporaire (cohérente à sa fin : --type=immediate) ;
#   2. la démarre sur une socket privée, SANS archivage (aucun WAL de l'essai ne part dans le dépôt) ;
#   3. contrôle :
#      a. empreintes des migrations : chacune de la sauvegarde existe à l'identique dans la base vivante ;
#      b. équilibre du grand livre restauré (chaque transaction équilibrée, au moins deux lignes) ;
#      c. grand livre restauré ⊆ grand livre vivant, ligne pour ligne (empreinte de chaque ligne) : une
#         ligne disparue ou modifiée depuis la sauvegarde trahit une atteinte à l'ajout seul (ADR 0013, M7) ;
#      d. comptes des tables principales (rapportés, non comparés : purges et expirations les font varier) ;
#   4. mesure la durée de la restauration, écrit le résultat (JSON), arrête et EFFACE l'instance d'essai.
# Code de sortie 1 au moindre écart : l'unité systemd échoue et la supervision le voit.
set -euo pipefail
STANZA="${WAKATNET_STANZA:-wakatnet}"
RACINE="${WAKATNET_ESSAI_RACINE:-/var/lib/wakatnet/essai-restauration}"
RESULTAT="${WAKATNET_ESSAI_RESULTAT:-/var/lib/wakatnet/essai-restauration.json}"
PORT="${WAKATNET_ESSAI_PORT:-5499}"
PGBIN="${WAKATNET_PGBIN:-/usr/lib/postgresql/16/bin}"
VIVANTE=(psql -X -q -tA -v ON_ERROR_STOP=1 -d "${WAKATNET_BASE:-wakatnet}")

# Sur le primaire seulement, comme la sauvegarde (une réplique doublerait charge et disque).
if [ "$("${VIVANTE[@]}" -c 'SELECT pg_is_in_recovery()')" = t ]; then
  echo "essai de restauration : réplique, rien à faire sur ce nœud"
  exit 0
fi
install -d -m 0700 "$RACINE"
# Une copie laissée par un essai interrompu (SIGKILL à l'expiration du délai : le piège EXIT ne s'exécute
# pas) est une base EN CLAIR sur disque : effacée avant tout (revue de sécurité F7).
rm -rf "$RACINE"/donnees.*
DONNEES="$(mktemp -d "$RACINE/donnees.XXXXXX")"
ESSAI=(psql -X -q -tA -v ON_ERROR_STOP=1 -h "$DONNEES" -p "$PORT" -d "${WAKATNET_BASE:-wakatnet}")
nettoyer() {
  "$PGBIN/pg_ctl" -D "$DONNEES" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DONNEES"
}
trap nettoyer EXIT

debut="$(date +%s.%N)"
pgbackrest --stanza="$STANZA" --pg1-path="$DONNEES" --type=immediate --target-action=promote \
  --archive-mode=off restore >/dev/null
etiquette="$(pgbackrest --stanza="$STANZA" info --output=json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["backup"][-1]["label"])')"
# Socket privée dans le répertoire d'essai, aucune écoute réseau, aucun archivage, aucune réplication.
# (max_wal_senders et wal_level restent ceux du primaire : la récupération refuse des valeurs plus basses.)
"$PGBIN/pg_ctl" -D "$DONNEES" -w -t 600 -l "$DONNEES/essai.log" \
  -o "-p $PORT -c listen_addresses='' -c unix_socket_directories='$DONNEES' -c archive_mode=off -c primary_conninfo=''" start >/dev/null \
  || { echo "ÉCHEC : l'instance restaurée ne démarre pas ; fin de son journal :" >&2; tail -20 "$DONNEES/essai.log" >&2; exit 1; }
for _ in $(seq 1 600); do
  [ "$("${ESSAI[@]}" -c 'SELECT pg_is_in_recovery()' 2>/dev/null || true)" = f ] && break
  sleep 1
done
[ "$("${ESSAI[@]}" -c 'SELECT pg_is_in_recovery()')" = f ] || { echo "ÉCHEC : l'instance restaurée ne sort pas de la récupération" >&2; exit 1; }
fin="$(date +%s.%N)"
duree="$(awk -v a="$debut" -v b="$fin" 'BEGIN { printf "%.1f", b - a }')"

ecarts=()
# a. migrations
manquantes="$(comm -23 <("${ESSAI[@]}" -c "SELECT fichier || ' ' || sha256 FROM public.schema_migrations ORDER BY 1" | LC_ALL=C sort) \
                       <("${VIVANTE[@]}" -c "SELECT fichier || ' ' || sha256 FROM public.schema_migrations ORDER BY 1" | LC_ALL=C sort) | wc -l)"
[ "$manquantes" = 0 ] || ecarts+=("migrations : $manquantes absente(s) ou modifiée(s) dans la base vivante")
# b. équilibre du grand livre restauré
desequilibres="$("${ESSAI[@]}" -c "SELECT count(*) FROM (SELECT transaction_id FROM ledger.ecriture GROUP BY 1
                                     HAVING sum(debit) <> sum(credit) OR count(*) < 2) x")"
[ "$desequilibres" = 0 ] || ecarts+=("grand livre restauré : $desequilibres transaction(s) déséquilibrée(s)")
# c. grand livre restauré ⊆ grand livre vivant (empreinte de chaque ligne ; identifiants seuls dans le rapport)
# shellcheck disable=SC2016  # $$…$$ : chaînes SQL, aucune expansion voulue
empreintes='SELECT $$compte:$$ || id || $$ $$ || md5(c::text) FROM ledger.compte c
            UNION ALL SELECT $$transaction:$$ || id || $$ $$ || md5(t::text) FROM ledger.transaction t
            UNION ALL SELECT $$ecriture:$$ || id || $$ $$ || md5(e::text) FROM ledger.ecriture e'
differences="$(comm -23 <("${ESSAI[@]}" -c "$empreintes" | LC_ALL=C sort) <("${VIVANTE[@]}" -c "$empreintes" | LC_ALL=C sort) \
               | cut -d' ' -f1 | head -20 | paste -sd, -)"
lignes_ledger="$("${ESSAI[@]}" -c "SELECT (SELECT count(*) FROM ledger.transaction) || ' transactions, ' || (SELECT count(*) FROM ledger.ecriture) || ' écritures'")"
[ -z "$differences" ] || ecarts+=("grand livre : ligne(s) de la sauvegarde absente(s) ou modifiée(s) dans la base vivante : $differences")
# d. comptes rapportés
comptes="$("${ESSAI[@]}" -c "SELECT json_build_object('proprietaires', (SELECT count(*) FROM app.tenant), 'tickets', (SELECT count(*) FROM app.voucher),
           'paiements', (SELECT count(*) FROM app.payment), 'sessions', (SELECT count(*) FROM radius.session))")"

ok=true
[ "${#ecarts[@]}" = 0 ] || ok=false
details="$(printf '%s\n' "${ecarts[@]:-}" | python3 -c 'import json,sys; print(json.dumps([l for l in sys.stdin.read().splitlines() if l]))')"
install -d "$(dirname "$RESULTAT")"
tmp="$(mktemp "$(dirname "$RESULTAT")/.essai.XXXXXX")"
printf '{"fin":"%s","ok":%s,"etiquette":"%s","duree_restauration_s":%s,"grand_livre":"%s","comptes":%s,"ecarts":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ok" "$etiquette" "$duree" "$lignes_ledger" "$comptes" "$details" > "$tmp"
chmod 0644 "$tmp"
mv "$tmp" "$RESULTAT"
echo "essai de restauration : sauvegarde $etiquette restaurée en ${duree} s ; grand livre : $lignes_ledger"
if [ "$ok" = true ]; then
  echo "essai de restauration : RÉUSSI"
else
  printf 'ÉCART : %s\n' "${ecarts[@]}" >&2
  exit 1
fi
