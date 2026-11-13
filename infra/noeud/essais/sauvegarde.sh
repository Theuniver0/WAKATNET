#!/bin/bash
# WAKATNET — banc d'essai des sauvegardes et de la restauration (phase 5, ticket 04 ; ADR 0015 §5).
#   infra/noeud/essais/sauvegarde.sh
# Conteneur jetable (Docker) : base migrée par migrer.sh, jeu de données de la mesure de charge,
# pgBackRest chiffré (dépôt posix ; le transport S3 n'est pas essayé ici), puis :
#   1. stanza, sauvegarde complète chronométrée ; archive des WAL vérifiée (pgbackrest check) ;
#   2. sauvegarder.sh (différentielle) écrit l'état lu par la supervision ;
#   3. essai-restauration.sh : RÉUSSI, avec la durée de restauration ;
#   4. une écriture du grand livre modifiée à la main (déclencheur d'ajout seul retiré par un
#      administrateur, ADR 0013 M7) : essai-restauration.sh doit ÉCHOUER et nommer la ligne ;
#   5. le dépôt est chiffré : déclaré tel par pgBackRest, et illisible sans la phrase de passe ;
#   6. (F4) une sauvegarde piégée (recovery_end_command, search_path de base, et une fonction de pg_catalog qui lance
#      un programme) : le piège s'exécute, mais sous l'utilisateur isolé, sans rien atteindre ; l'essai réussit.
set -euo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
DEPOT="$(cd "$ICI/../../.." && pwd)"
NOM="wakatnet-essai-sauvegarde-$$"
nettoyer() { docker rm -f "$NOM" >/dev/null 2>&1 || true; }
trap nettoyer EXIT
etape() { printf '\n=== %s ===\n' "$*"; }

etape "Image d'essai (Ubuntu 24.04, PostgreSQL 16, pgBackRest)"
CA=()
[ -s /root/.ccr/ca-bundle.crt ] && CA=("--secret" "id=ca,src=/root/.ccr/ca-bundle.crt")
docker build -q --network host "${CA[@]}" -f "$ICI/Dockerfile.sauvegarde" -t wakatnet-essai-sauvegarde:local \
  --build-arg https_proxy "$ICI" >/dev/null
# --privileged : l'essai isole l'instance restaurée par espaces de noms (unshare --net --mount), comme sous systemd.
docker run -d --privileged --name "$NOM" -v "$DEPOT/infra:/depot/infra:ro" -v "$DEPOT/radius/tests/perf:/depot/perf:ro" \
  wakatnet-essai-sauvegarde:local >/dev/null

dans() { docker exec -i "$NOM" "$@"; }
pg() { docker exec -i -u postgres -e PGHOST=/var/run/postgresql "$NOM" "$@"; }

etape "Configuration (phrase de passe aléatoire, jamais affichée) et base primaire"
dans bash -s <<'SH'
set -euo pipefail
install -d -o postgres -g postgres -m 0700 /srv/a /srv/depot /var/lib/wakatnet /var/log/pgbackrest
# Utilisateur de l'instance restaurée (rôle Ansible noeud_wakatnet, scan de sécurité F4).
useradd --system --shell /usr/sbin/nologin --no-create-home --home-dir /nonexistent wakatnet-essai
# Témoins du piège (scan F4) : hors des chemins que l'essai masque. La sonde dit si le réseau local répond (avec l'erreur
# précise, pour ne pas confondre « fermé » et « python absent ») et ce que le code voit de /run.
install -d -m 1777 /srv/temoin
cat > /srv/temoin/sonde.py <<'PY'
import os, socket
try:
    socket.create_connection(("127.0.0.1", 5432), 2)
    r = "ouvert"
except OSError as e:
    r = "ferme errno=%s" % e.errno
print(r, "run=" + ",".join(sorted(os.listdir("/run"))))
PY
chmod 0644 /srv/temoin/sonde.py
# Configuration comme en production (rôle pgbackrest, audit du 13/11/2026) : à root, lisible par postgres seulement.
install -d -o root -g postgres -m 0750 /etc/pgbackrest /etc/pgbackrest/conf.d
# Modèle de production, dépôt S3 remplacé par un répertoire (le reste est inchangé).
sed -e 's/^repo1-type=s3/repo1-type=posix/' -e '/^repo1-s3-/d' -e 's#^repo1-path=.*#repo1-path=/srv/depot#' \
    -e 's#^pg1-path=.*#pg1-path=/srv/a#' /depot/infra/pgbackrest/pgbackrest.conf > /etc/pgbackrest/pgbackrest.conf
umask 077
printf '[global]\nrepo1-cipher-pass=%s\n' "$(head -c 32 /dev/urandom | base64 | tr -d '=+/\n')" > /etc/pgbackrest/conf.d/secret.conf
chown root:postgres /etc/pgbackrest/conf.d/secret.conf && chmod 0640 /etc/pgbackrest/conf.d/secret.conf
# Accès comme en production (rôle postgresql, pg_hba.conf.j2) : peer pour postgres seulement, mot de passe sinon.
# Sans cela (trust par défaut d'initdb), l'essai de restauration refuse de tourner (scan de sécurité F4).
su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /srv/a -E UTF8 --locale=C.UTF-8 --auth-local=peer --auth-host=scram-sha-256 >/dev/null"
cat >> /srv/a/postgresql.conf <<'CONF'
wal_level = replica
archive_mode = on
archive_command = 'pgbackrest --stanza=wakatnet archive-push %p'
archive_timeout = 60
wal_log_hints = on
CONF
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /srv/a -w -l /srv/a/journal.log start >/dev/null"
su postgres -c "createdb wakatnet"
SH

etape "Migrations de production et jeu de données de charge"
pg env PGDATABASE=wakatnet PGUSER=postgres bash /depot/infra/sql/migrer.sh 2>&1 | grep -E "à jour|ERREUR|fumée" || true
SECRET_R1="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
T0="$(date +%s.%N)"
pg env WAKATNET_SECRET_R1="$SECRET_R1" psql -X -q -d wakatnet -v routeurs=50 -v tickets=100000 -v sessions=1000 -v jours=90 \
  -v par_jour=300 -f /depot/perf/donnees.sql >/dev/null
# Quelques mouvements du grand livre (rechargements par la fonction de production).
pg psql -X -q -d wakatnet -c "SELECT count(app.credits_recharger((SELECT min(id) FROM app.tenant), 1000 + n, 'essai-' || n))
                              FROM generate_series(1, 200) n" >/dev/null
echo "jeu chargé en $(awk -v a="$T0" -v b="$(date +%s.%N)" 'BEGIN { printf "%.0f", b - a }') s ; taille : $(pg psql -X -tA -d wakatnet -c "SELECT pg_size_pretty(pg_database_size('wakatnet'))")"

etape "Stanza, vérification de l'archive, sauvegarde complète chronométrée"
pg pgbackrest --stanza=wakatnet stanza-create
pg pgbackrest --stanza=wakatnet check
T0="$(date +%s.%N)"
pg pgbackrest --stanza=wakatnet backup --type=full
echo "chronométré : sauvegarde complète en $(awk -v a="$T0" -v b="$(date +%s.%N)" 'BEGIN { printf "%.1f", b - a }') s"

etape "sauvegarder.sh (différentielle) : état écrit pour la supervision"
pg psql -X -q -d wakatnet -c "SELECT app.credits_recharger((SELECT min(id) FROM app.tenant), 777, 'apres-complete')" >/dev/null
pg env WAKATNET_JOUR_COMPLETE=0 bash /depot/infra/noeud/sauvegarder.sh
pg python3 -c 'import json; e = json.load(open("/var/lib/wakatnet/sauvegarde.json")); assert e["ok"] and e["type"] == "diff", e; print("état :", e)'

etape "Essai de restauration (chronométré)"
dans env WAKATNET_ESSAI_MARGE_MIO=512 WAKATNET_ESSAI_RESULTAT=/var/lib/wakatnet/essai-restauration.json bash /depot/infra/noeud/essai-restauration.sh
pg cat /var/lib/wakatnet/essai-restauration.json

etape "Sauvegarde piégée (scan de sécurité F4) : son code s'exécute sous l'utilisateur isolé, sans rien atteindre"
# Ce qu'un attaquant maître de B mettrait dans la dernière sauvegarde : une commande de fin de récupération, un
# search_path de base qui place une fausse md5() devant pg_catalog, et surtout une fonction DE pg_catalog,
# unnest(text[]) (préférée à unnest(anyarray) : correspondance exacte), que l'essai appelle. Les deux lancent un
# programme qui note son utilisateur, tente d'écrire dans la base VIVANTE (peer en postgres) et à côté d'elle. Tout est
# défait sur la base vivante juste après la sauvegarde. Contre-épreuve (13/11/2026) : l'ancien essai, lancé en postgres,
# crée bien la table dans la base vivante.
dans rm -f /srv/temoin/piege-qui /srv/temoin/piege-reseau /var/lib/wakatnet/piege-execute
pg psql -X -q -v ON_ERROR_STOP=1 -d wakatnet <<'SQL'
CREATE SCHEMA IF NOT EXISTS piege;
CREATE FUNCTION piege.lancer() RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  COPY (SELECT 1) TO PROGRAM 'id -un > /srv/temoin/piege-qui; psql -X -q -h /var/run/postgresql -U postgres -d wakatnet -c "CREATE TABLE IF NOT EXISTS public.piege_vivant ()" >/dev/null 2>&1; touch /var/lib/wakatnet/piege-execute 2>/dev/null; python3 /srv/temoin/sonde.py > /srv/temoin/piege-reseau 2>&1; true';
END $f$;
-- Appelée par l'ancien essai (search_path de la base), puis par le nouveau (pg_catalog, correspondance exacte).
CREATE FUNCTION piege.md5(text) RETURNS text LANGUAGE plpgsql AS $f$ BEGIN PERFORM piege.lancer(); RETURN 'piege'; END $f$;
CREATE FUNCTION pg_catalog.unnest(text[]) RETURNS SETOF text LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM piege.lancer();
  RETURN QUERY SELECT $1[i] FROM pg_catalog.generate_subscripts($1, 1) i;
END $f$;
ALTER DATABASE wakatnet SET search_path = piege, pg_catalog;
ALTER SYSTEM SET recovery_end_command = 'touch /var/lib/wakatnet/piege-execute';
SQL
pg pgbackrest --stanza=wakatnet backup --type=incr
pg psql -X -q -v ON_ERROR_STOP=1 -d wakatnet -c "SET client_min_messages = warning" -c "DROP FUNCTION pg_catalog.unnest(text[])" -c "DROP SCHEMA piege CASCADE" -c "ALTER DATABASE wakatnet RESET search_path" \
  -c "ALTER SYSTEM RESET recovery_end_command" -c "SELECT pg_reload_conf()" >/dev/null
dans rm -f /srv/temoin/piege-qui /srv/temoin/piege-reseau
dans env WAKATNET_ESSAI_MARGE_MIO=512 WAKATNET_ESSAI_RESULTAT=/var/lib/wakatnet/essai-restauration.json bash /depot/infra/noeud/essai-restauration.sh
# Témoin positif : le piège s'est bien exécuté, et sous l'utilisateur isolé.
[ "$(dans cat /srv/temoin/piege-qui 2>/dev/null)" = wakatnet-essai ] \
  || { echo "ÉCHEC : le piège de pg_catalog ne s'est pas exécuté (ou pas sous wakatnet-essai) : le banc ne prouve rien"; exit 1; }
if dans test -e /var/lib/wakatnet/piege-execute; then echo "ÉCHEC : le code de la sauvegarde a écrit à côté de la base vivante"; exit 1; fi
RESEAU="$(dans cat /srv/temoin/piege-reseau 2>/dev/null)"
[[ "$RESEAU" =~ ^ferme\ errno=[0-9]+\ run=$ ]] \
  || { echo "ÉCHEC : le code de la sauvegarde atteint le réseau ou voit /run : $RESEAU"; exit 1; }
if [ "$(pg psql -X -tA -d wakatnet -c "SELECT to_regclass('public.piege_vivant') IS NOT NULL")" = t ]; then
  echo "ÉCHEC : le code de la sauvegarde a écrit dans la base VIVANTE"; exit 1
fi
echo "piège exécuté sous wakatnet-essai, sans réseau ($RESEAU) ni accès à la base vivante ou à son répertoire ; recovery_end_command ignoré"

etape "Atteinte au grand livre après la sauvegarde : l'essai doit la détecter"
ID="$(pg psql -X -q -tA -d wakatnet -c "SELECT max(id) FROM ledger.ecriture WHERE transaction_id IN
        (SELECT id FROM ledger.transaction WHERE objet LIKE 'recharge:essai-%')")"
pg psql -X -q -v ON_ERROR_STOP=1 -d wakatnet <<SQL
ALTER TABLE ledger.ecriture DISABLE TRIGGER ajout_seul;
-- Échange débit et crédit des deux lignes : la transaction reste équilibrée, seule l'empreinte trahit.
UPDATE ledger.ecriture SET debit = credit, credit = debit WHERE transaction_id = (SELECT transaction_id FROM ledger.ecriture WHERE id = $ID);
ALTER TABLE ledger.ecriture ENABLE TRIGGER ajout_seul;
SQL
set +e
SORTIE="$(dans env WAKATNET_ESSAI_MARGE_MIO=512 WAKATNET_ESSAI_RESULTAT=/var/lib/wakatnet/essai-restauration.json bash /depot/infra/noeud/essai-restauration.sh 2>&1)"
CODE=$?
set -e
printf '%s\n' "$SORTIE" | tail -3
[ "$CODE" = 1 ] || { echo "ÉCHEC : l'essai n'a pas détecté l'atteinte (code $CODE)"; exit 1; }
grep -q "ecriture:$ID" <<<"$SORTIE" || { echo "ÉCHEC : la ligne modifiée n'est pas nommée"; exit 1; }
echo "atteinte détectée et nommée (ecriture:$ID)"

etape "Dépôt chiffré : déclaré par pgBackRest, illisible sans la phrase de passe"
# (Un grep de texte clair ne prouverait rien : le dépôt est aussi compressé.)
pg pgbackrest --stanza=wakatnet info --output=json \
  | python3 -c 'import json,sys; r = json.load(sys.stdin)[0]["repo"][0]; assert r["cipher"] == "aes-256-cbc", r; print("chiffrement du dépôt :", r["cipher"])'
dans mv /etc/pgbackrest/conf.d/secret.conf /etc/pgbackrest/secret.conf.retire
if pg pgbackrest --stanza=wakatnet info >/dev/null 2>&1; then echo "ÉCHEC : dépôt lisible sans la phrase de passe"; exit 1; fi
dans mv /etc/pgbackrest/secret.conf.retire /etc/pgbackrest/conf.d/secret.conf
echo "sans la phrase de passe, pgBackRest refuse de lire le dépôt"
etape "SUCCÈS"
