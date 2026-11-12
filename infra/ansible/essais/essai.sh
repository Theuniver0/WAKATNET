#!/bin/bash
# WAKATNET — essai RÉEL des rôles Ansible sur deux nœuds jetables (phase 5, ticket 06 ; ADR 0015 §7).
#   WAKATNET_ANSIBLE_BIN=/chemin/vers/venv/bin infra/ansible/essais/essai.sh
# Exige Docker et ansible (paquet « ansible » 14, pour le connecteur community.docker de l'ESSAI
# seulement : site.yml n'utilise que ansible.builtin). Deux conteneurs Ubuntu 24.04 avec systemd :
#   1. A primaire (socle, postgresql, pgbackrest) ;
#   2. B déclaré réplique sur une installation neuve, SANS demande explicite : refusé (clôture) ;
#   3. B avec postgresql_reconstruire_replique=true : réplique en flux sur le slot noeud_b ;
#   4. second passage sur A et B : aucun changement (idempotence) ;
#   5. A redéclaré réplique : refusé, A reste primaire et en marche ;
#   6. FreeRADIUS sans le dépôt de l'éditeur : la 3.2.5 d'Ubuntu est refusée par la garde de version.
# Les « secrets » de l'essai (mot de passe de réplication, phrase de pgBackRest) sont aléatoires,
# posés comme Yacouba les posera à la main, et jamais affichés.
set -euo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
ANSIBLE="$(cd "$ICI/.." && pwd)"
DEPOT="$(cd "$ANSIBLE/../.." && pwd)"
BIN="${WAKATNET_ANSIBLE_BIN:-$(dirname "$(command -v ansible-playbook)")}"
RESEAU="wakatnet-ansible-$$"
A="wakatnet-noeud-a-$$" B="wakatnet-noeud-b-$$"
TMP="$(mktemp -d)"
nettoyer() { docker rm -f "$A" "$B" >/dev/null 2>&1 || true; docker network rm "$RESEAU" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap nettoyer EXIT
etape() { printf '\n=== %s ===\n' "$*"; }
echec() { echo "ÉCHEC : $*" >&2; exit 1; }

etape "Image des nœuds d'essai (Ubuntu 24.04, systemd, paquets préinstallés)"
CA=()
[ -s /root/.ccr/ca-bundle.crt ] && CA=("--secret" "id=ca,src=/root/.ccr/ca-bundle.crt")
docker build -q --network host "${CA[@]}" -f "$ICI/Dockerfile.noeud" -t wakatnet-noeud-essai:local --build-arg https_proxy "$ICI" >/dev/null

etape "Deux nœuds sur un réseau privé"
docker network create --subnet 172.30.77.0/24 "$RESEAU" >/dev/null
for n in "$A:172.30.77.2" "$B:172.30.77.3"; do
  docker run -d --name "${n%%:*}" --network "$RESEAU" --ip "${n##*:}" --privileged --cgroupns=host \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock wakatnet-noeud-essai:local >/dev/null
done
for c in "$A" "$B"; do
  for _ in $(seq 1 60); do
    etat="$(docker exec "$c" systemctl is-system-running 2>/dev/null || true)"
    case "$etat" in running|degraded) break ;; esac
    sleep 1
  done
  echo "$c : systemd $etat"
done

cat > "$TMP/inventaire.yml" <<EOF
all:
  vars:
    ansible_connection: community.docker.docker
    wakatnet_depot: "$DEPOT"
  children:
    noeuds:
      hosts:
        noeud_a: { ansible_host: "$A", wakatnet_noeud: A, wakatnet_role: primaire, wk_noeuds_ip: 172.30.77.2,
                   wk_noeuds_pair_ip: 172.30.77.3, wk_noeuds_pair_ip_publique: 172.30.77.3, wg0_ip: 10.213.0.1,
                   wk_noeuds_pair_cle_publique: "inutilisee" }
        noeud_b: { ansible_host: "$B", wakatnet_noeud: B, wakatnet_role: replique, wk_noeuds_ip: 172.30.77.3,
                   wk_noeuds_pair_ip: 172.30.77.2, wk_noeuds_pair_ip_publique: 172.30.77.2, wg0_ip: 10.213.0.2,
                   wk_noeuds_pair_cle_publique: "inutilisee" }
EOF
mkdir -p "$TMP/group_vars" && cp "$ANSIBLE/group_vars/noeuds.yml" "$TMP/group_vars/noeuds.yml"
# Ubuntu 24.04 livre PostgreSQL 16 : pas de dépôt PGDG pour l'essai.
JOUER=("$BIN/ansible-playbook" -i "$TMP/inventaire.yml" -e "wakatnet_depot=$DEPOT" -e postgresql_depot_pgdg=false)
export ANSIBLE_CONFIG="$ANSIBLE/ansible.cfg" ANSIBLE_ROLES_PATH="$ANSIBLE/roles"

etape "Secrets posés à la main (simulés, jamais affichés)"
MDP="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
for c in "$A" "$B"; do
  docker exec -i "$c" bash -c 'install -d -o postgres -g postgres -m 0750 /etc/pgbackrest/conf.d && umask 077 &&
    printf "[global]\nrepo1-cipher-pass=%s\n" "$(head -c 24 /dev/urandom | base64)" > /etc/pgbackrest/conf.d/secret.conf &&
    chown postgres:postgres /etc/pgbackrest/conf.d/secret.conf'
done

etape "1. A primaire"
"${JOUER[@]}" "$ANSIBLE/essais/essai.yml" --limit noeud_a > "$TMP/a1.log" 2>&1 || { tail -30 "$TMP/a1.log"; echec "A"; }
grep -A3 "PLAY RECAP" "$TMP/a1.log" | grep noeud_a
# Le rôle de réplication et son mot de passe : posés par migrer.sh (migration 0028) en production.
docker exec -i -u postgres "$A" psql -X -q -v ON_ERROR_STOP=1 -v mdp="$MDP" <<'SQL'
CREATE ROLE wk_replication LOGIN REPLICATION PASSWORD :'mdp';
SQL
docker exec -i "$B" bash -c "umask 077 && echo '172.30.77.2:5432:*:wk_replication:$MDP' > /var/lib/postgresql/.pgpass && chown postgres:postgres /var/lib/postgresql/.pgpass"

etape "2. B déclaré réplique, installation neuve, sans demande explicite : refusé"
if "${JOUER[@]}" "$ANSIBLE/essais/essai.yml" --limit noeud_b > "$TMP/b0.log" 2>&1; then echec "B transformé sans demande explicite"; fi
grep -q "est déclaré réplique mais n'en est pas une" "$TMP/b0.log" || { tail -20 "$TMP/b0.log"; echec "refus attendu"; }
echo "refusé (attendu) : la reconstruction d'une réplique exige postgresql_reconstruire_replique=true"

etape "3. B reconstruit en réplique (demande explicite)"
"${JOUER[@]}" "$ANSIBLE/essais/essai.yml" --limit noeud_b -e postgresql_reconstruire_replique=true > "$TMP/b1.log" 2>&1 \
  || { tail -30 "$TMP/b1.log"; echec "B"; }
grep -A3 "PLAY RECAP" "$TMP/b1.log" | grep noeud_b
for _ in $(seq 1 30); do
  flux="$(docker exec -u postgres "$A" psql -X -tA -c "SELECT r.state || ' ' || s.slot_name FROM pg_stat_replication r JOIN pg_replication_slots s ON s.active_pid = r.pid" || true)"
  [ "$flux" = "streaming noeud_b" ] && break
  sleep 1
done
[ "$flux" = "streaming noeud_b" ] || echec "réplication attendue en flux sur noeud_b : « $flux »"
[ "$(docker exec -u postgres "$B" psql -X -tA -c 'SELECT pg_is_in_recovery()')" = t ] || echec "B n'est pas en récupération"
echo "A → B : réplication en flux sur le slot noeud_b ; B en lecture seule"

etape "4. Second passage sur A et B : aucun changement"
"${JOUER[@]}" "$ANSIBLE/essais/essai.yml" > "$TMP/ab2.log" 2>&1 || { tail -30 "$TMP/ab2.log"; echec "second passage"; }
grep -A4 "PLAY RECAP" "$TMP/ab2.log" | grep -E "noeud_[ab]"
[ "$(grep -A4 "PLAY RECAP" "$TMP/ab2.log" | grep -cE "noeud_[ab] .*changed=0 ")" = 2 ] || echec "le second passage change quelque chose"
echo "idempotent : changed=0 sur les deux nœuds"

etape "5. A redéclaré réplique : refusé, A reste primaire"
if "${JOUER[@]}" "$ANSIBLE/essais/essai.yml" --limit noeud_a -e wakatnet_role=replique > "$TMP/a2.log" 2>&1; then echec "A transformé en réplique"; fi
grep -q "est déclaré réplique mais n'en est pas une" "$TMP/a2.log" || echec "refus attendu pour A"
[ "$(docker exec -u postgres "$A" psql -X -tA -c 'SELECT pg_is_in_recovery()')" = f ] || echec "A n'est plus primaire"
echo "refusé (attendu) ; A toujours primaire, en marche"

etape "6. FreeRADIUS sans le dépôt de l'éditeur : version refusée"
if "${JOUER[@]}" "$ANSIBLE/essais/freeradius.yml" > "$TMP/fr.log" 2>&1; then echec "FreeRADIUS de la distribution accepté"; fi
grep -oE "FreeRADIUS [0-9.]+ refusé[^\"]*" "$TMP/fr.log" | head -1
grep -q "FreeRADIUS 3.2.5 refusé" "$TMP/fr.log" || { tail -20 "$TMP/fr.log"; echec "refus de version attendu"; }
etape "SUCCÈS"
