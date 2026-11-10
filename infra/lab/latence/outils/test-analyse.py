#!/usr/bin/env python3
"""test-analyse.py — vérifie analyse.py sur des captures synthétiques aux valeurs connues.

Les fichiers imitent le format JSON d'irtt 0.9.0 (json_format 1), réduit aux
champs que lit analyse.py, avec la structure relevée sur une vraie sortie
d'irtt : round_trips[].lost = "false" | "true" | "true_up" | "true_down",
timestamps.client.send.wall et .monotonic en ns, delay.rtt en ns, send_err.
Chaque jeu est analysé séparément ; les valeurs attendues sont calculées à la
main dans les commentaires. Les jeux J1 à J6 reprennent ceux de la relecture
adversariale du 10/11/2026 (fabrique.py du relecteur), avec les valeurs
attendues APRÈS correction.

Code de sortie 0 si tout est conforme.
"""

import csv
import gzip
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile

ICI = os.path.dirname(os.path.abspath(__file__))
ANALYSE = os.path.join(ICI, "..", "analyse.py")
NS = 1_000_000_000
MS = 1_000_000
T0 = 1794337200 * NS  # 2026-11-10T19:00:00Z
IV = 200 * MS
echecs = []


def capture(dossier, nom, n, perdus=(), rtt=lambda i: 100 * MS, debut=T0, iv=IV, duree=None, duree_reelle=None,
            saut=None, send_err=None):
    """Écrit une tranche. saut=(i, delta_ns) : l'horloge murale saute de delta à partir du paquet i."""
    rts = []
    for i in range(n):
        mono = 5 * NS + i * iv
        wall = debut + i * iv + (saut[1] if saut and i >= saut[0] else 0)
        ts = {"client": {"send": {"wall": wall, "monotonic": mono}, "receive": {}}, "server": {}}
        if i in perdus:
            rts.append({"seqno": i, "lost": "true_up" if i % 2 else "true", "timestamps": ts, "delay": {}, "ipdv": {}})
        else:
            rts.append({"seqno": i, "lost": "false", "timestamps": ts, "delay": {"rtt": rtt(i)}, "ipdv": {}})
    params = {"interval": iv}
    if duree:
        params["duration"] = duree
    stats = {"start_time": "2026-11-10T19:00:00Z"}
    if duree_reelle:
        stats["duration"] = duree_reelle
    d = {"version": {"irtt": "0.9.0", "protocol": 1, "json_format": 1}, "config": {"params": params},
         "stats": stats, "round_trips": rts}
    if send_err is not None:
        d["send_err"] = send_err
    os.makedirs(dossier, exist_ok=True)
    with gzip.open(os.path.join(dossier, nom), "wt") as f:
        json.dump(d, f)


def analyser(dossier, *options):
    sortie = os.path.join(dossier, "resultat")
    subprocess.run([sys.executable, ANALYSE, dossier, "--sortie", sortie, "--bootstrap", "50", *options],
                   check=True, stdout=subprocess.DEVNULL)
    lire = lambda suffixe: list(csv.DictReader(open(sortie + suffixe, encoding="utf-8")))
    return ({r["cible"]: r for r in lire(".csv")},
            {(r["cible_x"], r["cible_y"]): r for r in lire("-correlation.csv")},
            lire("-appariement.csv"), lire("-soirees.csv"))


def verifie(nom, obtenu, attendu, tol=1e-6):
    if isinstance(attendu, str):
        ok = obtenu == attendu
    else:
        ok = obtenu not in ("", None) and abs(float(obtenu) - float(attendu)) <= tol
    print(f"{'PASS' if ok else 'FAIL'} {nom} : obtenu {obtenu!r}, attendu {attendu!r}")
    if not ok:
        echecs.append(nom)


def main():
    racine = tempfile.mkdtemp(prefix="wk-test-analyse-")

    # --- J0 : scénario de base, 3 cibles « a, b, c » (groupes hors Hetzner : toutes témoins).
    # a : paquets 100-174 perdus (75 paquets = 15 s), paquet 500 à 1 500 ms
    # b : paquets 100-124 perdus (5 s), puis 600-609 (2 s) ; c : paquets 100-174 perdus.
    d = os.path.join(racine, "j0")
    capture(d, "2026-11-10-synth-test-a.T190000Z.json.gz", 1000, set(range(100, 175)),
            rtt=lambda i: 1500 * MS if i == 500 else 100 * MS)
    capture(d, "2026-11-10-synth-test-b.T190000Z.json.gz", 1000, set(range(100, 125)) | set(range(600, 610)))
    capture(d, "2026-11-10-synth-test-c.T190000Z.json.gz", 1000, set(range(100, 175)))
    L, C, _, _ = analyser(d, "--temps-serveur-ms", "0", "--timeouts", "1,2", "--essais", "1,2")
    a, b = L["a"], L["b"]
    verifie("J0 a perte % brut", a["perte_pct"], 7.5)
    verifie("J0 a rafale max paquets", a["rafale_max_paquets"], 75)
    verifie("J0 a rafale max s (pertes mesurées)", a["rafale_max_s"], 15.0)
    verifie("J0 a rafale max silence s", a["rafale_max_silence_s"], 15.0)
    verifie("J0 a p50 ms", a["p50"], 100.0)
    verifie("J0 a max ms", a["max"], 1500.0)
    verifie("J0 a perte montante", a["perte_montante"], 37)
    verifie("J0 a brut échec K=1 T=1 s %", a["brut_echec_k1_t1.0s_pct"], 7.6)     # 75 perdus + 1 lent / 1000
    verifie("J0 a brut échec K=1 T=2 s %", a["brut_echec_k1_t2.0s_pct"], 7.5)
    verifie("J0 a brut échec K=2 T=1 s %", a["brut_echec_k2_t1.0s_pct"], 7.0)     # départs 100-169 / 1000
    verifie("J0 a rafales >= 10 s", a["rafales_10s"], 1)
    verifie("J0 b rafale max s", b["rafale_max_s"], 5.0)
    verifie("J0 b rafales >= 1 s", b["rafales_1s"], 2)
    verifie("J0 a panne locale s (a, b, c muets : paquets 100-124)", a["panne_locale_s"], 5)
    verifie("J0 a HL envoyés (1000 - 25)", a["hl_envoyes"], 975)
    verifie("J0 a HL perte % (50 / 975)", a["hl_perte_pct"], round(100 * 50 / 975, 3), 1e-3)
    verifie("J0 a HL échec K=1 T=1 s % (51 / 975)", a["hl_echec_k1_t1.0s_pct"], round(100 * 51 / 975, 4), 1e-4)
    ab = C[("a", "b")]
    verifie("J0 a,b panne a s", ab["panne_x_s"], 15)
    verifie("J0 a,b simultanées s", ab["panne_simultanee_s"], 5)
    verifie("J0 a,b P(b|a) brut %", ab["p_y_sachant_x_pct"], round(100 * 5 / 15, 3), 1e-3)
    verifie("J0 a,b panne locale s", ab["panne_locale_s"], 5)
    verifie("J0 a,b P(b|a) HL % (secondes)", ab["p_y_sachant_x_hors_locale_pct"], 0.0)
    verifie("J0 a,c P(c|a) HL % (secondes)", C[("a", "c")]["p_y_sachant_x_hors_locale_pct"], 100.0)
    verifie("J0 a,b 1 épisode < 10 : indéterminé", ab["p_y_sachant_x_episodes_pct"], "")

    # --- J1 : centiles connus, RTT = 1..1000 ms permutés, aucune perte (rang le plus proche).
    d = os.path.join(racine, "j1")
    random.seed(1)
    vals = list(range(1, 1001))
    random.shuffle(vals)
    capture(d, "2026-11-10-s1-fibre-pct.T190000Z.json.gz", 1000, rtt=lambda i: vals[i] * MS)
    L, _, _, _ = analyser(d, "--temps-serveur-ms", "0")
    r = L["pct"]
    for q, v in (("p50", 500), ("p95", 950), ("p99", 990), ("p999", 999)):
        verifie(f"J1 {q}", r[q], v)

    # --- J2 : centiles effectifs. « lent » : 2 % des paquets à 900 ms ; « perd » : ces 2 % perdus.
    d = os.path.join(racine, "j2")
    lents = set(range(0, 1000, 50))
    capture(d, "2026-11-10-s2-fibre-lent.T190000Z.json.gz", 1000, rtt=lambda i: 900 * MS if i in lents else 100 * MS)
    capture(d, "2026-11-10-s2-fibre-perd.T190000Z.json.gz", 1000, perdus=lents)
    L, _, _, _ = analyser(d)
    verifie("J2 lent p99 reçus", L["lent"]["p99"], 900.0)
    verifie("J2 perd p99 reçus (le survivant paraît meilleur)", L["perd"]["p99"], 100.0)
    verifie("J2 perd p99 effectif = perdu", L["perd"]["p99e"], "inf")
    verifie("J2 perd p95 effectif", L["perd"]["p95e"], 100.0)
    verifie("J2 lent p99 effectif", L["lent"]["p99e"], 900.0)

    # --- J3 : fin anticipée inexpliquée, RTT aberrant de 4 s, VRAIE coupure de 12 s en fin de tranche
    # (paquets 940-999). Fenêtre = min(2 s ; 2 x p99) = 2 x 100 ms = 200 ms -> seul le paquet 999 est
    # retiré ; 59 pertes gardées (11,8 s).
    d = os.path.join(racine, "j3")
    capture(d, "2026-11-10-s3-4g-envol.T190000Z.json.gz", 1000, perdus=set(range(940, 1000)),
            rtt=lambda i: 4000 * MS if i == 10 else 100 * MS, duree=900 * NS, duree_reelle=200 * NS)
    L, _, _, _ = analyser(d)
    r = L["envol"]
    verifie("J3 paquets en vol retirés", r["en_vol_retires"], 1)
    verifie("J3 rafale max paquets", r["rafale_max_paquets"], 59)
    verifie("J3 rafale max s", r["rafale_max_s"], 11.8)
    verifie("J3 fin anticipée inexpliquée signalée", r["fin_inexpliquee"], 1)
    # J3b : même tranche, marquée interrompue=oui par sonde.sh (SIGTERM) -> même retrait, cause « sigterm ».
    d = os.path.join(racine, "j3b")
    nom = "2026-11-10-s3-4g-envol.T190000Z.json.gz"
    capture(d, nom, 1000, perdus=set(range(940, 1000)), rtt=lambda i: 4000 * MS if i == 10 else 100 * MS,
            duree=900 * NS, duree_reelle=200 * NS)
    with open(os.path.join(d, "2026-11-10-s3-4g.sonde.log"), "w", encoding="utf-8") as f:
        f.write(f"2026-11-10T19:03:20Z epoch=1794337400 tranche_ok cible=envol fichier={nom} interrompue=oui\n")
    L, _, _, _ = analyser(d)
    verifie("J3b cause SIGTERM", L["envol"]["fin_sigterm"], 1)
    verifie("J3b paquets en vol retirés", L["envol"]["en_vol_retires"], 1)
    # J3c : arrêt sur erreur d'envoi (send_err non vide), aucune perte : cause « erreur_envoi ».
    d = os.path.join(racine, "j3c")
    capture(d, "2026-11-10-s3-4g-err.T190000Z.json.gz", 100, duree=900 * NS, duree_reelle=20 * NS,
            send_err={"Op": "write", "Err": {"Syscall": "write", "Err": 101}})
    L, _, _, _ = analyser(d)
    verifie("J3c cause erreur d'envoi", L["err"]["fin_erreur_envoi"], 1)

    # --- J4 : panne commune aux 3 cibles Hetzner (paquets 200-499 = 60 s), aucune autre cible.
    d = os.path.join(racine, "j4")
    for c in ("fsn-wg", "nbg-wg", "hel-wg"):
        capture(d, f"2026-11-10-s4-fibre-{c}.T190000Z.json.gz", 1000, perdus=set(range(200, 500)))
    L, C, _, _ = analyser(d)
    verifie("J4 sans témoin : P(nbg|fsn) indéterminé", C[("fsn-wg", "nbg-wg")]["statut"],
            "indéterminé : aucun témoin hors Hetzner")
    verifie("J4 sans témoin : HL vide", C[("fsn-wg", "nbg-wg")]["p_y_sachant_x_hors_locale_pct"], "")
    verifie("J4 sans témoin : perte HL = brut (rien retiré)", L["fsn-wg"]["hl_perte_pct"], 30.0)
    # J4b : même panne Hetzner, plus un témoin ref-wg joignable tout du long -> la panne n'est PAS locale.
    d = os.path.join(racine, "j4b")
    for c in ("fsn-wg", "nbg-wg", "hel-wg"):
        capture(d, f"2026-11-10-s4-fibre-{c}.T190000Z.json.gz", 1000, perdus=set(range(200, 500)))
    capture(d, "2026-11-10-s4-fibre-ref-wg.T190000Z.json.gz", 1000)
    L, C, _, _ = analyser(d)
    verifie("J4b panne locale s = 0", C[("fsn-wg", "nbg-wg")]["panne_locale_s"], 0)
    verifie("J4b P(nbg|fsn) HL % (secondes) = 100", C[("fsn-wg", "nbg-wg")]["p_y_sachant_x_hors_locale_pct"], 100.0)
    verifie("J4b 1 épisode : indéterminé", C[("fsn-wg", "nbg-wg")]["statut"], "indéterminé : 1 épisode(s) < 10")
    # J4c : 12 pannes de fsn de 3 s (paquets 100k..100k+14), nbg en panne sur les 6 premières ;
    # plus une panne locale de 5 s (paquets 1300-1324) où tout est muet, témoin compris.
    d = os.path.join(racine, "j4c")
    pf = set(j for k in range(12) for j in range(100 * (k + 1), 100 * (k + 1) + 15))
    pn = set(j for k in range(6) for j in range(100 * (k + 1), 100 * (k + 1) + 15))
    loc = set(range(1300, 1325))
    capture(d, "2026-11-10-s4-fibre-fsn-wg.T190000Z.json.gz", 1500, perdus=pf | loc)
    capture(d, "2026-11-10-s4-fibre-nbg-wg.T190000Z.json.gz", 1500, perdus=pn | loc)
    capture(d, "2026-11-10-s4-fibre-ref-wg.T190000Z.json.gz", 1500, perdus=loc)
    L, C, _, _ = analyser(d)
    c = C[("fsn-wg", "nbg-wg")]
    verifie("J4c panne locale s", c["panne_locale_s"], 5)
    verifie("J4c épisodes de fsn hors locale", c["episodes_x_hors_locale"], 12)
    verifie("J4c P(nbg|fsn) HL en épisodes = 6/12", c["p_y_sachant_x_episodes_pct"], 50.0)
    verifie("J4c P(nbg|fsn) HL en secondes = 18/36", c["p_y_sachant_x_hors_locale_pct"], 50.0)
    verifie("J4c fsn perte HL (180 / 1475)", L["fsn-wg"]["hl_perte_pct"], round(100 * 180 / 1475, 3), 1e-3)

    # --- J5 : perte indépendante 0,5 %, 24 h à 200 ms (432 000 paquets), K = 2, T = 1 s.
    # Contrôle : fausses bascules attendues par jour = % d'échec au pic x 300 (hypothèse par défaut).
    d = os.path.join(racine, "j5")
    random.seed(5)
    n = 432000
    pl = {i for i in range(n) if random.random() < 0.005}
    capture(d, "2026-11-10-s5-fibre-ind.T190000Z.json.gz", n, perdus=pl)
    L, _, _, _ = analyser(d, "--essais", "2", "--timeouts", "1", "--bootstrap", "0")
    r = L["ind"]
    pic = float(r["pic_echec_k2_t1.0s_pct"])
    verifie("J5 bascules/jour = % pic x 300 / 100", r["pic_bascules_jour_k2_t1.0s"], round(pic * 3, 3), 1e-3)
    verifie("J5 bascules/jour < 0,1 malgré des dizaines d'épisodes", float(r["pic_bascules_jour_k2_t1.0s"]) < 0.1, True)

    # --- J6 : réponse tardive. Paquets i%10 == 0 à 1,5 s, paquets i%10 == 5 perdus ; K = 2, T = 1 s, S = 0.
    # Instants évaluables : tous sauf 995 (premier essai perdu, second essai hors capture) : 999.
    # (996-999 réussissent au premier essai : le second n'est pas nécessaire.)
    # Strict : échec si i%10 ∈ {0, 5} -> 100 + 99 = 199 / 999 = 19,92 %.
    # Tardif : i%10 == 0 réussit (0 + 1,5 <= 2) ; i%10 == 5 échoue (1 + 1,5 > 2) -> 99 / 999 = 9,91 %.
    d = os.path.join(racine, "j6")
    capture(d, "2026-11-10-s6-4g-tard.T190000Z.json.gz", 1000, perdus={i for i in range(1000) if i % 10 == 5},
            rtt=lambda i: 1500 * MS if i % 10 == 0 else 100 * MS)
    L, _, _, _ = analyser(d, "--temps-serveur-ms", "0", "--essais", "2", "--timeouts", "1")
    r = L["tard"]
    verifie("J6 strict K=2 T=1 (199/999)", r["pic_echec_k2_t1.0s_pct"], round(100 * 199 / 999, 4), 1e-4)
    verifie("J6 tardif K=2 T=1 (99/999)", r["pic_tardif_k2_t1.0s_pct"], round(100 * 99 / 999, 4), 1e-4)

    # --- J7 : --exclure retire une fenêtre (paquets 100-174 perdus = 19:00:20 à 19:00:35).
    d = os.path.join(racine, "j7")
    capture(d, "2026-11-10-s7-fibre-x.T190000Z.json.gz", 1000, perdus=set(range(100, 175)))
    L, _, _, _ = analyser(d, "--exclure", "2026-11-10T19:00:20Z/2026-11-10T19:00:35Z")
    verifie("J7 --exclure : perte 0", L["x"]["perte_pct"], 0.0)
    verifie("J7 --exclure : 925 envoyés", L["x"]["envoyes"], 925)

    # --- J8 : intervalles mélangés pour une même cible -> deux séries x@200ms et x@500ms.
    d = os.path.join(racine, "j8")
    capture(d, "2026-11-10-s8-4g-x.T190000Z.json.gz", 500)
    capture(d, "2026-11-10-s8-4g-x.T193000Z.json.gz", 200, debut=T0 + 1800 * NS, iv=500 * MS)
    L, _, _, _ = analyser(d)
    verifie("J8 série x@200ms", L.get("x@200ms", {}).get("envoyes"), 500)
    verifie("J8 série x@500ms", L.get("x@500ms", {}).get("envoyes"), 200)

    # --- J9 : saut d'horloge murale de +30 s au paquet 500 (pas de NTP), horloge monotone continue :
    # aucune rafale ni trou, saut signalé.
    d = os.path.join(racine, "j9")
    capture(d, "2026-11-10-s9-fibre-x.T190000Z.json.gz", 1000, saut=(500, 30 * NS))
    L, _, _, _ = analyser(d)
    verifie("J9 saut d'horloge signalé", L["x"]["sauts_horloge"], 1)
    verifie("J9 durée = 200 s (horloge monotone)", L["x"]["duree_h"], round(200 / 3600, 3), 1e-3)
    verifie("J9 couverture 100 %", L["x"]["couverture_pct"], 100.0)

    # --- J10 : deux soirées, comparaison appariée et Q par soirée.
    # fsn-wg : 100 ms ; nbg-wg : 110 ms, 19 h-23 h les 10 et 11/11. La 2e soirée, fsn a 0,2 % de ses
    # paquets à 400 ms (1 sur 500) -> p99.9 soirée 1 = 100, soirée 2 = 400 ; Q = max = 400.
    d = os.path.join(racine, "j10")
    n_soir = 4 * 3600 * 5
    for jj, j0 in enumerate((T0, T0 + 86400 * NS)):
        date = "2026-11-10" if jj == 0 else "2026-11-11"
        capture(d, f"{date}-s10-fibre-fsn-wg.T190000Z.json.gz", n_soir, debut=j0,
                rtt=(lambda i: 400 * MS if i % 500 == 0 else 100 * MS) if jj == 1 else (lambda i: 100 * MS))
        capture(d, f"{date}-s10-fibre-nbg-wg.T190000Z.json.gz", n_soir, debut=j0, rtt=lambda i: 110 * MS)
    L, _, AP, SO = analyser(d, "--essais", "1", "--timeouts", "1")
    ap_ = AP[0]
    verifie("J10 heures comparées", ap_["heures"], 8)
    verifie("J10 verdict apparié", ap_["verdict"], "fsn-wg meilleur")
    q = {(r["cible"], r["soiree"]): r for r in SO}
    verifie("J10 p99.9 fsn soirée 1", q[("fsn-wg", "2026-11-10")]["p999"], 100.0)
    verifie("J10 p99.9 fsn soirée 2", q[("fsn-wg", "2026-11-11")]["p999"], 400.0)
    verifie("J10 IC bootstrap p95e présent", L["fsn-wg"]["pic_p95e_ic90_bas"] != "", True)

    if echecs:
        print(f"dossier gardé pour examen : {racine}")
    else:
        shutil.rmtree(racine, ignore_errors=True)
    print(f"RÉSULTAT : {len(echecs)} échec(s) sur les contrôles ci-dessus :",
          "ÉCHEC " + ", ".join(echecs) if echecs else "tout conforme")
    return 1 if echecs else 0


if __name__ == "__main__":
    sys.exit(main())
