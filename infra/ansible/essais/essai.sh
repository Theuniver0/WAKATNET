#!/bin/bash
# WAKATNET — essai RÉEL des rôles Ansible sur deux nœuds jetables (phase 5, ticket 06 ; ADR 0015 §7).
#   WAKATNET_ANSIBLE_BIN=/chemin/vers/venv/bin [WAKATNET_ESSAI_OS=debian13] infra/ansible/essais/essai.sh
# Exige Docker et ansible (paquet « ansible » 14, pour le connecteur community.docker de l'ESSAI
# seulement : site.yml n'utilise que ansible.builtin). Deux conteneurs avec systemd :
#   - WAKATNET_ESSAI_OS=ubuntu2404 (défaut) : paquets de la distribution, seuils de version abaissés au banc ;
#   - WAKATNET_ESSAI_OS=debian13 : la cible de production (ADR 0004), PostgreSQL 16 et pgBackRest du dépôt PGDG
#     déclaré par le rôle, seuils de PRODUCTION. Clé PGDG prise dans le paquet Debian postgresql-common, empreinte
#     contrôlée (Dockerfile.noeud-debian13). Exige deb.debian.org et apt.postgresql.org à la construction.
#   1. A primaire (socle, postgresql, pgbackrest) ;
#   2. B déclaré réplique sur une installation neuve, SANS demande explicite : refusé (clôture) ;
#   3. B avec postgresql_reconstruire_replique=true : réplique en flux sur le slot noeud_b ;
#   4. second passage sur A et B : aucun changement (idempotence) ;
#   5. A redéclaré réplique : refusé, A reste primaire et en marche ;
#   6. FreeRADIUS sans le dépôt de l'éditeur : la version de la distribution (Ubuntu 24.04 : 3.2.5 ; Debian 13 :
#      3.2.7) est refusée par la garde de version ;
#   7. B promu, puis PostgreSQL de A redémarré par systemd (redémarrage par l'hébergeur) : la garde contre le
#      double primaire l'en empêche ; Ansible refuse aussi de déclarer A primaire (revue de sécurité E1) ;
#   8. nginx devant une fausse API (ADR 0016 §2) : filtrage par Host (444 sur un nom inconnu, même avec un SNI
#      connu), limite → 429 (connexion et /etat), X-Forwarded-For et X-Forwarded-Host non usurpables ;
#   9. pare-feu public (ADR 0016 §3) : 443 ouvert, PostgreSQL fermé depuis l'autre nœud, retour arrière annulé ;
#      second passage sans changement ; table retirée de la mémoire : rechargée au passage suivant ;
#  10. retour arrière du pare-feu DÉCLENCHÉ (table fautive, jamais validée) : mémoire et disque rétablis.
# A sert un certificat fourni (frontal_tls=fourni), B un certificat auto-signé (frontal_tls=autosigne, réplique).
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
nettoyer() { [ "${GARDER:-0}" = 1 ] && return; docker rm -f "$A" "$B" >/dev/null 2>&1 || true; docker network rm "$RESEAU" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap nettoyer EXIT
etape() { printf '\n=== %s ===\n' "$*"; }
echec() { echo "ÉCHEC : $*" >&2; exit 1; }

OS="${WAKATNET_ESSAI_OS:-ubuntu2404}"
case "$OS" in
  ubuntu2404) FICHIER="$ICI/Dockerfile.noeud" FREERADIUS_DISTRIB=3.2.5
              # Ubuntu 24.04 livre PostgreSQL 16 : pas de dépôt PGDG ; pgBackRest 2.50 : contrôle de version joué au
              # seuil du banc. En production : 2.59.2 (ADR 0018). Le dépôt S3 verrouillé a son banc : sauvegarde-s3.sh.
              VARIANTE=(-e postgresql_depot_pgdg=false -e pgbackrest_version_min=2.50) ;;
  debian13)   FICHIER="$ICI/Dockerfile.noeud-debian13" FREERADIUS_DISTRIB=3.2.7
              # Production telle quelle : dépôt PGDG déclaré par le rôle, seuil pgBackRest d'ADR 0018. La clé passée au
              # rôle est celle de l'image (vérifiée à la construction), ressortie après le build.
              VARIANTE=(-e postgresql_pgdg_cle_locale="$TMP/pgdg.asc") ;;
  *) echo "WAKATNET_ESSAI_OS inconnu : $OS (ubuntu2404 ou debian13)" >&2; exit 2 ;;
esac
IMAGE="wakatnet-noeud-essai-$OS:local"

etape "Image des nœuds d'essai ($OS, systemd, paquets préinstallés)"
CA=()
[ -s /root/.ccr/ca-bundle.crt ] && CA=("--secret" "id=ca,src=/root/.ccr/ca-bundle.crt")
docker build -q --network host "${CA[@]}" -f "$FICHIER" -t "$IMAGE" --build-arg https_proxy "$ICI" >/dev/null
[ "$OS" = debian13 ] && docker run --rm --entrypoint cat "$IMAGE" /usr/share/keyrings/pgdg.asc > "$TMP/pgdg.asc"

etape "Deux nœuds sur un réseau privé"
docker network create --subnet 172.30.77.0/24 "$RESEAU" >/dev/null
for n in "$A:172.30.77.2" "$B:172.30.77.3"; do
  docker run -d --name "${n%%:*}" --network "$RESEAU" --ip "${n##*:}" --privileged --cgroupns=host \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock "$IMAGE" >/dev/null
done
# Les nœuds d'essai n'ont pas Internet : la liste des paquets vient de l'image. Plus vieille qu'une heure (image en
# cache), le module apt (cache_valid_time: 3600) voudrait la rafraîchir et échouerait. On la date de maintenant.
for c in "$A" "$B"; do docker exec "$c" touch /var/lib/apt/lists; done
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
                   wk_noeuds_pair_cle_publique: "inutilisee", frontal_tls: fourni,
                   frontal_certificat: /etc/wakatnet/tls/cert.pem, frontal_cle: /etc/wakatnet/tls/cle.pem }
        noeud_b: { ansible_host: "$B", wakatnet_noeud: B, wakatnet_role: replique, wk_noeuds_ip: 172.30.77.3,
                   wk_noeuds_pair_ip: 172.30.77.2, wk_noeuds_pair_ip_publique: 172.30.77.2, wg0_ip: 10.213.0.2,
                   wk_noeuds_pair_cle_publique: "inutilisee", frontal_tls: autosigne }
EOF
mkdir -p "$TMP/group_vars" && cp "$ANSIBLE/group_vars/noeuds.yml" "$TMP/group_vars/noeuds.yml"
JOUER=("$BIN/ansible-playbook" -i "$TMP/inventaire.yml" -e "wakatnet_depot=$DEPOT" "${VARIANTE[@]}"
        -e frontal_nom_api=api.essai -e frontal_nom_portail=portail.essai -e frontal_ipv6=false)
export ANSIBLE_CONFIG="$ANSIBLE/ansible.cfg" ANSIBLE_ROLES_PATH="$ANSIBLE/roles"

etape "Certificat TLS auto-signé de l'essai (frontal_tls=fourni)"
for c in "$A" "$B"; do
  docker exec "$c" bash -c 'install -d -m 0755 /etc/wakatnet/tls && openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=api.essai" \
    -addext "subjectAltName=DNS:api.essai,DNS:portail.essai" -keyout /etc/wakatnet/tls/cle.pem -out /etc/wakatnet/tls/cert.pem 2>/dev/null && chmod 0600 /etc/wakatnet/tls/cle.pem'
done

etape "Secrets posés à la main (simulés, jamais affichés)"
MDP="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
for c in "$A" "$B"; do
  # Comme en production (MISE_EN_PRODUCTION §1) : root:postgres, 0640 ; pgBackRest ne fait que lire.
  docker exec -i "$c" bash -c 'install -d -o root -g postgres -m 0750 /etc/pgbackrest /etc/pgbackrest/conf.d &&
    install -o root -g postgres -m 0640 /dev/null /etc/pgbackrest/conf.d/secret.conf &&
    printf "[global]\nrepo1-cipher-pass=%s\n" "$(head -c 24 /dev/urandom | base64)" > /etc/pgbackrest/conf.d/secret.conf'
done

etape "1. A primaire"
"${JOUER[@]}" "$ANSIBLE/essais/essai.yml" --limit noeud_a > "$TMP/a1.log" 2>&1 || { tail -30 "$TMP/a1.log"; echec "A"; }
grep -A3 "PLAY RECAP" "$TMP/a1.log" | grep noeud_a
# Base et rôles : en production, créés par le rôle noeud_wakatnet (createdb, migrer.sh, migration 0028).
docker exec -u postgres "$A" createdb wakatnet
docker exec -i -u postgres "$A" psql -X -q -v ON_ERROR_STOP=1 -v mdp="$MDP" <<'SQL'
CREATE ROLE wk_replication LOGIN REPLICATION PASSWORD :'mdp';
CREATE ROLE wk_rewind LOGIN PASSWORD :'mdp';
SQL
docker exec -i "$B" bash -c "umask 077 && printf '%s\n' '172.30.77.2:5432:*:wk_replication:$MDP' '172.30.77.2:5432:*:wk_rewind:$MDP' > /var/lib/postgresql/.pgpass && chown postgres:postgres /var/lib/postgresql/.pgpass"
docker exec -i "$A" bash -c "umask 077 && printf '%s\n' '172.30.77.3:5432:*:wk_rewind:$MDP' > /var/lib/postgresql/.pgpass && chown postgres:postgres /var/lib/postgresql/.pgpass"

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
grep -q "FreeRADIUS $FREERADIUS_DISTRIB refusé" "$TMP/fr.log" || { tail -20 "$TMP/fr.log"; echec "refus de version attendu"; }

etape "7. B promu, A redémarré par systemd : la garde refuse un second primaire"
docker exec -u postgres "$B" psql -X -q -tA -c "SELECT pg_promote(true, 60)" >/dev/null
[ "$(docker exec -u postgres "$B" psql -X -tA -c 'SELECT pg_is_in_recovery()')" = f ] || echec "B n'est pas promu"
if docker exec "$A" systemctl restart postgresql@16-main >/dev/null 2>&1; then echec "A a redémarré en primaire alors que B l'est"; fi
[ "$(docker exec "$A" systemctl is-active postgresql@16-main || true)" != active ] || echec "PostgreSQL de A actif"
docker exec "$A" journalctl -u postgresql@16-main --no-pager -n 30 | grep -q "REFUS : l'autre nœud" || echec "refus non journalisé"
echo "A refusé au démarrage : « l'autre nœud est PRIMAIRE » (journal de l'unité)"
if "${JOUER[@]}" "$ANSIBLE/essais/essai.yml" --limit noeud_a > "$TMP/a3.log" 2>&1; then echec "Ansible a redémarré A en primaire"; fi
grep -q "Primaire déclaré, mais l'autre nœud est-il déjà primaire" "$TMP/a3.log" || { tail -20 "$TMP/a3.log"; echec "refus d'Ansible attendu"; }
echo "Ansible refuse aussi de déclarer A primaire"

etape "8. nginx devant l'API : Host, limites, X-Forwarded-For"
# Fausse API : rend l'adresse vue et l'en-tête X-Forwarded-For reçus (comme l'API, derrière le seul proxy local).
docker exec -d "$A" python3 -c '
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def repondre(self):
        b = json.dumps({"xff": self.headers.get("X-Forwarded-For"), "xfh": self.headers.get("X-Forwarded-Host"),
                        "xri": self.headers.get("X-Real-IP"), "host": self.headers.get("Host"), "chemin": self.path}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    do_GET = do_POST = repondre
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("127.0.0.1", 3000), H).serve_forever()'
sleep 1
requete() { docker exec "$B" curl -sk -o /tmp/r.json -w "%{http_code}" --resolve "$1:443:172.30.77.2" "${@:2}"; }
[ "$(requete api.essai "https://api.essai/v1/moi")" = 200 ] || echec "api.essai/v1 doit atteindre l'API"
[ "$(requete portail.essai "https://portail.essai/v1/moi")" = 404 ] || echec "portail.essai/v1 doit être refusé (404)"
[ "$(requete api.essai "https://api.essai/p/ABCDEFGHIJKLMNOP")" = 404 ] || echec "api.essai/p doit être refusé (404)"
[ "$(requete portail.essai "https://portail.essai/p/ABCDEFGHIJKLMNOP")" = 200 ] || echec "portail.essai/p doit atteindre l'API"
if docker exec "$B" curl -sk --resolve autre.essai:443:172.30.77.2 https://autre.essai/ -o /dev/null; then echec "nom inconnu servi"; fi
rc=0; docker exec "$B" curl -sk --resolve api.essai:443:172.30.77.2 -H "Host: autre.essai" https://api.essai/v1/moi -o /dev/null || rc=$?
# Côté client, la fermeture sans réponse se lit curl 52 (Ubuntu 24.04) ou curl 56 (Debian 13 : OpenSSL 3.5 signale
# « unexpected eof » faute de close_notify) ; la preuve qui ne dépend pas du client est le 444 du journal de nginx.
case "$rc" in 52|56) ;; *) echec "SNI connu, Host inconnu : connexion fermée sans réponse attendue (444, curl 52 ou 56), obtenu curl $rc" ;; esac
sleep 1
docker exec "$A" grep -qE ' autre\.essai "GET /v1/moi HTTP/1\.1" 444 0 ' /var/log/nginx/access.log \
  || echec "SNI connu, Host inconnu : 444 absent du journal de nginx"
rc=0; docker exec "$B" curl -s -H "Host: autre.essai" http://172.30.77.2/ -o /dev/null || rc=$?
[ "$rc" = 52 ] || echec "port 80, Host inconnu : 444 attendu (curl 52), obtenu curl $rc"
docker exec "$B" curl -sk -D - -o /dev/null --resolve api.essai:443:172.30.77.2 https://api.essai/v1/moi | grep -qiE '^server: nginx/' \
  && echec "version de nginx divulguée (server_tokens)"
echo "Host : api et portail cloisonnés ; nom inconnu : poignée de main TLS refusée, ou 444 avec un SNI connu ; version tue"
# B (réplique, frontal_tls=autosigne) : 443 servi avec son certificat local, sans certbot ; pas d'API sur B (502).
docker exec "$B" grep -q "wakatnet-autosigne/cert.pem" /etc/nginx/sites-enabled/wakatnet.conf || echec "B ne sert pas le certificat auto-signé"
docker exec "$B" sh -c '! command -v certbot >/dev/null' || echec "certbot installé sur la réplique"
[ "$(docker exec "$A" curl -sk -o /dev/null -w '%{http_code}' --resolve api.essai:443:172.30.77.3 https://api.essai/v1/moi)" = 502 ] \
  || echec "B doit servir 443 (certificat auto-signé) devant une API arrêtée"
echo "B : 443 servi avec un certificat auto-signé local, certbot absent"
requete api.essai -H "X-Forwarded-For: 6.6.6.6" -H "X-Forwarded-Host: piege.essai" -H "X-Real-IP: 6.6.6.6" "https://api.essai/v1/moi" >/dev/null
docker exec "$B" grep -q '"xff": "172.30.77.3"' /tmp/r.json || { docker exec "$B" cat /tmp/r.json; echec "X-Forwarded-For usurpé"; }
docker exec "$B" grep -q '"xfh": "api.essai"' /tmp/r.json || { docker exec "$B" cat /tmp/r.json; echec "X-Forwarded-Host usurpé"; }
docker exec "$B" grep -q '"xri": null' /tmp/r.json || { docker exec "$B" cat /tmp/r.json; echec "X-Real-IP du client transmis"; }
echo "X-Forwarded-For : l'IP source réelle remplace l'en-tête reçu (6.6.6.6 ignoré) ; X-Forwarded-Host réécrit ; X-Real-IP retiré"
codes=""
for _ in $(seq 1 12); do codes="$codes $(requete api.essai -X POST "https://api.essai/v1/connexion")"; done
echo "12 connexions d'affilée :$codes"
grep -q 429 <<<"$codes" || echec "aucune limite sur /v1/connexion"
[ "$(awk '{print $1}' <<<"$codes")" = 200 ] || echec "la première connexion doit passer"
codes=""
for _ in $(seq 1 15); do codes="$codes $(requete portail.essai "https://portail.essai/p/ABCDEFGHIJKLMNOP/payer")"; done
grep -q 429 <<<"$codes" && echec "l'affichage du formulaire (GET) ne doit pas consommer le budget de paiement"
echo "GET /payer ×15 : jamais limité (budget de paiement réservé aux POST)"
# Budget de paiement par (site, source) : un site vidé ne bloque pas un autre site vendu depuis la même IP (M7).
# Une seule commande curl par rafale (connexion gardée ouverte) : les requêtes partent en bien moins d'une seconde.
rafale() { docker exec "$B" curl -sk --resolve portail.essai:443:172.30.77.2 -o /dev/null -w '%{http_code}\n' "$@" | sort | uniq -c | tr -s ' \n' ' '; }
codes="$(rafale -X POST "https://portail.essai/p/SITEAAAAAAAAAAAA/payer?[1-15]")"
echo "15 POST /payer sur un site :$codes"
grep -q " 429" <<<"$codes" || echec "aucune limite de paiement par site"
codes="$(rafale -X POST "https://portail.essai/p/SITEBBBBBBBBBBBB/payer?[1-3]")"
echo "puis 3 POST /payer sur un autre site, même source :$codes"
grep -q " 429" <<<"$codes" && echec "le budget de paiement d'un site ne doit pas bloquer un autre site"
# En dernier : vide le budget général de B (80 requêtes, au-delà de la rafale de 40).
codes="$(rafale "https://portail.essai/etat?[1-80]")"
echo "80 /etat d'affilée sur le portail :$codes"
grep -q " 429" <<<"$codes" || echec "aucune limite sur /etat du portail"
grep -q " 200" <<<"$codes" || echec "/etat du portail doit d'abord répondre"
requete api.essai "https://api.essai/enroll/JETONDESSAI0123456789" >/dev/null || true
sleep 1
docker exec "$A" grep -q "JETONDESSAI" /var/log/nginx/access.log && echec "jeton d'enrôlement en clair dans le journal d'accès de nginx"
docker exec "$A" grep -q '"GET /enroll/<jeton> ' /var/log/nginx/access.log || echec "chemin d'enrôlement masqué absent du journal"
echo "journal d'accès : /enroll/<jeton>, jeton jamais écrit"

etape "9. Pare-feu public : 443 ouvert, PostgreSQL fermé, retour arrière annulé"
"${JOUER[@]}" "$ANSIBLE/essais/parefeu.yml" > "$TMP/pf.log" 2>&1 || { tail -30 "$TMP/pf.log"; echec "parefeu"; }
grep -q "Annuler le retour arrière" "$TMP/pf.log" || echec "étape d'annulation absente"
[ "$(requete api.essai "https://api.essai/v1/moi")" = 200 ] || echec "443 fermé par le pare-feu"
if docker exec "$B" pg_isready -q -h 172.30.77.2 -t 3; then echec "PostgreSQL de A joignable depuis l'interface publique"; fi
docker exec "$A" systemctl list-timers --all --no-pager | grep -q wakatnet-parefeu-retour && echec "retour arrière toujours programmé"
docker exec "$A" nft list table inet wakatnet_public >/dev/null || echec "table absente"
echo "443 ouvert ; PostgreSQL fermé sur l'interface publique ; retour arrière annulé après la connexion neuve"
docker exec "$A" sh -c 'ls /etc/nftables.d/wakatnet-public.nft.*~ 2>/dev/null' && echec "sauvegarde du fichier précédent laissée après validation"
"${JOUER[@]}" "$ANSIBLE/essais/parefeu.yml" > "$TMP/pf2.log" 2>&1 || { tail -30 "$TMP/pf2.log"; echec "parefeu, second passage"; }
grep -A3 "PLAY RECAP" "$TMP/pf2.log" | grep -qE "noeud_a .*changed=0 " || { grep -A3 "PLAY RECAP" "$TMP/pf2.log"; echec "le second passage du pare-feu change quelque chose"; }
docker exec "$A" nft delete table inet wakatnet_public
"${JOUER[@]}" "$ANSIBLE/essais/parefeu.yml" > "$TMP/pf3.log" 2>&1 || { tail -30 "$TMP/pf3.log"; echec "parefeu, table retirée"; }
docker exec "$A" nft list table inet wakatnet_public >/dev/null 2>&1 || echec "table retirée de la mémoire, fichier inchangé : non rechargée"
grep -A3 "PLAY RECAP" "$TMP/pf3.log" | grep -qE "noeud_a .*changed=0 " && echec "table rechargée sans être signalée (changed=0)"
echo "second passage : changed=0 ; table retirée de la mémoire : rechargée (avec retour arrière) au passage suivant"

etape "10. Pare-feu public : retour arrière déclenché (table fautive jamais validée)"
"${JOUER[@]}" "$ANSIBLE/essais/parefeu-retour.yml" > "$TMP/pfr.log" 2>&1 || { tail -40 "$TMP/pfr.log"; echec "retour arrière"; }
grep -q "retour arrière déclenché : table validée rétablie en mémoire et sur disque" "$TMP/pfr.log" || { tail -20 "$TMP/pfr.log"; echec "assertion du retour arrière absente"; }
docker exec "$A" journalctl -t wakatnet-parefeu --no-pager -n 5 | grep -q "table publique précédente rétablie" || echec "retour arrière non journalisé"
[ "$(requete api.essai "https://api.essai/v1/moi")" = 200 ] || echec "443 fermé après le retour arrière"
if docker exec "$B" pg_isready -q -h 172.30.77.2 -t 3; then echec "PostgreSQL de A joignable après le retour arrière"; fi
"${JOUER[@]}" "$ANSIBLE/essais/parefeu.yml" > "$TMP/pf4.log" 2>&1 || { tail -30 "$TMP/pf4.log"; echec "parefeu après le retour arrière"; }
grep -A3 "PLAY RECAP" "$TMP/pf4.log" | grep -qE "noeud_a .*changed=0 " || { grep -A3 "PLAY RECAP" "$TMP/pf4.log"; echec "après le retour arrière, Ansible doit retrouver la table validée"; }
echo "table fautive (SSH 2222) jamais validée : la table validée revient en mémoire et sur disque ; passage suivant sans changement"
etape "SUCCÈS"
