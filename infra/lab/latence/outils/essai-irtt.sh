#!/usr/bin/env bash
# essai-irtt.sh — deux comportements d'irtt 0.9.0 dont dépendent sonde.sh et analyse.py.
#   1. Signaux : quelle combinaison de SIGTERM / SIGINT laisse irtt écrire sa tranche ?
#   2. Interface tombée : irtt s'arrête-t-il, avec quel code, et que contient send_err ?
# Usage (root) : outils/essai-irtt.sh > evidence/irtt-essais.txt
# Nettoie ses espaces de noms et ses processus à la fin.
set -u
TMP="$(mktemp -d)"
nettoyer() { [ -n "${SP:-}" ] && kill "$SP" 2>/dev/null; ip netns del wkl-ea 2>/dev/null; ip netns del wkl-eb 2>/dev/null; rm -rf "$TMP"; }
trap nettoyer EXIT
echo "irtt $(irtt version | head -1 | awk '{print $NF}')  $(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "### 1. Signaux (client vers un serveur local, -i 100ms -d 20s, signaux envoyés 2 s après le départ)"
irtt server -b 127.0.0.1:2196 >/dev/null 2>&1 & SP=$!
sleep 0.3
python3 - "$TMP" <<'EOF'
import os, signal, subprocess, sys, time
d = sys.argv[1]
cas = [("TERM seul", [signal.SIGTERM], 0), ("INT seul", [signal.SIGINT], 0),
       ("TERM puis INT, aussitôt", [signal.SIGTERM, signal.SIGINT], 0),
       ("INT puis TERM, aussitôt", [signal.SIGINT, signal.SIGTERM], 0),
       ("TERM puis INT, 50 ms après", [signal.SIGTERM, signal.SIGINT], 0.05),
       ("TERM puis TERM, aussitôt", [signal.SIGTERM, signal.SIGTERM], 0)]
for nom, sigs, pause in cas:
    f = os.path.join(d, "t.json.gz")
    if os.path.exists(f):
        os.remove(f)
    p = subprocess.Popen(["irtt", "client", "-Q", "-i", "100ms", "-d", "20s", "-o", f, "127.0.0.1:2196"])
    time.sleep(2)
    for s in sigs:
        p.send_signal(s)
        if pause:
            time.sleep(pause)
    rc = p.wait()
    print(f"{nom:28s} code {rc}  tranche écrite : {'oui' if os.path.exists(f) else 'NON'}")
EOF
kill "$SP"; SP=""

echo "### 2. Interface de la sonde tombée pendant une tranche (veth down 4 s, 3 s après le départ)"
ip netns add wkl-ea; ip netns add wkl-eb
ip link add wkl-ea0 type veth peer name wkl-eb0
ip link set wkl-ea0 netns wkl-ea; ip link set wkl-eb0 netns wkl-eb
ip -n wkl-ea addr add 10.88.0.1/24 dev wkl-ea0; ip -n wkl-eb addr add 10.88.0.2/24 dev wkl-eb0
ip -n wkl-ea link set wkl-ea0 up; ip -n wkl-eb link set wkl-eb0 up
ip netns exec wkl-eb irtt server -b 0.0.0.0:2112 --timeout=20m >/dev/null 2>&1 & SP=$!
sleep 0.5
ip netns exec wkl-ea irtt client -i 200ms -d 12s -o "$TMP/panne.json" 10.88.0.2:2112 > "$TMP/client.txt" 2>&1 &
CP=$!
sleep 3; ip -n wkl-ea link set wkl-ea0 down; sleep 4; ip -n wkl-ea link set wkl-ea0 up
wait "$CP"; echo "code de sortie d'irtt : $?"
grep -i "terminated\|error" "$TMP/client.txt"
python3 - "$TMP/panne.json" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
print("durée demandée", d["config"]["params"]["duration"] / 1e9, "s ; durée réelle", round(d["stats"]["duration"] / 1e9, 2), "s ;",
      len(d["round_trips"]), "paquets ;", sum(1 for r in d["round_trips"] if r["lost"] != "false"), "perdus")
print("send_err :", json.dumps(d.get("send_err")))
EOF
