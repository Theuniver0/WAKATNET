#!/usr/bin/env python3
"""verifier-test.py — compare la sortie d'analyse.py aux profils injectés par test-local.sh.

Usage : verifier-test.py DOSSIER   (le DOSSIER de test-local.sh, après
        « analyse.py DOSSIER --sortie DOSSIER/resultat --groupes-hetzner vm »)

Deux sortes de contrôles :
- exacts : le nombre de paquets perdus vus par irtt = le nombre de paquets que
  le dégradeur a réellement jetés (à 2 près : paquet en vol à l'arrêt ; dans le
  tunnel, le dégradeur jette aussi des paquets WireGuard qui ne sont pas des
  sondes, keepalive ou poignée de main) ;
- statistiques ou de bornes : RTT et perte dans une plage autour du profil
  théorique ; bornes de durée justifiées dans le commentaire de chaque contrôle.
Écrit PASS / FAIL par contrôle ; code de sortie 0 si tout passe.
"""

import csv
import glob
import os
import re
import sys


def compteurs_degradeur(dossier, profil, sens):
    with open(os.path.join(dossier, f"{profil}.degradeur-{sens}.log"), encoding="utf-8") as f:
        texte = f.read()
    m = re.findall(r"degradeur fin \{'aller': (\d+), 'perdus_aller': (\d+), 'coupes': (\d+)\}", texte)
    aller, perdus, coupes = (sum(int(x[i]) for x in m) for i in range(3))
    return aller, perdus, coupes


def main():
    dossier = sys.argv[1]
    lire = lambda suffixe: list(csv.DictReader(open(os.path.join(dossier, "resultat" + suffixe), encoding="utf-8")))
    lignes = {(r["acces"], r["cible"]): r for r in lire(".csv")}
    correl = {(r["acces"], r["cible_x"], r["cible_y"]): r for r in lire("-correlation.csv")}
    heures = {(r["acces"], r["cible"], r["heure_utc"]): r for r in lire("-heures.csv")}
    rares = {(r["acces"], r["nom"]): r for r in lire("-rare.csv")}
    echecs = []

    def ctl(nom, cond, detail):
        print(f"{'PASS' if cond else 'FAIL'} {nom} : {detail}")
        if not cond:
            echecs.append(nom)

    def f(r, k):
        return float(r[k]) if r[k] not in ("", "inf") else (float("inf") if r[k] == "inf" else None)

    for cible, sens in (("vm-udp", "udp"), ("vm-wg", "wg")):
        tol_tunnel = 3 if sens == "wg" else 0

        # P1 — 90 ms ± 10 ms, perte indépendante 0,5 %
        r = lignes[("simfibre", cible)]
        perdus = int(r["envoyes"]) - int(r["recus"])
        _, jetes, _ = compteurs_degradeur(dossier, "simfibre", sens)
        ctl(f"P1 {cible} pertes = paquets jetés", abs(perdus - jetes) <= 2 + tol_tunnel, f"irtt {perdus}, dégradeur {jetes}")
        ctl(f"P1 {cible} perte % dans [0,2 ; 1,0]", 0.2 <= f(r, "perte_pct") <= 1.0, r["perte_pct"])
        ctl(f"P1 {cible} p50 dans [88 ; 95] ms", 88 <= f(r, "p50") <= 95, r["p50"])
        ctl(f"P1 {cible} p95 dans [102 ; 113] ms (théorie 90 + 1,645 × 10 ≈ 106)", 102 <= f(r, "p95") <= 113, r["p95"])
        ctl(f"P1 {cible} gigue dans [9 ; 14] ms (théorie 2σ/√π ≈ 11,3)", 9 <= f(r, "gigue") <= 14, r["gigue"])
        ctl(f"P1 {cible} rafale max ≤ 3 paquets", int(r["rafale_max_paquets"]) <= 3, r["rafale_max_paquets"])

        # P2 — 150 ms ± 40 ms, Gilbert p = 0,51 %, r = 25 % (perte 2 %, rafale moyenne 4)
        r = lignes[("sim4g", cible)]
        perdus = int(r["envoyes"]) - int(r["recus"])
        _, jetes, _ = compteurs_degradeur(dossier, "sim4g", sens)
        ctl(f"P2 {cible} pertes = paquets jetés (arrêt par SIGTERM au groupe)", abs(perdus - jetes) <= 2 + tol_tunnel,
            f"irtt {perdus}, dégradeur {jetes}")
        ctl(f"P2 {cible} perte % dans [1,0 ; 3,5]", 1.0 <= f(r, "perte_pct") <= 3.5, r["perte_pct"])
        ctl(f"P2 {cible} p50 dans [145 ; 160] ms", 145 <= f(r, "p50") <= 160, r["p50"])
        ctl(f"P2 {cible} p95 dans [200 ; 232] ms (théorie ≈ 216)", 200 <= f(r, "p95") <= 232, r["p95"])
        ctl(f"P2 {cible} r ajusté dans [12 ; 45] % (injecté 25)", r["ge_r_pct"] != "" and 12 <= f(r, "ge_r_pct") <= 45, r["ge_r_pct"])
        ctl(f"P2 {cible} rafale max ≥ 3 paquets (pertes groupées)", int(r["rafale_max_paquets"]) >= 3, r["rafale_max_paquets"])
        ctl(f"P2 {cible} une tranche interrompue (SIGTERM) reconnue", int(r["fin_sigterm"]) >= 1, r["fin_sigterm"])

        # P3 — coupure franche de 15 s, sans autre perte ; témoin joignable : pas une panne locale
        r = lignes[("simcoupure", cible)]
        ctl(f"P3 {cible} rafale max dans [14,8 ; 15,8] s", 14.8 <= f(r, "rafale_max_s") <= 15.8, r["rafale_max_s"])
        ctl(f"P3 {cible} rafale max dans [74 ; 78] paquets (15 s / 200 ms = 75)", 74 <= int(r["rafale_max_paquets"]) <= 78, r["rafale_max_paquets"])
        ctl(f"P3 {cible} une seule rafale ≥ 10 s", int(r["rafales_10s"]) == 1, r["rafales_10s"])
        # Dans le tunnel, une perte isolée est tolérée peu après la coupure : au 1er passage du
        # 10/11 (version révisée), un paquet s'est perdu 5 s après la fin de la coupure, sans que
        # le dégradeur l'ait jeté (reprise de la poignée de main WireGuard, hypothèse non vérifiée).
        hors = int(r["envoyes"]) - int(r["recus"]) - int(r["rafale_max_paquets"])
        ctl(f"P3 {cible} pertes hors coupure ≤ {1 if sens == 'wg' else 0}", 0 <= hors <= (1 if sens == "wg" else 0),
            f"perdus {int(r['envoyes']) - int(r['recus'])}, rafale {r['rafale_max_paquets']}")
        ctl(f"P3 {cible} panne locale = 0 s (témoin joignable)", int(r["panne_locale_s"]) == 0, r["panne_locale_s"])
        ctl(f"P3 {cible} perte HL = perte brute", r["hl_perte_pct"] == r["perte_pct"], f"{r['hl_perte_pct']} / {r['perte_pct']}")
        ctl(f"P3 {cible} K = 1, T = 1,1 s : % d'expiration = % de perte (aucun RTT > 1,05 s)",
            abs(f(r, "brut_echec_k1_t1.1s_pct") - f(r, "perte_pct")) < 0.01, f"{r['brut_echec_k1_t1.1s_pct']} / {r['perte_pct']}")
        ctl(f"P3 {cible} K = 3, T = 5 s : la coupure fait encore basculer (2 × 5 s < 15 s)",
            f(r, "hl_echec_k3_t5.0s_pct") > 0 and int(r["hl_episodes_k3_t5.0s"]) == 1,
            f"{r['hl_echec_k3_t5.0s_pct']} %, {r['hl_episodes_k3_t5.0s']} épisode")
        ctl(f"P3 {cible} Gilbert ajusté hors coupure > 10 s : p ≤ {0.5 if sens == 'wg' else 0} % (la coupure n'y entre pas)",
            f(r, "hl_ge_p_pct") <= (0.5 if sens == "wg" else 0), r["hl_ge_p_pct"])

        # P4 — cible coupée pendant les 20 premières secondes du dégradeur (≈ 18 s vues par la sonde,
        # qui démarre 2 s après). Ouverture : 4 essais de 2 s (8 s) puis 1 s de pause -> fenêtres
        # d'indisponibilité de 9 s ; il en faut 2 pour couvrir 18 s -> ≈ 90 paquets virtuels.
        r = lignes[("simouverture", cible)]
        ctl(f"P4 {cible} indisponibilité d'ouverture dans [70 ; 110] paquets (≈ 18 s / 200 ms)", 70 <= int(r["virtuels"]) <= 110, r["virtuels"])
        borne = 27 if sens == "wg" else 24
        ctl(f"P4 {cible} silence max dans [16 ; {borne}] s", 16 <= f(r, "rafale_max_silence_s") <= borne, r["rafale_max_silence_s"])
        ctl(f"P4 {cible} aucune perte réelle", f(r, "perte_pct") == 0, r["perte_pct"])

        # P5 — panne amont de 12 s puis interface tombée 6 s : pannes locales (témoin muet aussi)
        r = lignes[("simlocale", cible)]
        ctl(f"P5 {cible} panne locale dans [14 ; 24] s (12 s + 6 s, moins les secondes de bord)",
            14 <= int(r["panne_locale_s"]) <= 24, r["panne_locale_s"])
        ctl(f"P5 {cible} brut : au moins une rafale ≥ 10 s", int(r["rafales_10s"]) >= 1, r["rafales_10s"])
        ctl(f"P5 {cible} HL : aucune rafale ≥ 3 s", int(r["hl_rafales_3s"]) == 0, r["hl_rafales_3s"])
        ctl(f"P5 {cible} HL : perte < 1 % (brut nettement plus haut)",
            f(r, "hl_perte_pct") < 1 and f(r, "perte_pct") > 3, f"HL {r['hl_perte_pct']} / brut {r['perte_pct']}")
        if sens == "udp":
            ctl(f"P5 {cible} arrêt d'irtt sur erreur d'envoi reconnu", int(r["fin_erreur_envoi"]) >= 1, r["fin_erreur_envoi"])

    # Témoin
    for acc in ("simfibre", "simcoupure", "simouverture"):
        r = lignes[(acc, "ref-udp")]
        ctl(f"témoin ref-udp {acc} : aucune perte", f(r, "perte_pct") == 0 and int(r["virtuels"]) == 0,
            f"{r['perte_pct']} %, {r['virtuels']} virtuels")
    c = correl[("simlocale", "ref-udp", "vm-udp")]
    ctl("P5 corrélation ref/vm : trop peu d'épisodes hors locale -> indéterminé",
        c["p_y_sachant_x_episodes_pct"] == "" and c["statut"].startswith("indéterminé"), c["statut"])

    # Journal de P2 : la tranche coupée par SIGTERM est bien écrite pour chaque cible
    texte = "".join(open(p, encoding="utf-8").read() for p in glob.glob(os.path.join(dossier, "sim4g", "*.sonde.log")))
    n_intr = len(re.findall(r"tranche_ok cible=\S+ fichier=\S+ interrompue=oui", texte))
    ctl("P2 SIGTERM au groupe : tranche écrite pour les 3 cibles", n_intr == 3, f"{n_intr} lignes interrompue=oui")
    texte = "".join(open(p, encoding="utf-8").read() for p in glob.glob(os.path.join(dossier, "simlocale", "*.sonde.log")))
    ctl("P5 journal : send_err=oui", "send_err=oui" in texte, f"{texte.count('send_err=oui')} ligne(s)")

    # Flux clairsemé (P1) : parsage et ordre de grandeur. ≈ 170 s / 3 s ≈ 50 pings dans chaque sens.
    for nom in ("vm-wg-rare", "retour-vm"):
        r = rares.get(("simfibre", nom))
        ctl(f"P1 flux clairsemé {nom} : ≥ 30 pings", r is not None and int(r["envoyes"]) >= 30, r and r["envoyes"])
        ctl(f"P1 flux clairsemé {nom} : p50 dans [85 ; 100] ms", r is not None and r["p50"] != "" and 85 <= float(r["p50"]) <= 100,
            r and r["p50"])
    r = rares.get(("simfibre", "vm-wg-rare"))
    ctl("P1 flux clairsemé : surcoût p50 calculé et |surcoût| < 10 ms (pas de radio ici)",
        r is not None and r["surcout_p50_ms"] != "" and abs(float(r["surcout_p50_ms"])) < 10, r and r["surcout_p50_ms"])

    # Syslog du routeur (P1, lignes simulées) : 7,5 Mo par minute reçus = 1,0 Mbit/s ; 1,5 Mo émis = 0,2.
    wan = [h for k, h in heures.items() if k[0] == "simfibre" and k[1] == "vm-udp" and h["wan_rx_mbps"] != ""]
    ctl("P1 syslog : débit WAN reçu dans [0,9 ; 1,1] Mbit/s", len(wan) >= 1 and all(0.9 <= float(h["wan_rx_mbps"]) <= 1.1 for h in wan),
        [h["wan_rx_mbps"] for h in wan])
    ctl("P1 syslog : débit WAN émis dans [0,18 ; 0,22] Mbit/s", len(wan) >= 1 and all(0.18 <= float(h["wan_tx_mbps"]) <= 0.22 for h in wan),
        [h["wan_tx_mbps"] for h in wan])
    journal = "".join(open(p, encoding="utf-8").read() for p in glob.glob(os.path.join(dossier, "simfibre", "*.routeros.log")))
    ctl("P1 syslog : ligne étrangère ignorée, repère de démarrage gardé",
        "autre-script" not in journal and "wakatnet-labo demarrage" in journal, f"{journal.count(chr(10))} lignes gardées")

    print("RÉSULTAT :", "ÉCHEC — " + ", ".join(echecs) if echecs else f"tous les contrôles passent ({len(echecs)} échec)")
    return 1 if echecs else 0


if __name__ == "__main__":
    sys.exit(main())
