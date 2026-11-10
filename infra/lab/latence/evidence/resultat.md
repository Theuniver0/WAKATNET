# Mesures de latence WAKATNET — résultats

Généré par `analyse.py` le 2026-11-10 21:43 UTC. Heures en UTC (= heure du Burkina). Pic du soir : 19 h–23 h ; heures creuses : 2 h–6 h. Temps serveur ajouté dans l'émulation du timeout : 50 ms. Hypothèse de volume : 300 authentifications par jour et par routeur. Groupes Hetzner : vm (tout autre groupe est un témoin de panne locale).

Conventions : RTT en ms. *Reçus* = centiles sur les seuls RTT reçus. *Effectif* (`e`) = centile du délai où une perte compte comme un délai infini (« perdu » = le centile tombe dans les pertes). ⚠ = centile q calculé sur moins de 10/(1−q) valeurs (moins de 10 valeurs dans la queue : 1 000 pour le p99, 10 000 pour le p99.9). *HL* = hors panne locale. *Gigue* = moyenne de |ΔRTT| entre paquets reçus consécutifs (IPDV moyen), pas l'estimateur filtré de la RFC 3550.

## 1. Tableau principal (accès × cible), toute la mesure

*Rafale* = pertes consécutives : paquets / durée des pertes mesurées (paquets × intervalle) / silence complet (ajoute les silences de la sonde : trous entre tranches, attente d'ouverture). Les compteurs ≥ 1 s / ≥ 3 s / ≥ 10 s portent sur la durée des pertes mesurées.

| site | accès | cible | durée h | couv. % | envoyés | perte % brut / HL | p50 | p95 | p99 | p99.9 | p95e / p99e / p99.9e HL | max | gigue | rafale max (paq. / pertes s / silence s) | rafales ≥1 s / ≥3 s / ≥10 s | indispo. ouverture (paq.) | panne locale |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| labo | sim4g | ref-udp | 0.04 | 99.7 | 2775 | 0.00 / 0.00 | 0.2 | 0.4 | 1.1 | 2.3 ⚠ | 0.4 / 1.1 / 2.3 ⚠ | 3.1 | 0.1 | 0 / 0.00 / 0.00 | 0 / 0 / 0 | 0 | témoin : ref-udp ; 0 s |
| labo | sim4g | vm-udp | 0.04 | 98.8 | 2751 | 1.96 / 1.96 | 150.8 | 215.0 | 239.3 | 261.7 ⚠ | 225.2 / perdu / perdu ⚠ | 268.9 | 46.0 | 11 / 0.55 / 0.55 | 0 / 0 / 0 | 0 | témoin : ref-udp ; 0 s |
| labo | sim4g | vm-wg | 0.04 | 98.7 | 2767 | 1.95 / 1.95 | 151.3 | 215.9 | 240.1 | 264.4 ⚠ | 225.9 / perdu / perdu ⚠ | 269.8 | 46.0 | 11 / 0.55 / 0.55 | 0 / 0 / 0 | 0 | témoin : ref-udp ; 0 s |
| labo | simcoupure | ref-udp | 0.02 | 100.0 | 449 | 0.00 / 0.00 | 0.2 | 0.3 | 1.2 ⚠ | 2.2 ⚠ | 0.3 / 1.2 ⚠ / 2.2 ⚠ | 2.2 | 0.1 | 0 / 0.00 / 0.00 | 0 / 0 / 0 | 0 | témoin : ref-udp ; 0 s |
| labo | simcoupure | vm-udp | 0.03 | 99.4 | 449 | 16.70 / 16.70 | 92.2 | 108.9 | 113.0 ⚠ | 124.0 ⚠ | perdu / perdu ⚠ / perdu ⚠ | 124.0 | 11.5 | 75 / 15.00 / 15.00 | 1 / 1 / 1 | 0 | témoin : ref-udp ; 0 s |
| labo | simcoupure | vm-wg | 0.03 | 99.7 | 450 | 16.67 / 16.67 | 92.5 | 109.7 | 113.7 ⚠ | 124.3 ⚠ | perdu / perdu ⚠ / perdu ⚠ | 124.3 | 11.6 | 75 / 15.00 / 15.00 | 1 / 1 / 1 | 0 | témoin : ref-udp ; 0 s |
| labo | simfibre | ref-udp | 0.05 | 99.8 | 3593 | 0.00 / 0.00 | 0.2 | 0.4 | 0.7 | 2.1 ⚠ | 0.4 / 0.7 / 2.1 ⚠ | 2.4 | 0.1 | 0 / 0.00 / 0.00 | 0 / 0 / 0 | 0 | témoin : ref-udp ; 0 s |
| labo | simfibre | vm-udp | 0.05 | 99.3 | 3573 | 0.53 / 0.53 | 91.3 | 108.5 | 116.5 | 121.5 ⚠ | 109.7 / 119.2 / perdu ⚠ | 128.2 | 11.4 | 1 / 0.05 / 0.05 | 0 / 0 / 0 | 0 | témoin : ref-udp ; 0 s |
| labo | simfibre | vm-wg | 0.05 | 99.3 | 3575 | 0.50 / 0.50 | 91.9 | 108.7 | 117.0 | 121.8 ⚠ | 109.8 / 119.6 / perdu ⚠ | 128.8 | 11.4 | 1 / 0.05 / 0.05 | 0 / 0 / 0 | 0 | témoin : ref-udp ; 0 s |
| labo | simlocale | ref-udp | 0.04 | 95.7 | 718 | 8.22 / 0.75 | 0.2 | 0.4 | 0.6 ⚠ | 2.1 ⚠ | 0.4 / 1.9 ⚠ / perdu ⚠ | 2.1 | 0.1 | 59 / 11.80 / 12.00 | 2 / 2 / 1 | 35 | témoin : ref-udp ; 17 s |
| labo | simlocale | vm-udp | 0.04 | 95.5 | 713 | 8.27 / 0.76 | 91.9 | 108.1 | 117.1 ⚠ | 123.0 ⚠ | 108.9 / 122.6 ⚠ / perdu ⚠ | 123.0 | 11.4 | 59 / 11.80 / 12.00 | 2 / 2 / 1 | 30 | témoin : ref-udp ; 17 s |
| labo | simlocale | vm-wg | 0.04 | 99.6 | 747 | 12.05 / 0.76 | 92.4 | 108.5 | 117.8 ⚠ | 123.6 ⚠ | 109.5 / 121.5 ⚠ / perdu ⚠ | 123.6 | 11.5 | 60 / 12.00 / 12.00 | 2 / 2 / 1 | 0 | témoin : ref-udp ; 17 s |
| labo | simouverture | ref-udp | 0.02 | 100.0 | 300 | 0.00 / 0.00 | 0.3 | 0.5 | 2.0 ⚠ | 4.4 ⚠ | 0.5 / 2.0 ⚠ / 4.4 ⚠ | 4.4 | 0.2 | 0 / 0.00 / 0.00 | 0 / 0 / 0 | 0 | témoin : ref-udp ; 0 s |
| labo | simouverture | vm-udp | 0.02 | 69.1 | 210 | 0.00 / 0.00 | 92.0 | 109.5 | 116.8 ⚠ | 121.4 ⚠ | 109.5 / 116.8 ⚠ / 121.4 ⚠ | 121.4 | 11.6 | 90 / 18.00 / 18.75 | 1 / 1 / 1 | 90 | témoin : ref-udp ; 0 s |
| labo | simouverture | vm-wg | 0.02 | 60.3 | 184 | 0.00 / 0.00 | 92.8 | 110.1 ⚠ | 118.0 ⚠ | 122.0 ⚠ | 110.1 ⚠ / 118.0 ⚠ / 122.0 ⚠ | 122.0 | 11.7 | 90 / 18.00 / 24.08 | 1 / 1 / 1 | 90 | témoin : ref-udp ; 0 s |

## 2. Timeout `/radius` émulé, au pic du soir, hors panne locale

Chaque paquet de la sonde sert d'instant de départ d'une requête. Variante stricte : un essai échoue si son paquet est perdu ou si RTT + temps serveur > T ; la requête expire sur A (bascule vers B) si les K essais échouent. Variante tardive (dépend de LABO-16) : une réponse à l'essai j arrivée avant K·T est acceptée. Cellule : *% strict* / *% tardif* (*fausses bascules attendues par jour* = % strict × 300). Le nombre d'essais réel de RouterOS n'est **pas vérifié** (LABO). Le même calcul sur toute la mesure, brut et hors panne locale, est dans le CSV.

### K = 1 essai(s)

| site | accès | cible | instants | T = 0.5 s | T = 1 s | T = 1.1 s | T = 1.5 s | T = 2 s | T = 2.3 s | T = 3 s | T = 5 s |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| labo | sim4g | ref-udp | 2775 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | sim4g | vm-udp | 2751 | 1.963 / 1.963 (5.89/j) | 1.963 / 1.963 (5.89/j) | 1.963 / 1.963 (5.89/j) | 1.963 / 1.963 (5.89/j) | 1.963 / 1.963 (5.89/j) | 1.963 / 1.963 (5.89/j) | 1.963 / 1.963 (5.89/j) | 1.963 / 1.963 (5.89/j) |
| labo | sim4g | vm-wg | 2767 | 1.952 / 1.952 (5.85/j) | 1.952 / 1.952 (5.85/j) | 1.952 / 1.952 (5.85/j) | 1.952 / 1.952 (5.85/j) | 1.952 / 1.952 (5.85/j) | 1.952 / 1.952 (5.85/j) | 1.952 / 1.952 (5.85/j) | 1.952 / 1.952 (5.85/j) |
| labo | simcoupure | ref-udp | 449 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simcoupure | vm-udp | 449 | 16.704 / 16.704 (50.11/j) | 16.704 / 16.704 (50.11/j) | 16.704 / 16.704 (50.11/j) | 16.704 / 16.704 (50.11/j) | 16.704 / 16.704 (50.11/j) | 16.704 / 16.704 (50.11/j) | 16.704 / 16.704 (50.11/j) | 16.704 / 16.704 (50.11/j) |
| labo | simcoupure | vm-wg | 450 | 16.667 / 16.667 (50.00/j) | 16.667 / 16.667 (50.00/j) | 16.667 / 16.667 (50.00/j) | 16.667 / 16.667 (50.00/j) | 16.667 / 16.667 (50.00/j) | 16.667 / 16.667 (50.00/j) | 16.667 / 16.667 (50.00/j) | 16.667 / 16.667 (50.00/j) |
| labo | simfibre | ref-udp | 3593 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simfibre | vm-udp | 3573 | 0.532 / 0.532 (1.60/j) | 0.532 / 0.532 (1.60/j) | 0.532 / 0.532 (1.60/j) | 0.532 / 0.532 (1.60/j) | 0.532 / 0.532 (1.60/j) | 0.532 / 0.532 (1.60/j) | 0.532 / 0.532 (1.60/j) | 0.532 / 0.532 (1.60/j) |
| labo | simfibre | vm-wg | 3575 | 0.503 / 0.503 (1.51/j) | 0.503 / 0.503 (1.51/j) | 0.503 / 0.503 (1.51/j) | 0.503 / 0.503 (1.51/j) | 0.503 / 0.503 (1.51/j) | 0.503 / 0.503 (1.51/j) | 0.503 / 0.503 (1.51/j) | 0.503 / 0.503 (1.51/j) |
| labo | simlocale | ref-udp | 669 | 1.495 / 1.495 (4.48/j) | 1.495 / 1.495 (4.48/j) | 1.495 / 1.495 (4.48/j) | 1.495 / 1.495 (4.48/j) | 1.495 / 1.495 (4.48/j) | 1.495 / 1.495 (4.48/j) | 1.495 / 1.495 (4.48/j) | 1.495 / 1.495 (4.48/j) |
| labo | simlocale | vm-udp | 659 | 0.759 / 0.759 (2.28/j) | 0.759 / 0.759 (2.28/j) | 0.759 / 0.759 (2.28/j) | 0.759 / 0.759 (2.28/j) | 0.759 / 0.759 (2.28/j) | 0.759 / 0.759 (2.28/j) | 0.759 / 0.759 (2.28/j) | 0.759 / 0.759 (2.28/j) |
| labo | simlocale | vm-wg | 662 | 0.755 / 0.755 (2.27/j) | 0.755 / 0.755 (2.27/j) | 0.755 / 0.755 (2.27/j) | 0.755 / 0.755 (2.27/j) | 0.755 / 0.755 (2.27/j) | 0.755 / 0.755 (2.27/j) | 0.755 / 0.755 (2.27/j) | 0.755 / 0.755 (2.27/j) |
| labo | simouverture | ref-udp | 300 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simouverture | vm-udp | 300 | 30.000 / 30.000 (90.00/j) | 30.000 / 30.000 (90.00/j) | 30.000 / 30.000 (90.00/j) | 30.000 / 30.000 (90.00/j) | 30.000 / 30.000 (90.00/j) | 30.000 / 30.000 (90.00/j) | 30.000 / 30.000 (90.00/j) | 30.000 / 30.000 (90.00/j) |
| labo | simouverture | vm-wg | 274 | 32.847 / 32.847 (98.54/j) | 32.847 / 32.847 (98.54/j) | 32.847 / 32.847 (98.54/j) | 32.847 / 32.847 (98.54/j) | 32.847 / 32.847 (98.54/j) | 32.847 / 32.847 (98.54/j) | 32.847 / 32.847 (98.54/j) | 32.847 / 32.847 (98.54/j) |

### K = 2 essai(s)

| site | accès | cible | instants | T = 0.5 s | T = 1 s | T = 1.1 s | T = 1.5 s | T = 2 s | T = 2.3 s | T = 3 s | T = 5 s |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| labo | sim4g | ref-udp | 2775 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | sim4g | vm-udp | 2751 | 0.036 / 0.036 (0.11/j) | 0.000 / 0.000 (0.00/j) | 0.036 / 0.036 (0.11/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | sim4g | vm-wg | 2767 | 0.036 / 0.036 (0.11/j) | 0.000 / 0.000 (0.00/j) | 0.036 / 0.036 (0.11/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simcoupure | ref-udp | 449 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simcoupure | vm-udp | 449 | 16.258 / 16.258 (48.78/j) | 15.590 / 15.590 (46.77/j) | 15.367 / 15.367 (46.10/j) | 14.922 / 14.922 (44.77/j) | 14.477 / 14.477 (43.43/j) | 14.031 / 14.031 (42.09/j) | 13.363 / 13.363 (40.09/j) | 11.136 / 11.136 (33.41/j) |
| labo | simcoupure | vm-wg | 450 | 16.222 / 16.222 (48.67/j) | 15.556 / 15.556 (46.67/j) | 15.333 / 15.333 (46.00/j) | 14.889 / 14.889 (44.67/j) | 14.444 / 14.444 (43.33/j) | 14.000 / 14.000 (42.00/j) | 13.333 / 13.333 (40.00/j) | 11.111 / 11.111 (33.33/j) |
| labo | simfibre | ref-udp | 3593 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simfibre | vm-udp | 3573 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simfibre | vm-wg | 3574 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simlocale | ref-udp | 667 | 0.900 / 0.900 (2.70/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simlocale | vm-udp | 659 | 0.455 / 0.455 (1.37/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simlocale | vm-wg | 662 | 0.453 / 0.453 (1.36/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simouverture | ref-udp | 300 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simouverture | vm-udp | 298 | 29.530 / 29.530 (88.59/j) | 28.523 / 28.523 (85.57/j) | 28.283 / 28.283 (84.85/j) | 27.609 / 27.609 (82.83/j) | 26.846 / 26.846 (80.54/j) | 26.263 / 26.263 (78.79/j) | 25.168 / 25.168 (75.50/j) | 21.812 / 21.812 (65.44/j) |
| labo | simouverture | vm-wg | 272 | 32.353 / 32.353 (97.06/j) | 31.599 / 31.599 (94.80/j) | 31.343 / 31.343 (94.03/j) | 30.827 / 30.827 (92.48/j) | 30.303 / 30.303 (90.91/j) | 29.771 / 29.771 (89.31/j) | 28.958 / 28.958 (86.87/j) | 26.104 / 26.104 (78.31/j) |

### K = 3 essai(s)

| site | accès | cible | instants | T = 0.5 s | T = 1 s | T = 1.1 s | T = 1.5 s | T = 2 s | T = 2.3 s | T = 3 s | T = 5 s |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| labo | sim4g | ref-udp | 2775 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | sim4g | vm-udp | 2751 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | sim4g | vm-wg | 2767 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simcoupure | ref-udp | 449 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simcoupure | vm-udp | 449 | 15.813 / 15.813 (47.44/j) | 14.477 / 14.477 (43.43/j) | 14.031 / 14.031 (42.09/j) | 13.140 / 13.140 (39.42/j) | 12.249 / 12.249 (36.75/j) | 11.359 / 11.359 (34.08/j) | 10.022 / 10.022 (30.07/j) | 5.568 / 5.568 (16.70/j) |
| labo | simcoupure | vm-wg | 450 | 15.778 / 15.778 (47.33/j) | 14.444 / 14.444 (43.33/j) | 14.000 / 14.000 (42.00/j) | 13.111 / 13.111 (39.33/j) | 12.222 / 12.222 (36.67/j) | 11.333 / 11.333 (34.00/j) | 10.000 / 10.000 (30.00/j) | 5.556 / 5.556 (16.67/j) |
| labo | simfibre | ref-udp | 3593 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simfibre | vm-udp | 3573 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simfibre | vm-wg | 3574 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simlocale | ref-udp | 663 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simlocale | vm-udp | 659 | 0.152 / 0.152 (0.46/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simlocale | vm-wg | 662 | 0.151 / 0.151 (0.45/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simouverture | ref-udp | 300 | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) | 0.000 / 0.000 (0.00/j) |
| labo | simouverture | vm-udp | 297 | 28.956 / 28.956 (86.87/j) | 27.027 / 27.027 (81.08/j) | 26.780 / 26.780 (80.34/j) | 25.424 / 25.424 (76.27/j) | 23.649 / 23.649 (70.95/j) | 22.712 / 22.712 (68.14/j) | 20.270 / 20.270 (60.81/j) | 13.514 / 13.514 (40.54/j) |
| labo | simouverture | vm-wg | 270 | 31.852 / 31.852 (95.56/j) | 30.303 / 30.303 (90.91/j) | 30.038 / 30.038 (90.11/j) | 28.958 / 28.958 (86.87/j) | 27.559 / 27.559 (82.68/j) | 26.693 / 26.693 (80.08/j) | 24.590 / 24.590 (73.77/j) | 17.857 / 17.857 (53.57/j) |

## 3. Heures creuses et pic du soir (hors panne locale)

| site | accès | cible | période | envoyés | perte % | p50 | p95 | p99 | p99.9 | p95e | p99e | p99.9e | rafale max s |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| labo | sim4g | ref-udp | creuses | 0 | — | — | — | — | — | — | — | — | — |
| labo | sim4g | ref-udp | pic | 2775 | 0.00 | 0.2 | 0.4 | 1.1 | 2.3 ⚠ | 0.4 | 1.1 | 2.3 ⚠ | 0.00 |
| labo | sim4g | vm-udp | creuses | 0 | — | — | — | — | — | — | — | — | — |
| labo | sim4g | vm-udp | pic | 2751 | 1.96 | 150.8 | 215.0 | 239.3 | 261.7 ⚠ | 225.2 | perdu | perdu ⚠ | 0.55 |
| labo | sim4g | vm-wg | creuses | 0 | — | — | — | — | — | — | — | — | — |
| labo | sim4g | vm-wg | pic | 2767 | 1.95 | 151.3 | 215.9 | 240.1 | 264.4 ⚠ | 225.9 | perdu | perdu ⚠ | 0.55 |
| labo | simcoupure | ref-udp | creuses | 0 | — | — | — | — | — | — | — | — | — |
| labo | simcoupure | ref-udp | pic | 449 | 0.00 | 0.2 | 0.3 | 1.2 ⚠ | 2.2 ⚠ | 0.3 | 1.2 ⚠ | 2.2 ⚠ | 0.00 |
| labo | simcoupure | vm-udp | creuses | 0 | — | — | — | — | — | — | — | — | — |
| labo | simcoupure | vm-udp | pic | 449 | 16.70 | 92.2 | 108.9 | 113.0 ⚠ | 124.0 ⚠ | perdu | perdu ⚠ | perdu ⚠ | 15.00 |
| labo | simcoupure | vm-wg | creuses | 0 | — | — | — | — | — | — | — | — | — |
| labo | simcoupure | vm-wg | pic | 450 | 16.67 | 92.5 | 109.7 | 113.7 ⚠ | 124.3 ⚠ | perdu | perdu ⚠ | perdu ⚠ | 15.00 |
| labo | simfibre | ref-udp | creuses | 0 | — | — | — | — | — | — | — | — | — |
| labo | simfibre | ref-udp | pic | 3593 | 0.00 | 0.2 | 0.4 | 0.7 | 2.1 ⚠ | 0.4 | 0.7 | 2.1 ⚠ | 0.00 |
| labo | simfibre | vm-udp | creuses | 0 | — | — | — | — | — | — | — | — | — |
| labo | simfibre | vm-udp | pic | 3573 | 0.53 | 91.3 | 108.5 | 116.5 | 121.5 ⚠ | 109.7 | 119.2 | perdu ⚠ | 0.05 |
| labo | simfibre | vm-wg | creuses | 0 | — | — | — | — | — | — | — | — | — |
| labo | simfibre | vm-wg | pic | 3575 | 0.50 | 91.9 | 108.7 | 117.0 | 121.8 ⚠ | 109.8 | 119.6 | perdu ⚠ | 0.05 |
| labo | simlocale | ref-udp | creuses | 0 | — | — | — | — | — | — | — | — | — |
| labo | simlocale | ref-udp | pic | 664 | 0.75 | 0.2 | 0.4 | 0.6 ⚠ | 2.1 ⚠ | 0.4 | 1.9 ⚠ | perdu ⚠ | 0.80 |
| labo | simlocale | vm-udp | creuses | 0 | — | — | — | — | — | — | — | — | — |
| labo | simlocale | vm-udp | pic | 659 | 0.76 | 91.9 | 108.1 | 117.1 ⚠ | 123.0 ⚠ | 108.9 | 122.6 ⚠ | perdu ⚠ | 1.00 |
| labo | simlocale | vm-wg | creuses | 0 | — | — | — | — | — | — | — | — | — |
| labo | simlocale | vm-wg | pic | 662 | 0.76 | 92.4 | 108.5 | 117.8 ⚠ | 123.6 ⚠ | 109.5 | 121.5 ⚠ | perdu ⚠ | 1.00 |
| labo | simouverture | ref-udp | creuses | 0 | — | — | — | — | — | — | — | — | — |
| labo | simouverture | ref-udp | pic | 300 | 0.00 | 0.3 | 0.5 | 2.0 ⚠ | 4.4 ⚠ | 0.5 | 2.0 ⚠ | 4.4 ⚠ | 0.00 |
| labo | simouverture | vm-udp | creuses | 0 | — | — | — | — | — | — | — | — | — |
| labo | simouverture | vm-udp | pic | 210 | 0.00 | 92.0 | 109.5 | 116.8 ⚠ | 121.4 ⚠ | 109.5 | 116.8 ⚠ | 121.4 ⚠ | 18.00 |
| labo | simouverture | vm-wg | creuses | 0 | — | — | — | — | — | — | — | — | — |
| labo | simouverture | vm-wg | pic | 184 | 0.00 | 92.8 | 110.1 ⚠ | 118.0 ⚠ | 122.0 ⚠ | 110.1 ⚠ | 118.0 ⚠ | 122.0 ⚠ | 18.00 |

## 3 bis. Pic du soir, soirée par soirée (hors panne locale)

Q (p99.9 du RTT reçu, au pic) se prend comme le **maximum sur les soirées**. IC 90 % : bootstrap en blocs d'une heure de pic (200 tirages ; grossier avec moins d'une quinzaine de blocs).

| site | accès | cible | soirées | p95e min / max | p99.9 min / max (Q = max) | IC 90 % p95e pic | IC 90 % p99.9 pic |
|---|---|---|---:|---:|---:|---:|---:|
| labo | sim4g | ref-udp | 1 | 0.4 / 0.4 | 2.3 / 2.3 ⚠ | — | — |
| labo | sim4g | vm-udp | 1 | 225.2 / 225.2 | 261.7 / 261.7 ⚠ | — | — |
| labo | sim4g | vm-wg | 1 | 225.9 / 225.9 | 264.4 / 264.4 ⚠ | — | — |
| labo | simcoupure | ref-udp | 1 | 0.3 / 0.3 | 2.2 / 2.2 ⚠ | — | — |
| labo | simcoupure | vm-udp | 1 | perdu / perdu | 124.0 / 124.0 ⚠ | — | — |
| labo | simcoupure | vm-wg | 1 | perdu / perdu | 124.3 / 124.3 ⚠ | — | — |
| labo | simfibre | ref-udp | 1 | 0.4 / 0.4 | 2.1 / 2.1 ⚠ | — | — |
| labo | simfibre | vm-udp | 1 | 109.7 / 109.7 | 121.5 / 121.5 ⚠ | — | — |
| labo | simfibre | vm-wg | 1 | 109.8 / 109.8 | 121.8 / 121.8 ⚠ | — | — |
| labo | simlocale | ref-udp | 1 | 0.4 / 0.4 | 2.1 / 2.1 ⚠ | — | — |
| labo | simlocale | vm-udp | 1 | 108.9 / 108.9 | 123.0 / 123.0 ⚠ | — | — |
| labo | simlocale | vm-wg | 1 | 109.5 / 109.5 | 123.6 / 123.6 ⚠ | — | — |
| labo | simouverture | ref-udp | 1 | 0.5 / 0.5 | 4.4 / 4.4 ⚠ | — | — |
| labo | simouverture | vm-udp | 1 | 109.5 / 109.5 | 121.4 / 121.4 ⚠ | — | — |
| labo | simouverture | vm-wg | 1 | 110.1 / 110.1 | 122.0 / 122.0 ⚠ | — | — |

Détail par soirée : `-soirees.csv`.

## 4. Corrélation des pannes (même source, même transport)

Seconde *en panne* = au moins un paquet envoyé et aucun reçu. *Panne locale* = seconde où un témoin (cible hors Hetzner) a des paquets et où **toutes** les cibles qui en ont sont muettes ; sans témoin, elle est **indéterminée** et rien n'est conclu. *Non classables* = secondes de panne sans aucune donnée de témoin (exclues du calcul hors locale). P(Y|X) en épisodes : part des épisodes de panne de X hors locale (≥ 2 s consécutives) pendant lesquels Y est en panne au moins la moitié du temps ; **indéterminé** sous 10 épisodes. C'est cette colonne qui sert aux règles 7.2 et 7.3 ; la valeur en secondes est donnée pour mémoire (un seul long épisode la domine).

| site | accès | X | Y | s communes | panne X s | simultanées s | P(Y\|X) % brut | panne locale s | non classables s | P(Y\|X) HL % (s) | épisodes X HL | P(Y\|X) HL % (épisodes) | statut |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| labo | sim4g | ref-udp | vm-udp | 140 | 0 | 0 | — | 0 | 0 | — | 0 | — | indéterminé : 0 épisode(s) < 10 |
| labo | simcoupure | ref-udp | vm-udp | 91 | 0 | 0 | — | 0 | 0 | — | 0 | — | indéterminé : 0 épisode(s) < 10 |
| labo | simfibre | ref-udp | vm-udp | 181 | 0 | 0 | — | 0 | 0 | — | 0 | — | indéterminé : 0 épisode(s) < 10 |
| labo | simlocale | ref-udp | vm-udp | 150 | 17 | 17 | 100.0 | 17 | 0 | — | 0 | — | indéterminé : 0 épisode(s) < 10 |
| labo | simouverture | ref-udp | vm-udp | 61 | 0 | 0 | — | 0 | 0 | — | 0 | — | indéterminé : 0 épisode(s) < 10 |

## 4 bis. Comparaison appariée, heure par heure du pic (hors panne locale)

Pour chaque heure de pic où les deux cibles ont au moins 200 paquets, on compare leur p95 effectif (mesures simultanées depuis la même sonde). Verdict « X meilleur » si X est meilleur sur au moins 80 % des heures **et** sur chaque soirée (écart médian de la soirée) ; sinon « indistinct ».

| site | accès | X | Y | heures | X meilleur % | Y meilleur % | écart médian X−Y ms | soirées X / Y meilleur | verdict |
|---|---|---|---|---:|---:|---:|---:|---:|---|
| labo | sim4g | ref-udp | vm-udp | 1 | 100.0 | 0.0 | -224.8 | 1 / 0 sur 1 | ref-udp meilleur |
| labo | simcoupure | ref-udp | vm-udp | 1 | 100.0 | 0.0 | — | 1 / 0 sur 1 | ref-udp meilleur |
| labo | simfibre | ref-udp | vm-udp | 1 | 100.0 | 0.0 | -109.3 | 1 / 0 sur 1 | ref-udp meilleur |
| labo | simlocale | ref-udp | vm-udp | 1 | 100.0 | 0.0 | -108.5 | 1 / 0 sur 1 | ref-udp meilleur |
| labo | simouverture | ref-udp | vm-udp | 1 | 100.0 | 0.0 | -109.0 | 1 / 0 sur 1 | ref-udp meilleur |

## 5. Profil équivalent à rejouer en labo (LABO-16)

Modèle de Gilbert simple ajusté hors panne locale et **hors rafales de plus de 10 s** (p : reçu → perdu ; r : perdu → reçu). Les coupures longues sont données à part : elles se rejouent comme des coupures, pas comme des pertes en rafale. Commande `tc netem` indicative, aller seulement.

| site | accès | cible | p % | r % | rafale moy. (paquets) | netem indicatif | coupures > 10 s (début UTC, durée s) |
|---|---|---|---:|---:|---:|---|---|
| labo | sim4g | ref-udp | 0.000 | — | — | — | — |
| labo | sim4g | vm-udp | 0.483 | 24.07 | 4.2 | `delay 151ms 39ms distribution normal loss gemodel 0.483% 24.07% 100% 0%` | — |
| labo | sim4g | vm-wg | 0.480 | 24.07 | 4.2 | `delay 151ms 39ms distribution normal loss gemodel 0.480% 24.07% 100% 0%` | — |
| labo | simcoupure | ref-udp | 0.000 | — | — | — | — |
| labo | simcoupure | vm-udp | 0.000 | — | — | — | 11-10 21:39:12 (15.0) |
| labo | simcoupure | vm-wg | 0.000 | — | — | — | 11-10 21:39:12 (15.0) |
| labo | simfibre | ref-udp | 0.000 | — | — | — | — |
| labo | simfibre | vm-udp | 0.535 | 100.00 | 1.0 | `delay 91ms 10ms distribution normal loss gemodel 0.535% 100.00% 100% 0%` | — |
| labo | simfibre | vm-wg | 0.506 | 100.00 | 1.0 | `delay 92ms 10ms distribution normal loss gemodel 0.506% 100.00% 100% 0%` | — |
| labo | simlocale | ref-udp | 0.153 | 25.00 | 4.0 | `delay 0ms 0ms distribution normal loss gemodel 0.153% 25.00% 100% 0%` | — |
| labo | simlocale | vm-udp | 0.000 | 20.00 | 5.0 | `delay 92ms 10ms distribution normal loss gemodel 0.000% 20.00% 100% 0%` | — |
| labo | simlocale | vm-wg | 0.000 | 20.00 | 5.0 | `delay 92ms 10ms distribution normal loss gemodel 0.000% 20.00% 100% 0%` | — |
| labo | simouverture | ref-udp | 0.000 | — | — | — | — |
| labo | simouverture | vm-udp | 0.000 | — | — | — | 11-10 21:40:12 (18.0) |
| labo | simouverture | vm-wg | 0.000 | — | — | — | 11-10 21:40:12 (18.0) |

## 6. Qualité de la capture

*Fins anticipées* : irtt arrêté avant la durée demandée, par SIGTERM (journal `interrompue=oui`), sur erreur d'envoi (`send_err` d'irtt : interface tombée, réseau injoignable) ou sans cause connue. Seules les pertes de queue de la dernière fenêtre min(2 s ; 2 × p99) sont retirées (paquets « en vol »). *Sauts d'horloge* : tranches où l'horloge murale s'est écartée de plus de 1 s de l'horloge monotone d'irtt (pas de NTP en cours de tranche ; l'analyse suit l'horloge monotone).

| site | accès | cible | début | fin | fichiers | intervalle ms | fins de tranche perdues ≥ 30 s | fins anticipées SIGTERM / erreur d'envoi / inexpliquées (paquets en vol retirés) | sauts d'horloge | perte montante / descendante | paquets retirés hors locale |
|---|---|---|---|---|---:|---:|---:|---:|---:|---|---:|
| labo | sim4g | ref-udp | 2026-11-10T21:36:08Z | 2026-11-10T21:38:28Z | 3 | 50 | 0 | 1 / 0 / 0 (0) | 0 | 0 / 0 | 0 |
| labo | sim4g | vm-udp | 2026-11-10T21:36:08Z | 2026-11-10T21:38:28Z | 3 | 50 | 0 | 1 / 0 / 0 (3) | 0 | 54 / 0 | 0 |
| labo | sim4g | vm-wg | 2026-11-10T21:36:08Z | 2026-11-10T21:38:29Z | 3 | 50 | 0 | 1 / 0 / 0 (3) | 0 | 54 / 0 | 0 |
| labo | simcoupure | ref-udp | 2026-11-10T21:38:37Z | 2026-11-10T21:40:07Z | 2 | 200 | 0 | 0 / 0 / 0 (0) | 0 | 0 / 0 | 0 |
| labo | simcoupure | vm-udp | 2026-11-10T21:38:37Z | 2026-11-10T21:40:07Z | 2 | 200 | 0 | 0 / 0 / 0 (0) | 0 | 63 / 0 | 0 |
| labo | simcoupure | vm-wg | 2026-11-10T21:38:37Z | 2026-11-10T21:40:07Z | 2 | 200 | 0 | 0 / 0 / 0 (0) | 0 | 63 / 0 | 0 |
| labo | simfibre | ref-udp | 2026-11-10T21:33:00Z | 2026-11-10T21:36:00Z | 3 | 50 | 0 | 0 / 0 / 0 (0) | 0 | 0 / 0 | 0 |
| labo | simfibre | vm-udp | 2026-11-10T21:33:00Z | 2026-11-10T21:36:00Z | 3 | 50 | 0 | 0 / 0 / 0 (0) | 0 | 19 / 0 | 0 |
| labo | simfibre | vm-wg | 2026-11-10T21:33:00Z | 2026-11-10T21:36:00Z | 3 | 50 | 0 | 0 / 0 / 0 (0) | 0 | 18 / 0 | 0 |
| labo | simlocale | ref-udp | 2026-11-10T21:41:20Z | 2026-11-10T21:43:50Z | 3 | 200 | 0 | 0 / 1 / 0 (0) | 0 | 59 / 0 | 84 |
| labo | simlocale | vm-udp | 2026-11-10T21:41:21Z | 2026-11-10T21:43:50Z | 2 | 200 | 0 | 0 / 1 / 0 (0) | 0 | 59 / 0 | 84 |
| labo | simlocale | vm-wg | 2026-11-10T21:41:21Z | 2026-11-10T21:43:51Z | 1 | 200 | 0 | 0 / 0 / 0 (0) | 0 | 90 / 0 | 85 |
| labo | simouverture | ref-udp | 2026-11-10T21:40:12Z | 2026-11-10T21:41:12Z | 1 | 200 | 0 | 0 / 0 / 0 (0) | 0 | 0 / 0 | 0 |
| labo | simouverture | vm-udp | 2026-11-10T21:40:12Z | 2026-11-10T21:41:12Z | 1 | 200 | 0 | 0 / 0 / 0 (0) | 0 | 0 / 0 | 0 |
| labo | simouverture | vm-wg | 2026-11-10T21:40:12Z | 2026-11-10T21:41:13Z | 2 | 200 | 0 | 0 / 0 / 1 (1) | 0 | 0 / 0 | 0 |

Événements des journaux (sonde et routeur) : labo-sim4g : arret = 2, arret_demande = 1, cible_lancee = 6, demarrage = 2, demarrage_ntp_inconnu = 2, fin_programmee = 3, tranche_ok = 9; labo-simcoupure : arret = 1, cible_lancee = 3, demarrage = 1, demarrage_ntp_inconnu = 1, fin_programmee = 3, tranche_ok = 6; labo-simfibre : arret = 1, cible_lancee = 3, demarrage = 1, demarrage_ntp_inconnu = 1, fin_programmee = 3, routeur_demarrage = 1, tranche_ok = 9; labo-simlocale : arret = 1, cible_lancee = 3, demarrage = 1, demarrage_ntp_inconnu = 1, echec_ouverture = 12, fin_programmee = 3, tranche_arretee_sur_erreur_envoi = 2, tranche_ok = 6; labo-simouverture : arret = 1, cible_lancee = 3, demarrage = 1, demarrage_ntp_inconnu = 1, echec_ouverture = 4, fin_programmee = 3, tranche_ok = 4

## 7. Heure par heure (UTC, hors panne locale ; débit WAN moyen relevé par le routeur)

### labo · sim4g · ref-udp

| heure | envoyés | perte % | p50 | p95 | p99 | p95e | rafale max s | WAN ↓ / ↑ Mbit/s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 21 | 2775 | 0.00 | 0.2 | 0.4 | 1.1 | 0.4 | 0.00 | — |

### labo · sim4g · vm-udp

| heure | envoyés | perte % | p50 | p95 | p99 | p95e | rafale max s | WAN ↓ / ↑ Mbit/s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 21 | 2751 | 1.96 | 150.8 | 215.0 | 239.3 | 225.2 | 0.55 | — |

### labo · sim4g · vm-wg

| heure | envoyés | perte % | p50 | p95 | p99 | p95e | rafale max s | WAN ↓ / ↑ Mbit/s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 21 | 2767 | 1.95 | 151.3 | 215.9 | 240.1 | 225.9 | 0.55 | — |

### labo · simcoupure · ref-udp

| heure | envoyés | perte % | p50 | p95 | p99 | p95e | rafale max s | WAN ↓ / ↑ Mbit/s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 21 | 449 | 0.00 | 0.2 | 0.3 | 1.2 ⚠ | 0.3 | 0.00 | — |

### labo · simcoupure · vm-udp

| heure | envoyés | perte % | p50 | p95 | p99 | p95e | rafale max s | WAN ↓ / ↑ Mbit/s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 21 | 449 | 16.70 | 92.2 | 108.9 | 113.0 ⚠ | perdu | 15.00 | — |

### labo · simcoupure · vm-wg

| heure | envoyés | perte % | p50 | p95 | p99 | p95e | rafale max s | WAN ↓ / ↑ Mbit/s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 21 | 450 | 16.67 | 92.5 | 109.7 | 113.7 ⚠ | perdu | 15.00 | — |

### labo · simfibre · ref-udp

| heure | envoyés | perte % | p50 | p95 | p99 | p95e | rafale max s | WAN ↓ / ↑ Mbit/s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 21 | 3593 | 0.00 | 0.2 | 0.4 | 0.7 | 0.4 | 0.00 | 1.00 / 0.20 |

### labo · simfibre · vm-udp

| heure | envoyés | perte % | p50 | p95 | p99 | p95e | rafale max s | WAN ↓ / ↑ Mbit/s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 21 | 3573 | 0.53 | 91.3 | 108.5 | 116.5 | 109.7 | 0.05 | 1.00 / 0.20 |

### labo · simfibre · vm-wg

| heure | envoyés | perte % | p50 | p95 | p99 | p95e | rafale max s | WAN ↓ / ↑ Mbit/s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 21 | 3575 | 0.50 | 91.9 | 108.7 | 117.0 | 109.8 | 0.05 | 1.00 / 0.20 |

### labo · simlocale · ref-udp

| heure | envoyés | perte % | p50 | p95 | p99 | p95e | rafale max s | WAN ↓ / ↑ Mbit/s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 21 | 664 | 0.75 | 0.2 | 0.4 | 0.6 ⚠ | 0.4 | 0.80 | — |

### labo · simlocale · vm-udp

| heure | envoyés | perte % | p50 | p95 | p99 | p95e | rafale max s | WAN ↓ / ↑ Mbit/s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 21 | 659 | 0.76 | 91.9 | 108.1 | 117.1 ⚠ | 108.9 | 1.00 | — |

### labo · simlocale · vm-wg

| heure | envoyés | perte % | p50 | p95 | p99 | p95e | rafale max s | WAN ↓ / ↑ Mbit/s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 21 | 662 | 0.76 | 92.4 | 108.5 | 117.8 ⚠ | 109.5 | 1.00 | — |

### labo · simouverture · ref-udp

| heure | envoyés | perte % | p50 | p95 | p99 | p95e | rafale max s | WAN ↓ / ↑ Mbit/s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 21 | 300 | 0.00 | 0.3 | 0.5 | 2.0 ⚠ | 0.5 | 0.00 | — |

### labo · simouverture · vm-udp

| heure | envoyés | perte % | p50 | p95 | p99 | p95e | rafale max s | WAN ↓ / ↑ Mbit/s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 21 | 210 | 0.00 | 92.0 | 109.5 | 116.8 ⚠ | 109.5 | 18.00 | — |

### labo · simouverture · vm-wg

| heure | envoyés | perte % | p50 | p95 | p99 | p95e | rafale max s | WAN ↓ / ↑ Mbit/s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 21 | 184 | 0.00 | 92.8 | 110.1 ⚠ | 118.0 ⚠ | 110.1 ⚠ | 18.00 | — |

## 8. Flux clairsemé (`rare.sh` : un ping toutes les 20 à 60 s, liaison au repos)

Surcoût = p50 clairsemé − p50 du flux dense de la même cible (si `NOM` = `<cible>-rare`). Un surcoût net sur 4G signale le délai de réveil radio ; une perte nette dans le sens VM → routeur signale une traduction NAT expirée (chemin du CoA).

| site | accès | nom | envoyés | perte % | p50 | p95 | max | p50 dense | surcoût p50 ms |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| labo | simfibre | retour-vm | 55 | 1.8 | 91.5 | 108.0 ⚠ | 119.0 | — | — |
| labo | simfibre | vm-wg-rare | 54 | 1.9 | 87.9 | 106.0 ⚠ | 110.0 | 91.9 | -4.0 |
