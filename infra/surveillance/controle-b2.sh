#!/bin/bash
# WAKATNET — contrôle EXTERNE du dépôt de sauvegardes B2 (ADR 0018, « Audit du 13/11/2026 »).
#
# Pourquoi : l'alerte « sauvegarde » est émise par les nœuds eux-mêmes. Un nœud compromis peut rediriger
# pgBackRest (autre bucket, autre chemin) ou recréer la stanza avec sa propre phrase de passe, et continuer à se
# déclarer en bonne santé. Ce script regarde le bucket depuis une machine qui n'est NI A NI B, avec une clé B2 en
# LECTURE SEULE (listBuckets,listFiles), et lève une alerte si :
#   1. l'objet le plus récent sous <chemin>/backup/ a plus de CONTROLE_B2_MAX_SAUVEGARDE_H heures (26 par défaut) ;
#   2. le WAL archivé le plus récent sous <chemin>/archive/<stanza>/ a plus de CONTROLE_B2_MAX_WAL_MIN minutes (60) ;
#   3. un fichier d'information de la stanza (backup.info, archive.info, et leurs .copy) porte une marque
#      d'effacement : pgBackRest les réécrit mais ne les efface jamais, sauf `stanza-delete`. C'est la trace d'une
#      stanza effacée puis recréée (par exemple avec une autre phrase de passe), que les deux contrôles de
#      fraîcheur ne voient pas, puisque de nouveaux objets continuent d'arriver.
#   4. le bucket ne peut pas être listé (clé révoquée, bucket absent, réseau) : on ne conclut jamais « tout va
#      bien » faute de pouvoir regarder.
#
# Sortie : 0 si tout va bien ; 1 si une alerte est levée ; 2 si la configuration est incomplète ; 3 si B2 n'a pas
# pu être lu. Toute sortie non nulle est une alerte : le planificateur (timer systemd, cron) doit la remonter.
# Message sur la sortie d'erreur ; envoi Telegram en plus si CONTROLE_B2_TELEGRAM est réglé.
#
# Identifiants (JAMAIS en argument : ils seraient visibles dans `ps` et l'historique) :
#   - soit AWS_ACCESS_KEY_ID et AWS_SECRET_ACCESS_KEY dans l'environnement (keyID et applicationKey de B2) ;
#   - soit CONTROLE_B2_IDENTIFIANTS=/chemin/fichier, propriétaire l'utilisateur courant, mode 0600 ou 0400, avec
#     deux lignes : AWS_ACCESS_KEY_ID=… et AWS_SECRET_ACCESS_KEY=…  (le fichier est lu, jamais exécuté).
#
# Réglages (environnement) :
#   CONTROLE_B2_BUCKET            nom du bucket (obligatoire)
#   CONTROLE_B2_ENDPOINT          défaut https://s3.eu-central-003.backblazeb2.com
#   CONTROLE_B2_REGION            défaut eu-central-003
#   CONTROLE_B2_CHEMIN            repo1-path sans « / » initial, défaut wakatnet
#   CONTROLE_B2_STANZA            défaut wakatnet
#   CONTROLE_B2_MAX_SAUVEGARDE_H  défaut 26
#   CONTROLE_B2_MAX_WAL_MIN       défaut 60
#   CONTROLE_B2_IGNORER_AVANT     instant UTC (ex. 2026-11-20T03:00:00Z) : marques d'effacement antérieures
#                                 ignorées, une fois l'incident traité (RUNBOOK §7). Vide par défaut.
#   CONTROLE_B2_TELEGRAM          fichier (0600) avec TELEGRAM_JETON=… et TELEGRAM_SALON=… ; facultatif.
#   CONTROLE_B2_SIGNALER_OK=1     envoie aussi un message quand tout va bien (signe de vie quotidien).
#
# Outils : aws (AWS CLI v2, API S3 de B2), GNU date, curl si Telegram. Ne modifie rien dans le bucket.
set -euo pipefail
umask 077

BUCKET="${CONTROLE_B2_BUCKET:-}"
ENDPOINT="${CONTROLE_B2_ENDPOINT:-https://s3.eu-central-003.backblazeb2.com}"
REGION="${CONTROLE_B2_REGION:-eu-central-003}"
CHEMIN="${CONTROLE_B2_CHEMIN:-wakatnet}"
CHEMIN="${CHEMIN#/}"
CHEMIN="${CHEMIN%/}"
STANZA="${CONTROLE_B2_STANZA:-wakatnet}"
MAX_SAUVEGARDE_H="${CONTROLE_B2_MAX_SAUVEGARDE_H:-26}"
MAX_WAL_MIN="${CONTROLE_B2_MAX_WAL_MIN:-60}"
IGNORER_AVANT="${CONTROLE_B2_IGNORER_AVANT:-}"
TELEGRAM="${CONTROLE_B2_TELEGRAM:-}"
SIGNALER_OK="${CONTROLE_B2_SIGNALER_OK:-0}"

ALERTES=()
alerte() { ALERTES+=("$1"); }

# Envoi Telegram facultatif. Le jeton ne passe jamais en argument : l'URL est donnée à curl sur son entrée.
telegram() {
  [ -n "$TELEGRAM" ] || return 0
  local jeton="" salon="" nom valeur
  fichier_prive "$TELEGRAM" || { echo "controle-b2 : $TELEGRAM trop ouvert ou absent, aucun envoi Telegram" >&2; return 0; }
  while IFS='=' read -r nom valeur; do
    case "$nom" in
      TELEGRAM_JETON) jeton="$valeur" ;;
      TELEGRAM_SALON) salon="$valeur" ;;
    esac
  done < "$TELEGRAM"
  if [ -z "$jeton" ] || [ -z "$salon" ]; then
    echo "controle-b2 : TELEGRAM_JETON ou TELEGRAM_SALON manquant dans $TELEGRAM" >&2
    return 0
  fi
  curl -sS --fail --max-time 20 -o /dev/null --config - \
    --data-urlencode "chat_id=$salon" --data-urlencode "text=$1" <<<"url = \"https://api.telegram.org/bot${jeton}/sendMessage\"" \
    || echo "controle-b2 : échec de l'envoi Telegram" >&2
}

fin() {
  local code="$1" texte="$2"
  if [ "$code" -eq 0 ]; then
    echo "$texte"
    [ "$SIGNALER_OK" = 1 ] && telegram "WAKATNET contrôle B2 : $texte"
  else
    echo "$texte" >&2
    telegram "WAKATNET contrôle B2 — ALERTE : $texte"
  fi
  exit "$code"
}

# Fichier ordinaire, à l'utilisateur courant, illisible par le groupe et les autres.
fichier_prive() {
  local f="$1"
  [ -f "$f" ] && [ ! -L "$f" ] || return 1
  [ "$(stat -c '%u' "$f")" = "$(id -u)" ] || return 1
  [ $(( 8#$(stat -c '%a' "$f") & 8#077 )) -eq 0 ]
}

# --- Configuration ---
[ -n "$BUCKET" ] || fin 2 "CONTROLE_B2_BUCKET n'est pas réglé."
[[ "$MAX_SAUVEGARDE_H" =~ ^[0-9]+$ && "$MAX_WAL_MIN" =~ ^[0-9]+$ ]] || fin 2 "seuils non entiers."
command -v aws >/dev/null || fin 2 "outil « aws » (AWS CLI v2) introuvable."
date -u -d '2026-01-01T00:00:00Z' +%s >/dev/null 2>&1 || fin 2 "GNU date requis."

if [ -n "${CONTROLE_B2_IDENTIFIANTS:-}" ]; then
  fichier_prive "$CONTROLE_B2_IDENTIFIANTS" \
    || fin 2 "$CONTROLE_B2_IDENTIFIANTS absent, lien symbolique, d'un autre propriétaire ou trop ouvert (0600 attendu)."
  while IFS='=' read -r nom valeur; do
    case "$nom" in
      AWS_ACCESS_KEY_ID) export AWS_ACCESS_KEY_ID="$valeur" ;;
      AWS_SECRET_ACCESS_KEY) export AWS_SECRET_ACCESS_KEY="$valeur" ;;
    esac
  done < "$CONTROLE_B2_IDENTIFIANTS"
fi
if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  fin 2 "identifiants B2 absents (AWS_ACCESS_KEY_ID et AWS_SECRET_ACCESS_KEY, ou CONTROLE_B2_IDENTIFIANTS)."
fi
# Aucun profil ni fichier de configuration AWS local ne doit s'en mêler ; aucun pager.
export AWS_DEFAULT_REGION="$REGION" AWS_REGION="$REGION" AWS_PAGER="" AWS_CONFIG_FILE=/dev/null \
       AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true
unset AWS_PROFILE AWS_SESSION_TOKEN

maintenant="$(date -u +%s)"
s3api() { aws --endpoint-url "$ENDPOINT" --output text s3api "$@"; }

# Lignes « clé<TAB>instant » des objets courants (non masqués) sous un préfixe ; toutes les pages.
lister() {
  s3api list-objects-v2 --bucket "$BUCKET" --prefix "$1" --query 'Contents[].[Key,LastModified]' \
    | { grep -v '^None$' || true; }
}

age_s() { echo $(( maintenant - $(date -u -d "$1" +%s) )); }
en_clair() { local s="$1"; printf '%d h %02d min' $(( s / 3600 )) $(( (s % 3600) / 60 )); }

# --- 1. Sauvegardes : objet le plus récent sous <chemin>/backup/ ---
if ! sauvegardes="$(lister "$CHEMIN/backup/")"; then
  fin 3 "lecture du bucket $BUCKET impossible (clé révoquée ou sans listFiles, bucket absent, réseau)."
fi
if [ -z "$sauvegardes" ]; then
  alerte "aucun objet sous $CHEMIN/backup/ : dépôt vide ou effacé."
else
  dernier="$(cut -f2 <<<"$sauvegardes" | sort | tail -1)"
  age="$(age_s "$dernier")"
  if [ "$age" -gt $(( MAX_SAUVEGARDE_H * 3600 )) ]; then
    alerte "dernier objet de sauvegarde vieux de $(en_clair "$age") ($dernier), seuil ${MAX_SAUVEGARDE_H} h."
  fi
  info_sauvegarde="sauvegarde il y a $(en_clair "$age")"
fi

# --- 2. WAL : segment archivé le plus récent sous <chemin>/archive/<stanza>/ ---
# Nom d'un segment chez pgBackRest : 24 chiffres hexadécimaux, « - », SHA-1, extension de compression éventuelle.
if ! archives="$(lister "$CHEMIN/archive/$STANZA/")"; then
  fin 3 "lecture du bucket $BUCKET impossible (archives)."
fi
wal="$(grep -E "/[0-9A-F]{24}-[0-9a-f]{40}(\\.[a-z0-9]+)?"$'\t' <<<"$archives" || true)"
if [ -z "$wal" ]; then
  alerte "aucun WAL archivé sous $CHEMIN/archive/$STANZA/."
else
  dernier_wal="$(cut -f2 <<<"$wal" | sort | tail -1)"
  age_wal="$(age_s "$dernier_wal")"
  if [ "$age_wal" -gt $(( MAX_WAL_MIN * 60 )) ]; then
    alerte "dernier WAL archivé vieux de $(en_clair "$age_wal") ($dernier_wal), seuil ${MAX_WAL_MIN} min."
  fi
  info_wal="WAL il y a $(en_clair "$age_wal")"
fi

# --- 3. Marques d'effacement sur les fichiers d'information de la stanza ---
for prefixe in "$CHEMIN/backup/$STANZA/backup.info" "$CHEMIN/archive/$STANZA/archive.info"; do
  if ! marques="$(s3api list-object-versions --bucket "$BUCKET" --prefix "$prefixe" \
                    --query 'DeleteMarkers[].[Key,LastModified]' | { grep -v '^None$' || true; })"; then
    fin 3 "lecture des versions de $prefixe impossible."
  fi
  while IFS=$'\t' read -r cle instant; do
    [ -n "$cle" ] || continue
    if [ -n "$IGNORER_AVANT" ] && [ "$(date -u -d "$instant" +%s)" -lt "$(date -u -d "$IGNORER_AVANT" +%s)" ]; then
      continue
    fi
    alerte "$cle masqué le $instant : stanza effacée (stanza-delete ?), peut-être recréée avec une autre phrase de passe. RUNBOOK §7."
  done <<<"$marques"
done

# --- Verdict ---
if [ "${#ALERTES[@]}" -gt 0 ]; then
  texte="bucket $BUCKET, ${#ALERTES[@]} alerte(s) :"
  for a in "${ALERTES[@]}"; do texte+=$'\n'"- $a"; done
  fin 1 "$texte"
fi
fin 0 "bucket $BUCKET en ordre : ${info_sauvegarde}, ${info_wal}."
