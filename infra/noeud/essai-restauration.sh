#!/bin/bash
# WAKATNET — essai de restauration automatisé (ADR 0015 §5 ; SPEC §10.1 : « test de restauration
# automatisé chaque mois »). Ticket : .scratch/phase-5-haute-disponibilite/issues/04-sauvegardes.md
#
# En root (unité systemd), sur un nœud (la base vivante est la base locale, primaire ou réplique) :
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
#
# Scan de sécurité du 13/11/2026 (F4), corrigé après relecture : la sauvegarde vient d'un dépôt que l'AUTRE nœud peut
# aussi écrire. DÉMARRER une base restaurée, c'est exécuter son code : ses catalogues (pg_proc, pg_type, opérateurs…)
# sont à elle, aucune configuration ne l'empêche. L'instance restaurée tourne donc sous un utilisateur système DÉDIÉ
# et sans droits (wakatnet-essai) :
#   - le pg_hba vivant n'accepte en peer que l'utilisateur système postgres ; les autres rôles exigent un mot de passe ;
#   - il ne lit ni /etc/pgbackrest (phrase de passe, clés du dépôt), ni /etc/wakatnet, ni le répertoire de la base ;
#   - la restauration (pgBackRest, sous postgres) ne fait que poser des fichiers ; les WAL nécessaires sont tirés
#     AVANT le démarrage, l'instance n'a pas accès au dépôt ;
#   - tout ce qu'elle répond est une donnée non fiable : chaque ligne est filtrée par un motif strict, le JSON du
#     résultat est construit par python.
# Sa configuration est tout de même imposée (fichiers fixes, pas de préchargement ni d'archivage). Mieux encore
# (ADR 0018) : un essai sur une machine jetable, hors des nœuds.
set -euo pipefail
STANZA="${WAKATNET_STANZA:-wakatnet}"
RACINE="${WAKATNET_ESSAI_RACINE:-/var/lib/wakatnet-essai}"
RESULTAT="${WAKATNET_ESSAI_RESULTAT:-/var/lib/wakatnet/essai-restauration.json}"
PORT="${WAKATNET_ESSAI_PORT:-5499}"
PGBIN="${WAKATNET_PGBIN:-/usr/lib/postgresql/16/bin}"
BASE="${WAKATNET_BASE:-wakatnet}"
ISOLE="${WAKATNET_ESSAI_UTILISATEUR:-wakatnet-essai}"

[ "$(id -u)" = 0 ] || { echo "ÉCHEC : à lancer en root (unité wakatnet-essai-restauration)" >&2; exit 1; }
uid_isole="$(id -u "$ISOLE" 2>/dev/null)" || { echo "ÉCHEC : utilisateur système $ISOLE absent (rôle Ansible noeud_wakatnet)" >&2; exit 1; }
if [ "$uid_isole" = 0 ] || [ "$uid_isole" = "$(id -u postgres)" ]; then
  echo "ÉCHEC : $ISOLE doit être un utilisateur dédié, ni root ni postgres" >&2; exit 1
fi
cd /
# Instance restaurée et tout ce qu'elle lance : sous $ISOLE, sans groupe secondaire ni capacité (no_new_privs), dans ses
# PROPRES espaces de noms :
#   - réseau : aucune interface (ni Internet, ni l'autre nœud, ni l'API ou FreeRADIUS en local) ;
#   - IPC : sémaphores et mémoire partagée System V à part (la base vivante ne peut pas en être privée) ;
#   - montage : /run en entier (socket de la base vivante, D-Bus, systemd-resolved : pas de résolution DNS détournée),
#     la base vivante, les secrets, journaux et files masqués par des tmpfs vides ; /tmp, /var/tmp et /dev/shm remplacés
#     par des tmpfs BORNÉS (le code de la sauvegarde ne remplit pas le disque du primaire par là) ;
#   - PID : le premier processus (le serveur) y est PID 1 ; sa mort tue TOUT ce qu'il a lancé (aucun processus détaché ne
#     survit), et /proc ne montre que l'essai (pas les lignes de commande de l'hôte).
# L'instance n'a besoin que de $DONNEES (sa socket y est) et de $WAL. Échec d'un masquage : refus.
isole() {
  unshare --net --ipc --pid --fork --kill-child --mount --mount-proc --propagation private -- sh -c '
    for d in /run /var/run /var/lib/postgresql /etc/pgbackrest /etc/wakatnet /var/lib/wakatnet /var/spool /var/log; do
      if [ -d "$d" ] && [ ! -L "$d" ]; then mount -n -t tmpfs -o size=64k,mode=0755 essai-masque "$d" || exit 97; fi
    done
    for d in /tmp /var/tmp /dev/shm; do
      if [ -d "$d" ] && [ ! -L "$d" ]; then mount -n -t tmpfs -o size=64m,mode=1777 essai-borne "$d" || exit 97; fi
    done
    u="$1"; shift
    exec setpriv --reuid="$u" --regid="$u" --clear-groups --no-new-privs --bounding-set=-all --inh-caps=-all \
      --pdeathsig KILL -- "$@"' isole "$ISOLE" "$@"
}
comme() {
  local u="$1"; shift
  # L'utilisateur isolé n'a AUCUN groupe secondaire (s'il était ajouté au groupe postgres, il lirait ses journaux).
  if [ "$u" = "$ISOLE" ]; then setpriv --reuid="$u" --regid="$u" --clear-groups -- "$@"
  else setpriv --reuid="$u" --regid="$u" --init-groups -- "$@"; fi
}
VIVANTE=(comme postgres psql -X -q -tA -v ON_ERROR_STOP=1 -d "$BASE")
# Restauration et WAL : sous postgres (il lit le dépôt et sa configuration), mais dans un espace de montage où la base
# VIVANTE, /var/lib/wakatnet, les secrets de l'API et la socket sont masqués, et dans son propre espace PID. Un manifeste
# piégé (chemin, lien) n'atteint donc que l'essai : la file et les journaux de pgBackRest y sont masqués aussi (des
# « .ok » déposés dans la file archive-push du primaire lui feraient croire des WAL archivés), et ses journaux et
# verrous de l'essai vont dans $PGBR, à postgres, sous $RACINE (pas de file : archive-get synchrone).
sous_postgres_masque() {
  unshare --pid --fork --kill-child --mount --mount-proc --propagation private -- sh -c '
    vivantes="$1"; shift
    for d in "$vivantes" /var/lib/postgresql /var/lib/wakatnet /etc/wakatnet /run/postgresql /var/run/postgresql \
             /var/spool/pgbackrest /var/log/pgbackrest; do
      if [ -d "$d" ] && [ ! -L "$d" ]; then mount -n -t tmpfs -o size=64k,mode=0755 essai-masque "$d" || exit 97; fi
    done
    exec setpriv --reuid=postgres --regid=postgres --init-groups --no-new-privs --pdeathsig KILL -- "$@"' masque "$DONNEES_VIVANTES" "$@"
}

# Sur le primaire seulement, comme la sauvegarde (une réplique doublerait charge et disque).
if [ "$("${VIVANTE[@]}" -c 'SELECT pg_is_in_recovery()')" = t ]; then
  echo "essai de restauration : réplique, rien à faire sur ce nœud"
  exit 0
fi
# L'isolement REPOSE sur ces deux points : vérifiés à chaque essai, avant de restaurer quoi que ce soit.
for h in /var/run/postgresql 127.0.0.1; do
  if comme "$ISOLE" env -u PGPASSWORD PGPASSFILE=/nonexistent PGCONNECT_TIMEOUT=5 \
       psql -X -q -tA -w -h "$h" -U postgres -d "$BASE" -c 'SELECT 1' >/dev/null 2>&1; then
    echo "ÉCHEC : la base vivante accepte $ISOLE en postgres par $h (pg_hba) : l'isolement de l'essai serait nul" >&2; exit 1
  fi
done
for d in /etc/pgbackrest /etc/wakatnet; do
  if [ -d "$d" ] && comme "$ISOLE" ls "$d" >/dev/null 2>&1; then
    echo "ÉCHEC : $ISOLE lit $d (secrets) : l'isolement de l'essai serait nul" >&2; exit 1
  fi
done
# Les espaces de noms doivent marcher (sinon refus, jamais d'essai à découvert) : aucune connexion TCP, même locale,
# et pas de socket de la base vivante.
if ! isole python3 -c '
import socket, sys, glob
assert not glob.glob("/var/run/postgresql/.s.PGSQL.*") and not glob.glob("/run/postgresql/.s.PGSQL.*")
s = socket.socket(); s.settimeout(2)
try:
    s.connect(("127.0.0.1", 5432)); sys.exit(1)
except OSError:
    pass' 2>/dev/null; then
  echo "ÉCHEC : isolement de l'instance indisponible (unshare --net --mount) : l'essai ne tourne pas à découvert" >&2; exit 1
fi
install -d -o root -g root -m 0711 "$RACINE"
DONNEES_VIVANTES="$("${VIVANTE[@]}" -c 'SHOW data_directory')"
[ -d "$DONNEES_VIVANTES" ] || { echo "ÉCHEC : répertoire de la base vivante introuvable" >&2; exit 1; }
# Une copie laissée par un essai interrompu (SIGKILL à l'expiration du délai : le piège EXIT ne s'exécute
# pas) est une base EN CLAIR sur disque : effacée avant tout (revue de sécurité F7).
pkill -KILL -u "$ISOLE" 2>/dev/null || true
rm -rf "$RACINE"/donnees.* "$RACINE"/wal.* "$RACINE"/conf.* "$RACINE"/pgbackrest.*
DONNEES="$(mktemp -d "$RACINE/donnees.XXXXXX")"
WAL="$(mktemp -d "$RACINE/wal.XXXXXX")"
PGBR="$(mktemp -d "$RACINE/pgbackrest.XXXXXX")"
CONF="$(mktemp -d "$RACINE/conf.XXXXXX")"
chown postgres:postgres "$DONNEES" "$WAL" "$PGBR"
chmod 0700 "$DONNEES" "$WAL" "$PGBR"
chmod 0755 "$CONF"
# Session imposée par le client (prioritaire sur ALTER ROLE / ALTER DATABASE restaurés) ; défense en profondeur
# seulement : l'isolement vient de l'utilisateur.
ESSAI=(isole env "PGOPTIONS=-c session_preload_libraries= -c local_preload_libraries= -c search_path=pg_catalog -c jit=off"
       psql -X -q -tA -v ON_ERROR_STOP=1 -h "$DONNEES" -p "$PORT" -U postgres -d "$BASE")
nettoyer() {
  # Aucune commande du nettoyage ne doit changer le code de sortie de l'essai (set -e dans le piège EXIT).
  if [ -n "${SURVEILLANT:-}" ]; then kill "$SURVEILLANT" 2>/dev/null || true; fi
  # Le serveur est PID 1 de son espace : le tuer tue tout ce qu'il a lancé (COPY … TO PROGRAM détaché compris).
  pkill -KILL -u "$ISOLE" 2>/dev/null || true
  if [ -n "${SERVEUR:-}" ]; then wait "$SERVEUR" 2>/dev/null || true; fi
  rm -rf "$DONNEES" "$WAL" "$PGBR" "$CONF" || true
}
trap nettoyer EXIT
# Réponse de l'instance restaurée : non fiable. Chaque ligne doit suivre le motif, sinon l'essai échoue.
essai_lire() {
  local motif="$1" requete="$2" sortie
  sortie="$("${ESSAI[@]}" -c "$requete")" || { disque_ok; return 1; }
  if [ -n "$sortie" ] && printf '%s\n' "$sortie" | LC_ALL=C grep -qvE "$motif"; then
    echo "ÉCART : réponse inattendue de l'instance restaurée (motif $motif) : sauvegarde suspecte" >&2
    return 1
  fi
  printf '%s\n' "$sortie"
}

# État du dépôt lu UNE fois (seconde relecture : la sauvegarde contrôlée est celle qui est restaurée, --set). Le dépôt
# est écrit par l'autre nœud : chaque valeur est validée par python, jamais interprétée par le shell.
#   - étiquette, taille annoncée, WAL de cohérence (premier et dernier segment) ;
#   - au plus WAKATNET_ESSAI_WAL_MAX segments de 16 Mio (4096 par défaut, 64 Gio) : une plage démesurée est refusée ;
#   - place disque : sauvegarde + WAL, plus 20 %, en laissant au système de fichiers au moins 10 % ou 2 Gio libres
#     (WAKATNET_ESSAI_MARGE_MIO pour un banc). La base vivante ne doit jamais manquer de place pour ses WAL à cause de
#     l'essai (sur le même disque, elle s'arrêterait). Un disque dédié à $RACINE reste préférable.
etat="$(comme postgres pgbackrest --stanza="$STANZA" info --output=json | python3 -c '
import json, os, re, sys
b = json.load(sys.stdin)[0]["backup"][-1]
e, d, f, taille = b["label"], b["archive"]["start"], b["archive"]["stop"], int(b["info"]["size"])
assert re.fullmatch(r"[0-9]{8}-[0-9]{6}F(_[0-9]{8}-[0-9]{6}[DI])?", e), e
assert re.fullmatch(r"[0-9A-F]{24}", d) and re.fullmatch(r"[0-9A-F]{24}", f) and d[:8] == f[:8] and d <= f, (d, f)
nb = (int(f[8:16], 16) * 256 + int(f[16:], 16)) - (int(d[8:16], 16) * 256 + int(d[16:], 16)) + 1
if not 0 < nb <= int(sys.argv[3]):
    sys.exit("ÉCHEC : plage de WAL invalide ou démesurée (%d segments) : sauvegarde suspecte, rien n est restauré" % nb)
st = os.statvfs(sys.argv[1])
libre, total = st.f_bavail * st.f_frsize, st.f_blocks * st.f_frsize
besoin = (taille + nb * (16 << 20)) * 12 // 10
marge = int(sys.argv[2]) << 20 if sys.argv[2] else max(total // 10, 2 << 30)
if libre - besoin < marge:
    sys.exit("ÉCHEC : place insuffisante pour l essai (%d Mio nécessaires, %d Mio libres) : rien n est restauré"
             % (besoin >> 20, libre >> 20))
print(e, d, f, marge)' "$RACINE" "${WAKATNET_ESSAI_MARGE_MIO:-}" "${WAKATNET_ESSAI_WAL_MAX:-4096}")" || exit 1
read -r etiquette wal_debut wal_fin marge <<<"$etat"
# Surveillant du disque pendant TOUT l'essai : la taille annoncée vient du dépôt, et le code de la sauvegarde peut écrire
# dans $DONNEES. Si la place libre passe sous la marge, la restauration et l'instance sont tuées, l'essai échoue.
DISQUE_KO="$CONF/disque-ko"
place_libre() { df -B1 --output=avail "$RACINE" 2>/dev/null | tail -1 | tr -d ' '; }
# Échoue FERMÉ : une mesure impossible vaut un disque plein. Une fois déclenché, il continue de tuer jusqu'à la fin.
surveiller_disque() {
  local libre
  set +e
  while sleep 2; do
    libre="$(place_libre)"
    if ! [ "$libre" -ge "$marge" ] 2>/dev/null; then
      : > "$DISQUE_KO"
      [ -s "$CONF/restauration.pid" ] && pkill -KILL -P "$(cat "$CONF/restauration.pid")" 2>/dev/null
      pkill -KILL -u "$ISOLE" 2>/dev/null
    fi
  done
}
surveiller_disque &
SURVEILLANT=$!
disque_ok() {
  if [ -e "$DISQUE_KO" ]; then
    echo "ÉCHEC : place disque passée sous la marge pendant l'essai ($(( marge >> 20 )) Mio) : essai arrêté par le surveillant" >&2
    exit 1
  fi
  # Mesure immédiate aussi : l'essai peut finir entre deux passages du surveillant.
  local libre; libre="$(place_libre)"
  if ! [ "$libre" -ge "$marge" ] 2>/dev/null; then
    echo "ÉCHEC : place disque passée sous la marge pendant l'essai ($(( marge >> 20 )) Mio) : essai arrêté" >&2; exit 1
  fi
}
# Une commande de l'essai lancée en arrière-plan, suivie par le surveillant (qui tue son espace s'il le faut).
suivi() {
  "$@" &
  local pid=$!
  echo "$pid" > "$CONF/restauration.pid"
  if wait "$pid"; then : > "$CONF/restauration.pid"; disque_ok; return 0; fi
  : > "$CONF/restauration.pid"; disque_ok; return 1
}

debut="$(date +%s.%N)"
# Restauration sous postgres : pgBackRest pose les fichiers, rien de la sauvegarde ne s'exécute. Un tablespace déclaré
# par le manifeste est replacé DANS le répertoire d'essai (jamais au chemin choisi par la sauvegarde) ; les liens
# symboliques sont restaurés en répertoires (link-all désactivé par défaut).
PGBR_OPTIONS=(--stanza="$STANZA" --pg1-path="$DONNEES" --log-path="$PGBR" --lock-path="$PGBR")
suivi sous_postgres_masque pgbackrest "${PGBR_OPTIONS[@]}" --type=immediate --target-action=promote \
  --archive-mode=off --tablespace-map-all="$DONNEES/pg_tblspc_essai" --set="$etiquette" restore >/dev/null \
  || { echo "ÉCHEC : restauration" >&2; exit 1; }
# Aucun lien de la copie ne doit sortir de la copie (manifeste piégé) : rien n'est démarré sinon.
if ! python3 - "$DONNEES" <<'PY'
import os, sys
racine = os.path.realpath(sys.argv[1])
for base, reps, fichiers in os.walk(racine):
    for nom in reps + fichiers:
        chemin = os.path.join(base, nom)
        if os.path.islink(chemin) and os.path.commonpath([racine, os.path.realpath(chemin)]) != racine:
            sys.exit("ÉCART : lien hors de la copie restaurée (%s) : sauvegarde suspecte" % os.path.relpath(chemin, racine))
PY
then exit 1; fi
# WAL tirés AVANT le démarrage (segments de 16 Mo) : l'instance restaurée ne touche jamais au dépôt ni à sa phrase de passe.
while read -r seg; do
  suivi sous_postgres_masque pgbackrest "${PGBR_OPTIONS[@]}" archive-get "$seg" "$WAL/$seg" >/dev/null \
    || { echo "ÉCHEC : WAL $seg introuvable" >&2; exit 1; }
done < <(python3 -c '
import sys
d, f = sys.argv[1], sys.argv[2]
tl, (l, s), fin = d[:8], (int(d[8:16], 16), int(d[16:], 16)), (int(f[8:16], 16), int(f[16:], 16))
while (l, s) <= fin:
    print("%s%08X%08X" % (tl, l, s))
    l, s = (l + 1, 0) if s == 0xFF else (l, s + 1)' "$wal_debut" "$wal_fin")
# Historique de la ligne temporelle, s'il y en a une (après une bascule) : absent sur la ligne 1.
suivi sous_postgres_masque pgbackrest "${PGBR_OPTIONS[@]}" archive-get "${wal_debut:0:8}.history" "$WAL/${wal_debut:0:8}.history" \
  >/dev/null 2>&1 || true
# La configuration de la sauvegarde n'est jamais lue. Fichiers restaurés retirés, postgresql.auto.conf vidé ; la
# configuration de l'essai est écrite ici, hors du répertoire restauré, avec des valeurs de confiance : celles que la
# récupération exige au moins égales au primaire sont lues dans la base VIVANTE.
rm -f "$DONNEES/postgresql.conf" "$DONNEES/pg_hba.conf" "$DONNEES/pg_ident.conf"
rm -rf "$DONNEES/conf.d"
# Sous postgres : un lien posé par la sauvegarde à cet endroit ne fait pas écrire root ailleurs.
comme postgres sh -c ': > "$1/postgresql.auto.conf"' vider "$DONNEES"
{
  for p in max_connections max_worker_processes max_wal_senders max_prepared_transactions max_locks_per_transaction wal_level; do
    printf "%s = '%s'\n" "$p" "$("${VIVANTE[@]}" -c "SHOW $p")"
  done
  cat <<CONF_ESSAI
data_directory = '$DONNEES'
hba_file = '$CONF/pg_hba.conf'
ident_file = '$CONF/pg_ident.conf'
port = $PORT
listen_addresses = ''
unix_socket_directories = '$DONNEES'
archive_mode = off
primary_conninfo = ''
restore_command = 'cp "$WAL/%f" "%p"'
recovery_target = 'immediate'
recovery_target_action = 'promote'
recovery_end_command = ''
archive_cleanup_command = ''
shared_preload_libraries = ''
session_preload_libraries = ''
local_preload_libraries = ''
dynamic_library_path = '\$libdir'
ssl = off
ssl_passphrase_command = ''
jit = off
autovacuum = off
max_logical_replication_workers = 0
CONF_ESSAI
} > "$CONF/postgresql.conf"
# Socket dans le répertoire d'essai (0700, à $ISOLE) : seul $ISOLE (et root) l'atteint, d'où trust.
printf 'local all all trust\n' > "$CONF/pg_hba.conf"
: > "$CONF/pg_ident.conf"
chmod 0644 "$CONF"/*
chown -R "$ISOLE:$ISOLE" "$DONNEES" "$WAL"
# Serveur au premier plan, PID 1 de son espace ; son journal est écrit par l'utilisateur isolé, dans son répertoire.
isole sh -c 'exec "$0" -D "$1" -c "config_file=$2" > "$1/essai.log" 2>&1' "$PGBIN/postgres" "$DONNEES" "$CONF/postgresql.conf" \
  2> "$CONF/serveur.err" &
SERVEUR=$!
for _ in $(seq 1 600); do
  disque_ok
  if ! kill -0 "$SERVEUR" 2>/dev/null; then
    echo "ÉCHEC : l'instance restaurée s'est arrêtée ; fin de son journal :" >&2
    cat "$CONF/serveur.err" >&2 || true
    # Lu sous l'utilisateur isolé : son répertoire est à lui (un lien vers un secret ne se lit pas en root).
    isole tail -20 "$DONNEES/essai.log" >&2 || true; exit 1
  fi
  [ "$("${ESSAI[@]}" -c 'SELECT pg_is_in_recovery()' 2>/dev/null || true)" = f ] && break
  sleep 1
done
[ "$("${ESSAI[@]}" -c 'SELECT pg_is_in_recovery()')" = f ] || { echo "ÉCHEC : l'instance restaurée ne sort pas de la récupération" >&2; exit 1; }
fin="$(date +%s.%N)"
duree="$(awk -v a="$debut" -v b="$fin" 'BEGIN { printf "%.1f", b - a }')"

ecarts=()
# Contrôle de forme : seules de vraies tables (relkind r), aux colonnes de types intégrés, sont lues.
suspectes="$(essai_lire '^[[:alnum:]_ .:,-]*$' "SELECT string_agg(x, ', ') FROM (
    SELECT n.nspname || '.' || c.relname AS x FROM unnest(ARRAY['public.schema_migrations', 'ledger.compte', 'ledger.transaction', 'ledger.ecriture']) t(nom)
      LEFT JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass(t.nom) LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.oid IS NULL OR c.relkind <> 'r' OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0
                                                         AND NOT a.attisdropped AND a.atttypid >= 16384)
     UNION ALL SELECT 'table manquante : ' || t.nom FROM unnest(ARRAY['public.schema_migrations', 'ledger.compte', 'ledger.transaction', 'ledger.ecriture']) t(nom)
     WHERE pg_catalog.to_regclass(t.nom) IS NULL) s")"
if [ -n "$suspectes" ]; then
  echo "ÉCART : sauvegarde suspecte, tables non lues (vue, type maison ou absente) : $suspectes" >&2
  exit 1
fi
# a. migrations
migr_essai="$(essai_lire '^[A-Za-z0-9_./-]+ [0-9a-f]{64}$' "SELECT fichier || ' ' || sha256 FROM public.schema_migrations ORDER BY 1")"
manquantes="$(comm -23 <(printf '%s\n' "$migr_essai" | LC_ALL=C sort) \
                       <("${VIVANTE[@]}" -c "SELECT fichier || ' ' || sha256 FROM public.schema_migrations ORDER BY 1" | LC_ALL=C sort) | wc -l)"
[ "$manquantes" = 0 ] || ecarts+=("migrations : $manquantes absente(s) ou modifiée(s) dans la base vivante")
# b. équilibre du grand livre restauré
desequilibres="$(essai_lire '^[0-9]+$' "SELECT count(*) FROM (SELECT transaction_id FROM ledger.ecriture GROUP BY 1
                                     HAVING sum(debit) <> sum(credit) OR count(*) < 2) x")"
[ "$desequilibres" = 0 ] || ecarts+=("grand livre restauré : $desequilibres transaction(s) déséquilibrée(s)")
# c. grand livre restauré ⊆ grand livre vivant (empreinte de chaque ligne ; identifiants seuls dans le rapport)
# shellcheck disable=SC2016  # $$…$$ : chaînes SQL, aucune expansion voulue
empreintes='SELECT $$compte:$$ || id || $$ $$ || md5(c::text) FROM ledger.compte c
            UNION ALL SELECT $$transaction:$$ || id || $$ $$ || md5(t::text) FROM ledger.transaction t
            UNION ALL SELECT $$ecriture:$$ || id || $$ $$ || md5(e::text) FROM ledger.ecriture e'
emp_essai="$(essai_lire '^(compte|transaction|ecriture):[0-9]+ [0-9a-f]{32}$' "$empreintes")"
differences="$(comm -23 <(printf '%s\n' "$emp_essai" | LC_ALL=C sort) <("${VIVANTE[@]}" -c "$empreintes" | LC_ALL=C sort) \
               | cut -d' ' -f1 | head -20 | paste -sd, -)"
lignes_ledger="$(essai_lire '^[0-9]+ transactions, [0-9]+ écritures$' "SELECT (SELECT count(*) FROM ledger.transaction) || ' transactions, ' || (SELECT count(*) FROM ledger.ecriture) || ' écritures'")"
[ -z "$differences" ] || ecarts+=("grand livre : ligne(s) de la sauvegarde absente(s) ou modifiée(s) dans la base vivante : $differences")
# d. comptes rapportés
comptes="$(essai_lire '^[0-9]+ [0-9]+ [0-9]+ [0-9]+$' "SELECT (SELECT count(*) FROM app.tenant) || ' ' || (SELECT count(*) FROM app.voucher)
           || ' ' || (SELECT count(*) FROM app.payment) || ' ' || (SELECT count(*) FROM radius.session)")"

disque_ok
ok=true
[ "${#ecarts[@]}" = 0 ] || ok=false
install -d "$(dirname "$RESULTAT")"
tmp="$(mktemp "$(dirname "$RESULTAT")/.essai.XXXXXX")"
# JSON construit par python : aucune valeur n'est collée dans le texte (relecture : injection de "ok":true).
printf '%s\n' "${ecarts[@]:-}" | python3 -c '
import json, sys
ok, etiquette, duree, ledger, comptes = sys.argv[1:6]
p, t, pa, s = (int(x) for x in comptes.split())
print(json.dumps({"fin": sys.argv[6], "ok": ok == "true", "etiquette": etiquette, "duree_restauration_s": float(duree),
                  "grand_livre": ledger, "comptes": {"proprietaires": p, "tickets": t, "paiements": pa, "sessions": s},
                  "ecarts": [l for l in sys.stdin.read().splitlines() if l]}, ensure_ascii=False))' \
  "$ok" "$etiquette" "$duree" "$lignes_ledger" "$comptes" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
chmod 0644 "$tmp"
mv "$tmp" "$RESULTAT"
echo "essai de restauration : sauvegarde $etiquette restaurée en ${duree} s ; grand livre : $lignes_ledger"
if [ "$ok" = true ]; then
  echo "essai de restauration : RÉUSSI"
else
  printf 'ÉCART : %s\n' "${ecarts[@]}" >&2
  exit 1
fi
