#!/usr/bin/env bash
# sonde.sh — sonde de latence UDP (irtt) pour WAKATNET, côté Linux derrière le routeur.
#
# Lance un client irtt en continu vers chaque cible de la liste, par tranches
# alignées sur l'horloge (par défaut 15 min). Chaque tranche produit un fichier
# JSON gzippé horodaté (format natif d'irtt). Une tranche qui ne peut pas
# s'ouvrir (Internet coupé, cible injoignable) est journalisée, puis la sonde
# réessaie. Après une coupure de courant, il suffit de relancer la sonde
# (service systemd conseillé, voir README.md) : elle repart à la tranche suivante.
#
# Aucun secret : irtt n'utilise ici ni clé ni HMAC. Les adresses des cibles
# sont lues dans un fichier de configuration (une cible par ligne).
#
# Usage :
#   sonde.sh -s SITE -a ACCES -c cibles.conf -o DOSSIER [-i 200ms] [-t 900]
#            [-l 0] [-F FIN_UTC | -H 48 | -D SECONDES] [-O 2s,2s,2s,2s] [-N 900]
#            [-X OPTIONS]
#     -s SITE    nom court du site, [a-z0-9] seulement (ex. ouaga1)
#     -a ACCES   fibre | adsl | 4g | starlink | ... ([a-z0-9] seulement)
#     -c FICHIER liste des cibles : « NOM HOTE:PORT » par ligne, # = commentaire
#                NOM en [a-z0-9-] (ex. fsn-udp, fsn-wg)
#     -o DOSSIER dossier de sortie (créé au besoin)
#     -i INTERV  intervalle d'envoi irtt (défaut 200ms)
#     -t SEC     durée d'une tranche en secondes, de 60 à 1200 (défaut 900).
#                Plafond 1200 = --timeout=20m du serveur irtt (serveur-vm.sh) :
#                au-delà, une coupure de plus de 20 min ferait paraître perdue
#                toute la fin de la tranche.
#     -l OCTETS  longueur des paquets irtt (défaut 0 = minimum d'irtt, 60 octets)
#     -F FIN     arrêt à une date absolue UTC, ex. 2026-11-15T12:00:00Z
#                (conseillé avec systemd : un redémarrage ne repousse pas la fin)
#     -H HEURES  arrêt automatique après N heures (défaut 0 = jamais)
#     -D SEC     arrêt automatique après N secondes (essais courts ; prime sur -H)
#     -O LISTE   délais d'ouverture de session irtt (défaut 2s,2s,2s,2s : un
#                échec d'ouverture est constaté en 8 s ; avec la pause de 1 s,
#                la résolution d'une indisponibilité à l'ouverture est d'environ 9 s)
#     -N SEC     attente maximale de la synchronisation NTP avant la première
#                tranche (défaut 900 ; 0 = ne pas attendre). Passé ce délai, la
#                sonde démarre quand même et le journalise (ntp_synchronise=no).
#     -X OPTIONS options irtt supplémentaires, ex. -X "--tstamp=none" (captures
#                deux fois plus petites, sans horodatage serveur)
#
# Codes de sortie : 0 fin normale ; 2 erreur d'usage ; 3 environnement (irtt
# absent, dossier) ; 4 date de fin -F déjà passée (systemd ne relance pas :
# RestartPreventExitStatus=2 4, voir README).
#
# Fichiers produits dans DOSSIER :
#   AAAA-MM-JJ-<site>-<acces>-<cible>.THHMMSSZ.json.gz   une tranche (heure UTC de début)
#   AAAA-MM-JJ-<site>-<acces>.sonde.log                  journal des événements
# Le Burkina Faso est en UTC+0 sans heure d'été : heure UTC = heure locale.

set -u

SITE="" ACCES="" CIBLES="" DOSSIER="" INTERVALLE="200ms" TRANCHE=900 LONGUEUR=0 HEURES=0 DUREE_S=0 EXTRA="" FIN_ABS=""
OUVERTURE="2s,2s,2s,2s" ATTENTE_NTP=900

usage() { sed -n '2,50p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

while getopts "s:a:c:o:i:t:l:F:H:D:O:N:X:h" opt; do
  case "$opt" in
    s) SITE="$OPTARG" ;;
    a) ACCES="$OPTARG" ;;
    c) CIBLES="$OPTARG" ;;
    o) DOSSIER="$OPTARG" ;;
    i) INTERVALLE="$OPTARG" ;;
    t) TRANCHE="$OPTARG" ;;
    l) LONGUEUR="$OPTARG" ;;
    H) HEURES="$OPTARG" ;;
    D) DUREE_S="$OPTARG" ;;
    F) FIN_ABS="$OPTARG" ;;
    O) OUVERTURE="$OPTARG" ;;
    N) ATTENTE_NTP="$OPTARG" ;;
    X) EXTRA="$OPTARG" ;;
    *) usage ;;
  esac
done

[ -n "$SITE" ] && [ -n "$ACCES" ] && [ -n "$CIBLES" ] && [ -n "$DOSSIER" ] || usage
[[ "$SITE" =~ ^[a-z0-9]+$ ]] || { echo "SITE : [a-z0-9] seulement" >&2; exit 2; }
[[ "$ACCES" =~ ^[a-z0-9]+$ ]] || { echo "ACCES : [a-z0-9] seulement" >&2; exit 2; }
[[ "$TRANCHE" =~ ^[0-9]+$ ]] && [ "$TRANCHE" -ge 60 ] && [ "$TRANCHE" -le 1200 ] \
  || { echo "-t : entier de 60 à 1200 (plafond : --timeout=20m du serveur irtt)" >&2; exit 2; }
[[ "$ATTENTE_NTP" =~ ^[0-9]+$ ]] || { echo "-N : entier" >&2; exit 2; }
[[ "$OUVERTURE" =~ ^[0-9a-z.,]+$ ]] || { echo "-O : liste de durées, ex. 2s,2s,2s,2s" >&2; exit 2; }
[ -r "$CIBLES" ] || { echo "fichier de cibles illisible : $CIBLES" >&2; exit 2; }
command -v irtt >/dev/null || { echo "irtt absent (apt-get install irtt)" >&2; exit 3; }

mkdir -p "$DOSSIER/en-cours" || exit 3
JOURNAL="$DOSSIER/$(date -u +%Y-%m-%d)-$SITE-$ACCES.sonde.log"

FIN_GLOBALE=0
[[ "$HEURES" =~ ^[0-9]+$ && "$DUREE_S" =~ ^[0-9]+$ ]] || { echo "-H / -D : entiers" >&2; exit 2; }
if [ -n "$FIN_ABS" ]; then
  FIN_GLOBALE=$(date -u -d "$FIN_ABS" +%s) || { echo "-F : date invalide" >&2; exit 2; }
  [ "$FIN_GLOBALE" -gt "$(date -u +%s)" ] || { echo "-F : date déjà passée" >&2; exit 4; }
elif [ "$DUREE_S" -gt 0 ]; then
  FIN_GLOBALE=$(( $(date -u +%s) + DUREE_S ))
elif [ "$HEURES" -gt 0 ]; then
  FIN_GLOBALE=$(( $(date -u +%s) + HEURES * 3600 ))
fi

# Une ligne par événement : horodatage UTC ISO, epoch, événement, détails clé=valeur.
log() {
  local now; now=$(date -u +%s)
  printf '%s epoch=%s %s\n' "$(date -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ)" "$now" "$*" >> "$JOURNAL"
}

# Fichiers laissés dans en-cours/ par un arrêt brutal (coupure de courant pendant l'écriture).
for f in "$DOSSIER"/en-cours/*; do
  [ -e "$f" ] || continue
  log "tranche_orpheline fichier=$(basename "$f")"
  mv -f "$f" "$DOSSIER/$(basename "$f").orphelin"
done

DISPO_UPTIME=$(cut -d' ' -f1 /proc/uptime 2>/dev/null || echo "?")
# Horloge : après une coupure de courant, un Raspberry Pi sans horloge matérielle
# repart à l'heure de son dernier arrêt (fake-hwclock). On attend NTP avant la
# première tranche, pour que les noms de tranche et le classement par heure soient
# justes. analyse.py suit de toute façon l'horloge monotone d'irtt à l'intérieur
# d'une tranche et signale les sauts.
ntp_etat() { timedatectl show -p NTPSynchronized --value 2>/dev/null || echo "inconnu"; }
NTP=$(ntp_etat)
if [ "$NTP" = "no" ] && [ "$ATTENTE_NTP" -gt 0 ]; then
  log "ntp_attente max_s=$ATTENTE_NTP"
  attendu=0
  while [ "$attendu" -lt "$ATTENTE_NTP" ]; do
    sleep 5; attendu=$(( attendu + 5 ))
    NTP=$(ntp_etat); [ "$NTP" = "yes" ] && break
  done
  log "ntp_fin_attente attendu_s=$attendu ntp_synchronise=$NTP"
fi
log "demarrage site=$SITE acces=$ACCES intervalle=$INTERVALLE tranche=${TRANCHE}s longueur=$LONGUEUR extra=${EXTRA// /_} uptime_s=$DISPO_UPTIME fin_prevue=$FIN_GLOBALE ntp_synchronise=$NTP irtt=$(irtt version 2>/dev/null | head -1 | awk '{print $NF}') hote=$(hostname)"

boucle_cible() {
  local nom="$1" hote="$2" pid="" fichier="" base=""
  arreter() {
    # Vérifié en local : irtt qui reçoit DEUX signaux différents presque en même
    # temps (SIGTERM de systemd au groupe, puis notre SIGINT) sort avec le code 3
    # SANS écrire sa tranche. Donc : on ignore les signaux suivants, on laisse
    # d'abord à irtt 2 s pour finir seul (cas où il a reçu le signal du groupe),
    # et on ne lui envoie SIGINT que s'il tourne encore (cas KillMode=mixed).
    trap '' TERM INT
    if [ -n "$pid" ]; then
      local k
      for k in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
      kill -INT "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
    fi
    if [ -n "$fichier" ] && [ -s "$DOSSIER/en-cours/$fichier" ]; then
      mv -f "$DOSSIER/en-cours/$fichier" "$DOSSIER/$fichier"
      log "tranche_ok cible=$nom fichier=$fichier interrompue=oui"
    fi
    exit 0
  }
  trap arreter TERM INT
  while :; do
    local now fin d rc t_debut
    now=$(date -u +%s)
    if [ "$FIN_GLOBALE" -gt 0 ] && [ "$now" -ge "$FIN_GLOBALE" ]; then
      log "fin_programmee cible=$nom"; return 0
    fi
    fin=$(( (now / TRANCHE + 1) * TRANCHE ))
    [ $(( fin - now )) -lt 30 ] && fin=$(( fin + TRANCHE ))
    [ "$FIN_GLOBALE" -gt 0 ] && [ "$fin" -gt "$FIN_GLOBALE" ] && fin=$FIN_GLOBALE
    d=$(( fin - now ))
    base="$(date -u -d "@$now" +%Y-%m-%d)-$SITE-$ACCES-$nom.T$(date -u -d "@$now" +%H%M%S)Z"
    fichier="$base.json.gz"
    t_debut=$now
    # shellcheck disable=SC2086  # EXTRA est volontairement découpé en mots
    irtt client -Q -i "$INTERVALLE" -l "$LONGUEUR" -d "${d}s" --timeouts="$OUVERTURE" $EXTRA \
      -o "$DOSSIER/en-cours/$fichier" "$hote" 2>>"$DOSSIER/en-cours/.$nom.err" &
    pid=$!
    wait "$pid"; rc=$?
    pid=""
    if [ -s "$DOSSIER/en-cours/$fichier" ]; then
      mv -f "$DOSSIER/en-cours/$fichier" "$DOSSIER/$fichier"
      # irtt s'arrête avec le code 0 sur une erreur d'envoi (interface tombée,
      # « network is unreachable ») : vérifié en local. Le champ send_err du JSON
      # est alors un objet NON vide (il vaut {} après un SIGTERM, et il est absent
      # après une fin normale) ; on le recopie dans le journal.
      local se=non
      zcat -f "$DOSSIER/$fichier" 2>/dev/null | grep -q '"send_err": {$' && se=oui
      log "tranche_ok cible=$nom fichier=$fichier rc=$rc send_err=$se"
    else
      rm -f "$DOSSIER/en-cours/$fichier"
      local err; err=$(tail -1 "$DOSSIER/en-cours/.$nom.err" 2>/dev/null | tr ' ' '_' | cut -c1-160)
      sleep 1
      # Fenêtre sans mesure possible : l'analyse la compte comme indisponibilité.
      log "echec_ouverture cible=$nom debut=$t_debut fin=$(date -u +%s) rc=$rc erreur=$err"
    fi
    fichier=""
  done
}

PIDS=()
while read -r nom hote reste; do
  [ -z "${nom:-}" ] && continue
  case "$nom" in \#*) continue ;; esac
  [[ "$nom" =~ ^[a-z0-9-]+$ ]] || { log "cible_ignoree nom=$nom raison=nom_invalide"; continue; }
  [ -n "${hote:-}" ] || { log "cible_ignoree nom=$nom raison=hote_absent"; continue; }
  boucle_cible "$nom" "$hote" &
  PIDS+=("$!")
  log "cible_lancee cible=$nom hote=$hote pid=$!"
done < "$CIBLES"

[ "${#PIDS[@]}" -gt 0 ] || { log "aucune_cible"; echo "aucune cible valide dans $CIBLES" >&2; exit 2; }

fin_sonde() {
  log "arret_demande"
  kill -TERM "${PIDS[@]}" 2>/dev/null
  wait
  log "arret"
  exit 0
}
trap fin_sonde TERM INT

wait
log "arret fin_programmee=oui"
