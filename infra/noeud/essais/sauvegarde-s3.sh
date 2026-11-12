#!/bin/bash
# WAKATNET — banc du dépôt S3 verrouillé (revue de sécurité M8, ADR 0018).
#   infra/noeud/essais/sauvegarde-s3.sh
# Le scénario de M8 : un nœud compromis, avec les clés S3 de pgBackRest, tente d'effacer les sauvegardes.
# Serveur S3 de test (moto) : bucket versionné, Object Lock en mode CONFORMITÉ par défaut. Puis :
#   1. stanza, sauvegarde complète chiffrée, une ligne témoin écrite et archivée ;
#   2. l'attaquant efface la stanza (pgbackrest stanza-delete) et tous les objets du dépôt ;
#   3. il tente d'effacer DÉFINITIVEMENT les versions : refusé par le verrou ;
#   4. restauration avec --repo-target-time (le dépôt tel qu'il était avant l'attaque) : la ligne témoin est là.
# Clés S3 factices (moto les accepte toutes) : aucun secret.
set -euo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
DEPOT="$(cd "$ICI/../../.." && pwd)"
NOM="wakatnet-essai-s3-$$"
nettoyer() { docker rm -f "$NOM" >/dev/null 2>&1 || true; }
trap nettoyer EXIT
[ -n "${GARDER:-}" ] && trap - EXIT
etape() { printf '\n=== %s ===\n' "$*"; }

etape "Image d'essai (Ubuntu 26.04, pgBackRest, moto)"
CA=()
[ -s /root/.ccr/ca-bundle.crt ] && CA=("--secret" "id=ca,src=/root/.ccr/ca-bundle.crt")
docker build -q --network host "${CA[@]}" -f "$ICI/Dockerfile.s3" -t wakatnet-essai-s3:local --build-arg https_proxy "$ICI" >/dev/null
docker run -d --name "$NOM" -v "$DEPOT/infra:/depot/infra:ro" wakatnet-essai-s3:local >/dev/null
dans() { docker exec -i "$NOM" "$@"; }
pg() { docker exec -i -u postgres "$NOM" "$@"; }
dans pgbackrest version

etape "Serveur S3 de test ; bucket versionné, verrou de CONFORMITÉ par défaut (1 jour)"
dans bash -s <<'SH'
set -euo pipefail
(nohup /opt/moto/bin/moto_server -H 127.0.0.1 -p 5000 >/var/log/moto.log 2>&1 &)
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=127.0.0.1 -keyout /etc/nginx/s3.key -out /etc/nginx/s3.crt 2>/dev/null
cat > /etc/nginx/sites-enabled/default <<'NG'
server {
    listen 127.0.0.1:9000 ssl;
    ssl_certificate /etc/nginx/s3.crt;
    ssl_certificate_key /etc/nginx/s3.key;
    client_max_body_size 0;
    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_request_buffering off;
    }
}
NG
nginx
for i in $(seq 50); do curl -sk https://127.0.0.1:9000/ >/dev/null 2>&1 && break; sleep 0.2; done
cat > /root/s3.py <<'PY'
import boto3, sys, urllib3
urllib3.disable_warnings()
s3 = boto3.client("s3", endpoint_url="https://127.0.0.1:9000", region_name="eu-central-003", verify=False,
                  aws_access_key_id="cle-factice", aws_secret_access_key="secret-factice")
B = "wakatnet-sauvegardes"
def creer():
    s3.create_bucket(Bucket=B, ObjectLockEnabledForBucket=True,
                     CreateBucketConfiguration={"LocationConstraint": "eu-central-003"})
    s3.put_object_lock_configuration(Bucket=B, ObjectLockConfiguration={"ObjectLockEnabled": "Enabled",
        "Rule": {"DefaultRetention": {"Mode": "COMPLIANCE", "Days": 1}}})
    print("versionnement :", s3.get_bucket_versioning(Bucket=B).get("Status"))
def tout_effacer():
    n = 0
    for p in s3.get_paginator("list_objects_v2").paginate(Bucket=B):
        for o in p.get("Contents", []):
            s3.delete_object(Bucket=B, Key=o["Key"]); n += 1
    print("objets effacés (marqueurs de suppression) :", n)
    left = sum(len(p.get("Contents", [])) for p in s3.get_paginator("list_objects_v2").paginate(Bucket=B))
    print("objets visibles après l'effacement :", left)
def purger_versions():
    refus = ok = 0
    for p in s3.get_paginator("list_object_versions").paginate(Bucket=B):
        for v in p.get("Versions", []):
            try:
                s3.delete_object(Bucket=B, Key=v["Key"], VersionId=v["VersionId"]); ok += 1
            except Exception as e:
                refus += 1
    print(f"effacements définitifs : {ok} réussis, {refus} refusés")
    sys.exit(0 if ok == 0 and refus > 0 else 1)
{"creer": creer, "tout_effacer": tout_effacer, "purger_versions": purger_versions}[sys.argv[1]]()
PY
/opt/moto/bin/python /root/s3.py creer
SH

etape "PostgreSQL, pgBackRest (modèle de production, dépôt S3 de test), sauvegarde complète"
dans bash -s <<'SH'
set -euo pipefail
V=$(ls /usr/lib/postgresql | sort -V | tail -1)
install -d -o postgres -g postgres -m 0700 /srv/a /var/log/pgbackrest /var/spool/pgbackrest /etc/pgbackrest/conf.d
su postgres -c "/usr/lib/postgresql/$V/bin/initdb -D /srv/a -A trust >/dev/null"
cat >> /srv/a/postgresql.conf <<CONF
archive_mode = on
archive_command = 'pgbackrest --stanza=wakatnet archive-push %p'
unix_socket_directories = '/tmp'
CONF
# Modèle de production : point de terminaison et bucket du banc, TLS du banc non vérifié (moto, auto-signé).
sed -e 's#^repo1-s3-endpoint=.*#repo1-s3-endpoint=127.0.0.1#' -e 's#^repo1-s3-region=.*#repo1-s3-region=eu-central-003#' \
    -e 's#^repo1-s3-bucket=.*#repo1-s3-bucket=wakatnet-sauvegardes#' -e 's#^pg1-path=.*#pg1-path=/srv/a#' \
    /depot/infra/pgbackrest/pgbackrest.conf > /etc/pgbackrest/pgbackrest.conf
printf 'repo1-storage-port=9000\nrepo1-storage-verify-tls=n\nrepo1-s3-uri-style=path\npg1-socket-path=/tmp\n' >> /etc/pgbackrest/pgbackrest.conf
umask 077
printf '[global]\nrepo1-cipher-pass=%s\nrepo1-s3-key=cle-factice\nrepo1-s3-key-secret=secret-factice\n' \
  "$(head -c 32 /dev/urandom | base64 | tr -d '=+/\n')" > /etc/pgbackrest/conf.d/secret.conf
chown -R postgres:postgres /etc/pgbackrest /var/log/pgbackrest /var/spool/pgbackrest
su postgres -c "/usr/lib/postgresql/$V/bin/pg_ctl -D /srv/a -l /tmp/pg.log -w start >/dev/null"
SH
pg pgbackrest --stanza=wakatnet stanza-create
pg pgbackrest --stanza=wakatnet --type=full backup
pg psql -h /tmp -d postgres -qc "CREATE TABLE temoin (v text); INSERT INTO temoin VALUES ('avant attaque'); SELECT pg_switch_wal();" >/dev/null
pg pgbackrest --stanza=wakatnet check
sleep 2
AVANT=$(dans date -u +"%Y-%m-%d %H:%M:%S+00")
sleep 2

etape "2. L'attaquant (clés du nœud) efface la stanza et tous les objets du dépôt"
dans su postgres -c "/usr/lib/postgresql/\$(ls /usr/lib/postgresql | sort -V | tail -1)/bin/pg_ctl -D /srv/a -m fast -w stop >/dev/null"
pg pgbackrest --stanza=wakatnet stop
pg pgbackrest --stanza=wakatnet --force stanza-delete
dans /opt/moto/bin/python /root/s3.py tout_effacer
if pg pgbackrest --stanza=wakatnet info 2>&1 | grep -q "status: ok"; then echo "ÉCHEC : le dépôt est encore lisible sans --repo-target-time"; exit 1; fi
echo "ok : le dépôt courant est vide pour pgBackRest"

etape "3. Effacement DÉFINITIF des versions : refusé par le verrou de conformité"
dans /opt/moto/bin/python /root/s3.py purger_versions
echo "ok : aucune version n'a pu être effacée"

etape "4. Restauration du dépôt tel qu'il était avant l'attaque (--repo-target-time)"
pg pgbackrest --stanza=wakatnet --repo=1 --repo-target-time="$AVANT" info | grep -E "status|full backup" | head -3
dans bash -c 'rm -rf /srv/a && install -d -o postgres -g postgres -m 0700 /srv/a'
# Restauration jusqu'à la fin des WAL archivés avant l'attaque, puis promotion.
pg pgbackrest --stanza=wakatnet --repo=1 --repo-target-time="$AVANT" restore 2>&1 | tail -5
dans su postgres -c "/usr/lib/postgresql/\$(ls /usr/lib/postgresql | sort -V | tail -1)/bin/pg_ctl -D /srv/a -l /tmp/pg2.log -w start >/dev/null"
for _ in $(seq 30); do pg psql -h /tmp -d postgres -tAc "SELECT NOT pg_is_in_recovery()" 2>/dev/null | grep -q t && break; sleep 1; done
v=$(pg psql -h /tmp -d postgres -tAc "SELECT v FROM temoin")
[ "$v" = "avant attaque" ] || { echo "ÉCHEC : ligne témoin absente après restauration ($v)"; exit 1; }
echo "ok : base restaurée depuis le dépôt d'avant l'attaque, ligne témoin présente"
etape "SUCCÈS"
