#!/usr/bin/env bash
# =====================================================================
# WAKATNET — labo FreeRADIUS côté serveur (L1 à L6).
# Recrée tout (cluster PostgreSQL dédié, espaces de noms réseau qui
# simulent les routeurs, raddb de labo) puis lance tous les tests.
# Idempotent. Sort en code non nul si un test attendu échoue.
#
# Usage (root, Ubuntu 24.04) :  sudo ./run-lab.sh
# Variables : LAB_WORKDIR (défaut /var/tmp/wakatnet-lab-freeradius)
#             LAB_PG_PORT (défaut 55432)  LAB_KEEP=1 (ne pas démonter à la fin)
# Valeurs de labo uniquement ("secret-labo-01"...). Aucun secret réel.
# =====================================================================
set -Eeuo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
W="${LAB_WORKDIR:-/var/tmp/wakatnet-lab-freeradius}"
PG_PORT="${LAB_PG_PORT:-55432}"
PG_VER=16
PG_CLUSTER=wklab
EVID="$LAB_DIR/evidence"
RADIUS_PW="radius-labo-mdp"           # mot de passe de labo du rôle wk_radius
SERVER_IP=10.213.0.1
RADIUSD_PID=""
FAILS=0
SUMMARY="$EVID/00-summary.log"

# ---------------------------------------------------------------- outils
log()  { printf '[%s] %s\n' "$(date +%T)" "$*" | tee -a "$SUMMARY"; }
pass() { log "PASS  $*"; }
fail() { log "FAIL  $*"; FAILS=$((FAILS + 1)); }
obs()  { log "OBS   $*"; }
die()  { log "FATAL $*"; exit 2; }

need_root() { [ "$(id -u)" -eq 0 ] || die "lancer en root (sudo)"; }

install_deps() {
	local missing=()
	for c in freeradius radclient psql pg_createcluster ip; do
		command -v "$c" >/dev/null 2>&1 || missing+=("$c")
	done
	if [ "${#missing[@]}" -gt 0 ]; then
		log "installation apt (manquants : ${missing[*]})"
		for i in $(seq 1 30); do
			if DEBIAN_FRONTEND=noninteractive apt-get install -y \
				freeradius freeradius-postgresql freeradius-utils postgresql iproute2 >/dev/null 2>&1; then
				break
			fi
			log "apt occupé, nouvel essai dans 10 s ($i/30)"; sleep 10
		done
	fi
	for c in freeradius radclient psql pg_createcluster ip; do
		command -v "$c" >/dev/null 2>&1 || die "commande absente : $c"
	done
}

# ---------------------------------------------------------------- PostgreSQL
pg() { runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -p "$PG_PORT" "$@"; }

setup_pg() {
	if pg_lsclusters -h | awk '{print $1" "$2}' | grep -qx "$PG_VER $PG_CLUSTER"; then
		pg_dropcluster --stop "$PG_VER" "$PG_CLUSTER"
	fi
	pg_createcluster "$PG_VER" "$PG_CLUSTER" -p "$PG_PORT" >/dev/null
	pg_ctlcluster "$PG_VER" "$PG_CLUSTER" start
	pg -d postgres -c "CREATE DATABASE wakatnet_lab"
	pg -d wakatnet_lab -v radius_pw="$RADIUS_PW" < "$LAB_DIR/sql/00-schema.sql"
	pg -d wakatnet_lab < "$LAB_DIR/sql/10-seed.sql"
}
pg_stop()  { pg_ctlcluster "$PG_VER" "$PG_CLUSTER" stop -m fast; }
pg_start() { pg_ctlcluster "$PG_VER" "$PG_CLUSTER" start; }

# ---------------------------------------------------------------- réseau
# Un pont "wkbr0" porte l'IP overlay du nœud (10.213.0.1/16) ; chaque
# routeur simulé est un espace de noms réseau avec sa propre IP source.
# radclient n'a pas d'option d'adresse source : l'espace de noms la fixe.
NETNS_LIST="wk-r1:10.213.1.10/16 wk-r2:10.213.1.20/16 wk-r3:10.213.1.30/16 wk-r9:10.213.9.99/16 wk-out:10.99.0.5/24"

teardown_net() {
	local e ns
	for e in $NETNS_LIST; do
		ns="${e%%:*}"
		ip netns del "$ns" 2>/dev/null || true
		ip link del "h-$ns" 2>/dev/null || true
	done
	ip link del wkbr0 2>/dev/null || true
}

setup_net() {
	teardown_net
	ip link add wkbr0 type bridge
	ip addr add "$SERVER_IP/16" dev wkbr0
	ip addr add 10.99.0.1/24 dev wkbr0
	ip link set wkbr0 up
	local e ns addr
	for e in $NETNS_LIST; do
		ns="${e%%:*}"; addr="${e#*:}"
		ip netns add "$ns"
		ip link add "h-$ns" type veth peer name eth0 netns "$ns"
		ip link set "h-$ns" master wkbr0 up
		ip -n "$ns" addr add "$addr" dev eth0
		ip -n "$ns" link set eth0 up
		ip -n "$ns" link set lo up
		case "$ns" in wk-out) ip -n "$ns" route add default via 10.99.0.1 ;; esac
	done
}

# ---------------------------------------------------------------- raddb
# build_raddb VARIANTE LIFETIME BLOCK_REQUIRE_MA ATTR(yes|no|none)
build_raddb() {
	local variant="$1" lifetime="$2" block="$3" attr="$4" attr_line=""
	case "$attr" in
		yes|no) attr_line="				&FreeRADIUS-Client-Require-MA = $attr" ;;
		none)   attr_line="				# FreeRADIUS-Client-Require-MA non positionné (variante $variant)" ;;
	esac
	# Options de variante passées par l'environnement :
	#   POOL_START=0|1 (défaut 1)  SQL_FAIL=reject|do_not_respond (défaut : comportement natif)
	local pool_start="${POOL_START:-1}" sql_call="		sql"
	if [ "${SQL_FAIL:-}" = do_not_respond ]; then
		sql_call="		# Variante L6e : base indisponible -> aucune réponse (le NAS bascule sur son 2e serveur)\n		sql {\n			fail = 1\n		}\n		if (fail) {\n			do_not_respond\n		}"
	fi
	rm -rf "$W/raddb"
	mkdir -p "$W/detail" "$W/secrets"
	cp -a /etc/freeradius/3.0 "$W/raddb"
	local R="$W/raddb"
	find "$R/sites-enabled" "$R/mods-enabled" -mindepth 1 -delete
	for m in always chap pap expr; do ln -s "../mods-available/$m" "$R/mods-enabled/$m"; done
	render() {
		sed -e "s|@LIFETIME@|$lifetime|g" -e "s|@BLOCK_REQUIRE_MA@|$block|g" \
		    -e "s|@VARIANT@|$variant|g" -e "s|@PG_PORT@|$PG_PORT|g" \
		    -e "s|@RADIUS_PW@|$RADIUS_PW|g" -e "s|@WORKDIR@|$W|g" -e "s|@POOL_START@|$pool_start|g" "$1" |
		awk -v l="$attr_line" -v q="$sql_call" '{ if ($0 == "@ATTR_REQUIRE_MA_LINE@") print l; else if ($0 == "@SQL_CALL@") print q; else print }' > "$2"
	}
	render "$LAB_DIR/raddb/clients.conf.in"     "$R/clients.conf"
	render "$LAB_DIR/raddb/mod-sql.in"          "$R/mods-enabled/sql"
	render "$LAB_DIR/raddb/mod-detail_wk.in"    "$R/mods-enabled/detail_wk"
	render "$LAB_DIR/raddb/dynamic-clients.in"  "$R/sites-enabled/dynamic_clients"
	render "$LAB_DIR/raddb/wakatnet.in"         "$R/sites-enabled/wakatnet"
	chown -R freerad:freerad "$W/raddb" "$W/detail"
	chmod 0750 "$W/raddb"
}

start_radiusd() {   # start_radiusd TAG
	local tag="$1" out="$EVID/radiusd-$1.log"
	stop_radiusd
	: > "$out"
	freeradius -X -d "$W/raddb" >"$out" 2>&1 &
	RADIUSD_PID=$!
	for _ in $(seq 1 60); do
		grep -q "Ready to process requests" "$out" && { log "radiusd prêt ($tag, pid $RADIUSD_PID)"; return 0; }
		kill -0 "$RADIUSD_PID" 2>/dev/null || break
		sleep 0.5
	done
	return 1
}
stop_radiusd() {
	if [ -n "$RADIUSD_PID" ] && kill -0 "$RADIUSD_PID" 2>/dev/null; then
		kill "$RADIUSD_PID"; wait "$RADIUSD_PID" 2>/dev/null || true
	fi
	RADIUSD_PID=""
	pkill -f "freeradius -X -d $W/raddb" 2>/dev/null || true
}

# ---------------------------------------------------------------- radclient
put_secret() { mkdir -p "$W/secrets"; chmod 0700 "$W/secrets"; ( umask 077; printf '%s\n' "$2" > "$W/secrets/$1" ); }

# rc NETNS SECRETFILE auth|acct PACKET LOGNAME -> écrit ACCEPT|REJECT|ACCT_RESPONSE|NOREPLY|INVALID
rc() {
	local ns="$1" sec="$2" kind="$3" pkt="$4" name="$5" port=1812 out
	[ "$kind" = acct ] && port=1813
	out="$EVID/$name.log"
	{
		echo "# $(date --iso-8601=seconds) netns=$ns ($(ip -n "$ns" -4 -br addr show eth0 | awk '{print $3}')) -> $SERVER_IP:$port $kind paquet=$(basename "$pkt") secret=$sec"
		local ec=0
		ip netns exec "$ns" radclient -x -r 2 -t 2 -S "$W/secrets/$sec" -f "$pkt" "$SERVER_IP:$port" "$kind" 2>&1 || ec=$?
		echo "  (code de sortie radclient = $ec)"
	} >> "$out"
	classify "$out"
}

# Classe le DERNIER échange d'un fichier de log (bloc qui commence par "# ").
classify() {
	local last
	last=$(awk '/^# /{buf=""} {buf=buf $0 "\n"} END{printf "%s", buf}' "$1")
	if   grep -q "Received Access-Accept"       <<<"$last"; then echo ACCEPT
	elif grep -q "Received Access-Reject"       <<<"$last"; then echo REJECT
	elif grep -q "Received Accounting-Response" <<<"$last"; then echo ACCT_RESPONSE
	elif grep -q "No reply from server"         <<<"$last"; then echo NOREPLY
	# radclient 3.2.5 n'imprime parfois pas "No reply" (observé une fois en L6e) : paquet(s) envoyé(s), rien reçu.
	elif grep -q "^Sent " <<<"$last" && ! grep -q "^Received" <<<"$last"; then echo NOREPLY
	elif grep -qi "invalid Response Authenticator\|invalid signature" <<<"$last"; then echo INVALID
	else echo UNKNOWN; fi
}

# rr NETNS SECRETFILE ma|noma LOGNAME : Access-Request CHAP par tools/radreq.py
# (radclient 3.2.5 ajoute toujours un Message-Authenticator : inutilisable pour T10).
rr() {
	local ns="$1" sec="$2" mode="$3" name="$4" out flag=""
	out="$EVID/$name.log"
	[ "$mode" = noma ] && flag="--no-ma"
	{
		echo "# $(date --iso-8601=seconds) netns=$ns ($(ip -n "$ns" -4 -br addr show eth0 | awk '{print $3}')) -> $SERVER_IP:1812 radreq.py mode=$mode secret=$sec"
		ip netns exec "$ns" python3 -I "$LAB_DIR/tools/radreq.py" --server "$SERVER_IP" --port 1812 \
			--secret-file "$W/secrets/$sec" --user TICKETLAB1 --chap-password mdp-ticket-labo \
			--nas-identifier "$ns" $flag --timeout 2 --retries 2 2>&1 || true
	} >> "$out"
	classify "$out"
}

expect() {  # expect LABEL ATTENDU OBTENU
	if [ "$2" = "$3" ]; then pass "$1 : $3"; else fail "$1 : attendu $2, obtenu $3"; fi
}

P="$LAB_DIR/packets"

# =====================================================================
main() {
	need_root
	mkdir -p "$EVID"
	rm -f "$EVID"/*.log
	: > "$SUMMARY"
	install_deps
	stop_radiusd
	rm -rf "$W"; mkdir -p "$W"
	log "FreeRADIUS : $(freeradius -v 2>/dev/null | head -1)"
	log "radclient  : $(radclient -v 2>/dev/null | head -1)"
	log "PostgreSQL : $(psql --version)"
	log "Noyau      : $(uname -r)"

	setup_pg
	setup_net
	put_secret r1-old secret-labo-01
	put_secret r1-new secret-labo-01-bis
	put_secret r2     secret-labo-02
	put_secret r3     secret-labo-03
	put_secret r9     secret-labo-99

	# ------------------------------------------------------------ L2
	log "=== L2 : rôle wk_radius limité à EXECUTE sur radius.*"
	PGPASSWORD="$RADIUS_PW" psql -X -h 127.0.0.1 -p "$PG_PORT" -U wk_radius -d wakatnet_lab \
		< "$LAB_DIR/sql/20-l2-privileges.sql" > "$EVID/L2-psql.log" 2>&1 || true
	local denied
	denied=$(grep -c "ERROR:  permission denied" "$EVID/L2-psql.log" || true)
	expect "L2 nombre d'accès directs refusés (6 attendus)" 6 "$denied"
	grep -q "secret-labo-01 | labo-r1" "$EVID/L2-psql.log" && pass "L2 radius.client_lookup exécutable par wk_radius" \
		|| fail "L2 radius.client_lookup non exécutable"
	grep -q "Cleartext-Password  | :=" "$EVID/L2-psql.log" && pass "L2 radius.authorize exécutable par wk_radius" \
		|| fail "L2 radius.authorize non exécutable"

	# ------------------------------------------------------------ Variante A
	# Bloc yes + attribut FreeRADIUS-Client-Require-MA = yes : configuration retenue.
	build_raddb A 20 yes yes
	start_radiusd A-L1-L3-L5 || die "radiusd ne démarre pas (A)"

	log "=== L3/A : premier paquet SANS Message-Authenticator (client pas encore en cache)"
	expect "L3/A r1 1er paquet sans MA" NOREPLY "$(rr wk-r1 r1-old noma L3-A-r1-noma-first)"
	log "=== L1 : routeurs connus / inconnus"
	expect "L1 r1 (10.213.1.10, actif, son secret) avec MA" ACCEPT "$(rc wk-r1 r1-old auth "$P/auth-chap-ma.txt" L1-r1-known)"
	expect "L1 r2 (10.213.1.20, actif, son secret)"         ACCEPT "$(rc wk-r2 r2 auth "$P/auth-chap-ma.txt" L1-r2-known)"
	expect "L1 r9 (10.213.9.99, inconnu en base)"            NOREPLY "$(rc wk-r9 r9 auth "$P/auth-chap-ma.txt" L1-r9-unknown)"
	expect "L1 r3 (10.213.1.30, en base mais inactif)"       NOREPLY "$(rc wk-r3 r3 auth "$P/auth-chap-ma.txt" L1-r3-inactive)"
	expect "L1 hors overlay (10.99.0.5)"                     NOREPLY "$(rc wk-out r1-old auth "$P/auth-chap-ma.txt" L1-out-of-overlay)"
	local r2bad
	put_secret r2-with-r1 secret-labo-01
	r2bad=$(rc wk-r2 r2-with-r1 auth "$P/auth-chap-ma.txt" L1-r2-with-r1-secret)
	expect "L1 r2 avec le secret de r1 (secret propre à chaque routeur)" NOREPLY "$r2bad"

	log "=== L3/A : client en cache, paquet SANS Message-Authenticator"
	expect "L3/A r1 sans MA (client en cache)" NOREPLY "$(rr wk-r1 r1-old noma L3-A-r1-noma-cached)"
	expect "L3/A r1 avec MA (client en cache)" ACCEPT  "$(rr wk-r1 r1-old ma L3-A-r1-ma-cached)"

	log "=== L5 : authorize SQL jouet + CHAP"
	expect "L5 CHAP bon mot de passe" ACCEPT "$(rc wk-r1 r1-old auth "$P/auth-chap-ma.txt" L5-chap-ok)"
	grep -q 'Session-Timeout = 3600' "$EVID/L5-chap-ok.log" && pass "L5 Session-Timeout = 3600 reçu" || fail "L5 Session-Timeout absent"
	grep -q 'Mikrotik-Rate-Limit = "512k/2M"' "$EVID/L5-chap-ok.log" && pass "L5 Mikrotik-Rate-Limit = 512k/2M reçu" || fail "L5 Mikrotik-Rate-Limit absent"
	grep -q 'Message-Authenticator = 0x' "$EVID/L5-chap-ok.log" && pass "L5 Access-Accept porte un Message-Authenticator" || fail "L5 pas de Message-Authenticator dans la réponse"
	expect "L5 CHAP mauvais mot de passe" REJECT "$(rc wk-r1 r1-old auth "$P/auth-chap-badpw.txt" L5-chap-badpw)"
	expect "L5 ticket inconnu"            REJECT "$(rc wk-r1 r1-old auth "$P/auth-chap-unknown.txt" L5-chap-unknown)"
	grep -q 'Reply-Message = "ticket_inconnu"' "$EVID/L5-chap-unknown.log" && pass "L5 Reply-Message ticket_inconnu" || fail "L5 Reply-Message absent"
	stop_radiusd

	# ------------------------------------------------------------ L3 variantes observées
	local v
	for v in "B yes none" "C auto none" "D auto yes" "E no yes"; do
		set -- $v
		build_raddb "$1" 20 "$2" "$3"
		start_radiusd "L3-$1" || die "radiusd ne démarre pas ($1)"
		log "=== L3/$1 : bloc require_message_authenticator=$2, FreeRADIUS-Client-Require-MA=$3"
		obs "L3/$1 r1 1er paquet sans MA        -> $(rr wk-r1 r1-old noma "L3-$1-r1-noma-first")"
		obs "L3/$1 r1 avec MA                   -> $(rr wk-r1 r1-old ma   "L3-$1-r1-ma")"
		obs "L3/$1 r1 sans MA (client en cache) -> $(rr wk-r1 r1-old noma "L3-$1-r1-noma-cached")"
		obs "L3/$1 r2 1er paquet AVEC MA        -> $(rr wk-r2 r2 ma   "L3-$1-r2-ma-first")"
		obs "L3/$1 r2 puis sans MA              -> $(rr wk-r2 r2 noma "L3-$1-r2-noma-after")"
		stop_radiusd
	done

	# ------------------------------------------------------------ L4
	log "=== L4 : durée de vie du cache (lifetime = 20 s)"
	build_raddb A 20 yes yes
	start_radiusd A-L4 || die "radiusd ne démarre pas (L4)"
	local t0
	t0=$(date +%s)
	expect "L4 t0 r1 ancien secret" ACCEPT "$(rc wk-r1 r1-old auth "$P/auth-chap-ma.txt" L4-01-t0-r1-old)"
	expect "L4 t0 r2"               ACCEPT "$(rc wk-r2 r2 auth "$P/auth-chap-ma.txt" L4-02-t0-r2)"
	pg -d wakatnet_lab -c "SET ROLE wk_owner; UPDATE app.routers SET radius_secret='secret-labo-01-bis' WHERE shortname='labo-r1'; UPDATE app.routers SET active=false WHERE shortname='labo-r2'; SELECT shortname, active, now() FROM app.routers ORDER BY 1" > "$EVID/L4-psql-update.log" 2>&1
	log "L4 base modifiée à t0+$(( $(date +%s) - t0 ))s : secret r1 changé, r2 désactivé"
	expect "L4 avant expiration : r1 ancien secret encore accepté" ACCEPT  "$(rc wk-r1 r1-old auth "$P/auth-chap-ma.txt" L4-03-before-r1-old)"
	expect "L4 avant expiration : r1 nouveau secret refusé"        NOREPLY "$(rc wk-r1 r1-new auth "$P/auth-chap-ma.txt" L4-04-before-r1-new)"
	expect "L4 avant expiration : r2 désactivé encore servi (client en cache ; Reject par authorize qui teste active)" REJECT "$(rc wk-r2 r2 auth "$P/auth-chap-ma.txt" L4-05-before-r2)"
	local wait_s=$(( t0 + 20 + 3 - $(date +%s) ))
	[ "$wait_s" -gt 0 ] && { log "L4 attente $wait_s s (expiration du cache)"; sleep "$wait_s"; }
	log "L4 après expiration (t0+$(( $(date +%s) - t0 ))s)"
	expect "L4 après expiration : r1 ancien secret refusé"   NOREPLY "$(rc wk-r1 r1-old auth "$P/auth-chap-ma.txt" L4-06-after-r1-old)"
	expect "L4 après expiration : r1 nouveau secret accepté" ACCEPT  "$(rc wk-r1 r1-new auth "$P/auth-chap-ma.txt" L4-07-after-r1-new)"
	expect "L4 après expiration : r2 désactivé ignoré"       NOREPLY "$(rc wk-r2 r2 auth "$P/auth-chap-ma.txt" L4-08-after-r2)"
	stop_radiusd
	pg -d wakatnet_lab -c "SET ROLE wk_owner; UPDATE app.routers SET radius_secret='secret-labo-01' WHERE shortname='labo-r1'; UPDATE app.routers SET active=true WHERE shortname='labo-r2'"

	# ------------------------------------------------------------ L6
	log "=== L6 : PostgreSQL arrêté"
	rm -f "$W"/detail/*
	build_raddb A 300 yes yes
	start_radiusd A-L6 || die "radiusd ne démarre pas (L6)"
	expect "L6 base OK : auth r1"         ACCEPT        "$(rc wk-r1 r1-old auth "$P/auth-chap-ma.txt" L6-01-pg-up-auth)"
	expect "L6 base OK : Accounting-Start" ACCT_RESPONSE "$(rc wk-r1 r1-old acct "$P/acct-start.txt" L6-02-pg-up-acct-start)"
	pg_stop
	log "L6 PostgreSQL arrêté ($(pg_lsclusters -h | awk -v c=$PG_CLUSTER '$2==c{print $4}'))"
	local t1 t2
	t1=$(date +%s.%N)
	expect "L6 base ARRÊTÉE : Accounting-Interim répondu" ACCT_RESPONSE "$(rc wk-r1 r1-old acct "$P/acct-interim.txt" L6-03-pg-down-acct-interim)"
	t2=$(date +%s.%N); log "L6 durée de l'échange accounting base arrêtée : $(echo "$t2 - $t1" | bc 2>/dev/null || echo '?') s"
	t1=$(date +%s.%N)
	obs "L6 base ARRÊTÉE : auth r1 (client en cache) -> $(rc wk-r1 r1-old auth "$P/auth-chap-ma.txt" L6-04-pg-down-auth-cached)"
	t2=$(date +%s.%N); log "L6 durée de l'échange auth base arrêtée : $(echo "$t2 - $t1" | bc 2>/dev/null || echo '?') s"
	obs "L6 base ARRÊTÉE : auth r2 (jamais vu, recherche client impossible) -> $(rc wk-r2 r2 auth "$P/auth-chap-ma.txt" L6-05-pg-down-auth-new-client)"
	ls -l "$W/detail" > "$EVID/L6-detail-files.log"; cat "$W"/detail/* >> "$EVID/L6-detail-files.log"
	grep -q "Interim-Update" "$EVID/L6-detail-files.log" && pass "L6 Interim écrit dans le fichier detail pendant la panne" \
		|| fail "L6 Interim absent du fichier detail"
	pg_start
	sleep 6   # > retry_delay (5 s) du pool rlm_sql
	expect "L6 base redémarrée : auth r1" ACCEPT "$(rc wk-r1 r1-old auth "$P/auth-chap-ma.txt" L6-06-pg-back-auth)"
	stop_radiusd

	log "=== L6c : démarrage de radiusd avec PostgreSQL déjà arrêté"
	pg_stop
	if start_radiusd A-L6c-start-pg-down; then
		obs "L6c radiusd démarre sans base"
		obs "L6c auth r1 (client jamais vu) -> $(rc wk-r1 r1-old auth "$P/auth-chap-ma.txt" L6c-auth)"
	else
		obs "L6c radiusd REFUSE de démarrer sans base (voir radiusd-A-L6c-start-pg-down.log)"
	fi
	stop_radiusd

	log "=== L6d : même chose avec pool { start = 0 }"
	POOL_START=0 build_raddb A 300 yes yes
	if start_radiusd A-L6d-start0-pg-down; then
		obs "L6d radiusd démarre sans base (start = 0)"
		obs "L6d auth r1 (client jamais vu, base arrêtée) -> $(rc wk-r1 r1-old auth "$P/auth-chap-ma.txt" L6d-auth)"
	else
		obs "L6d radiusd REFUSE de démarrer sans base même avec start = 0"
	fi
	stop_radiusd
	pg_start

	log "=== L6e : variante « base en panne -> pas de réponse » (sql { fail = 1 } + do_not_respond)"
	SQL_FAIL=do_not_respond build_raddb A 300 yes yes
	start_radiusd A-L6e-do-not-respond || die "radiusd ne démarre pas (L6e)"
	expect "L6e base OK : auth r1" ACCEPT "$(rc wk-r1 r1-old auth "$P/auth-chap-ma.txt" L6e-01-pg-up-auth)"
	pg_stop
	expect "L6e base ARRÊTÉE : auth r1 (client en cache) -> aucune réponse" NOREPLY "$(rc wk-r1 r1-old auth "$P/auth-chap-ma.txt" L6e-02-pg-down-auth)"
	expect "L6e base ARRÊTÉE : accounting toujours répondu" ACCT_RESPONSE "$(rc wk-r1 r1-old acct "$P/acct-interim.txt" L6e-03-pg-down-acct)"
	pg_start
	sleep 6
	expect "L6e base redémarrée : auth r1" ACCEPT "$(rc wk-r1 r1-old auth "$P/auth-chap-ma.txt" L6e-04-pg-back-auth)"
	stop_radiusd

	# ------------------------------------------------------------ fin
	{
		echo "# Lignes clés extraites des journaux radiusd -X (fichier : numéro de ligne : texte)"
		grep -n -H -E "Adding client|Ignoring request|Dropping packet|Insecure packet|BlastRADIUS check|creating dynamic client failed|Instantiation failed|Error getting check|Sent Access-(Accept|Reject)|Sent Accounting-Response|Not sending reply|FreeRADIUS-Client-Require-MA|^\s+require_message_authenticator|lifetime =" \
			"$EVID"/radiusd-*.log | sed "s|$EVID/||"
	} > "$EVID/01-key-lines.log"
	if [ "${LAB_KEEP:-0}" != 1 ]; then
		teardown_net
		pg_dropcluster --stop "$PG_VER" "$PG_CLUSTER" || true
	fi
	log "=== Résultat : $FAILS échec(s)"
	[ "$FAILS" -eq 0 ]
}

trap 'stop_radiusd' EXIT
main "$@"
