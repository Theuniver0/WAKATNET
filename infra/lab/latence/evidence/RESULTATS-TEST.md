# Test local des outils de latence — 10/11/2026 (version révisée)

> **Ce test prouve que les outils fonctionnent et qu'ils retrouvent un profil connu. Il ne dit rien du Burkina.**
>
> Le réseau est **simulé** : deux espaces de noms réseau sur la même machine, et un dégradeur UDP en espace utilisateur (`outils/degradeur.py`). `tc netem` n'a pas pu servir : le noyau du conteneur n'a pas `sch_netem` (« Specified qdisc kind is unknown », revérifié pendant la révision). **`tc netem` n'est donc pas testé.**
>
> Ce fichier reprend **mot pour mot** les sorties utiles. Raison : `.gitignore` ignore les `*.log` de ce dossier (voir `../README.md` §5).
>
> Historique : `00-passage1-avant-correctif.log` est le premier passage de la **première** version (2 FAIL, corrigés alors) ; `00-revision-passage1.log` est le premier passage de la **version révisée** (7 FAIL, §4 ci-dessous) ; `00-test-local.log` est le passage final (§3).

## 1. Environnement

- Conteneur Linux cloud, Ubuntu 24.04, noyau 6.18.44, root, sans KVM, sans systemd, sans IPv6.
- irtt 0.9.0 (paquet Ubuntu `0.9.0-2ubuntu0.24.04.3`). Format JSON vérifié sur une vraie sortie : `version.json_format = 1`, `round_trips[].lost` ∈ `false` / `true` / `true_up` / `true_down`, `timestamps.client.send.wall` et `.monotonic` et `delay.rtt` en ns ; champ `send_err` (absent après une fin normale, `{}` après un signal, rempli après une erreur d'envoi, §5).
- wireguard-tools 1.0.20210914. **wireguard-go** (binaire hors du dépôt), parce que le noyau du conteneur n'a pas de module WireGuard.
- Python 3.13.18. nftables pour simuler une panne amont (P5) et pour le test partiel de `serveur-vm.sh`.

## 2. Commandes rejouées

```bash
sudo WG_GO=/chemin/wireguard infra/lab/latence/outils/test-local.sh infra/lab/latence/evidence   # ≈ 12 min
sudo infra/lab/latence/outils/test-serveur-vm.sh > infra/lab/latence/evidence/serveur-vm-partiel.txt
sudo infra/lab/latence/outils/essai-irtt.sh > infra/lab/latence/evidence/irtt-essais.txt
```

`test-local.sh` enchaîne les 5 profils, puis `analyse.py --groupes-hetzner vm`, puis `verifier-test.py` (73 contrôles contre le profil injecté), puis `test-analyse.py` (67 contrôles sur 11 jeux synthétiques aux valeurs calculées à la main, dont les jeux J1 à J6 de la relecture adversariale). Vérifié après la fin : `ip netns list` est vide, et il ne reste aucun processus irtt, wireguard, dégradeur, `rare.sh` ou récepteur syslog.

## 3. Sortie complète du passage final (`00-test-local.log`)

```text
test-local.sh  2026-11-10T21:32:53Z  noyau 6.18.44-fc-v338  irtt 0.9.0  wireguard-tools v1.0.20210914 - https://git.zx2c4.com/wireguard-tools/  python Python 3.13.18
P1 simfibre début 21:33:00
P1 fin 21:36:01
P2 sim4g début 21:36:08
P2 SIGTERM au groupe de processus 16336 (7 processus) 21:36:53
P2 reprise 21:36:53
P2 fin 21:38:29
P3 simcoupure début 21:38:37 (coupure prévue de +40 s à +55 s)
P3 fin 21:40:07
P4 simouverture début 21:40:12 (cible coupée de +0 s à +20 s du dégradeur, soit environ 18 s vues par la sonde)
P4 fin 21:41:13
P5 simlocale début 21:41:20
P5 panne amont : début 21:42:00
P5 panne amont : fin 21:42:12
P5 interface tombée : début 21:42:55
P5 interface tombée : fin 21:43:01
P5 fin 21:43:51
fin des captures 2026-11-10T21:43:51Z
écrit : /home/user/WAKATNET/infra/lab/latence/evidence/resultat.md /home/user/WAKATNET/infra/lab/latence/evidence/resultat.csv /home/user/WAKATNET/infra/lab/latence/evidence/resultat-heures.csv /home/user/WAKATNET/infra/lab/latence/evidence/resultat-correlation.csv /home/user/WAKATNET/infra/lab/latence/evidence/resultat-soirees.csv /home/user/WAKATNET/infra/lab/latence/evidence/resultat-appariement.csv /home/user/WAKATNET/infra/lab/latence/evidence/resultat-rare.csv
PASS P1 vm-udp pertes = paquets jetés : irtt 19, dégradeur 19
PASS P1 vm-udp perte % dans [0,2 ; 1,0] : 0.532
PASS P1 vm-udp p50 dans [88 ; 95] ms : 91.33
PASS P1 vm-udp p95 dans [102 ; 113] ms (théorie 90 + 1,645 × 10 ≈ 106) : 108.514
PASS P1 vm-udp gigue dans [9 ; 14] ms (théorie 2σ/√π ≈ 11,3) : 11.383
PASS P1 vm-udp rafale max ≤ 3 paquets : 1
PASS P2 vm-udp pertes = paquets jetés (arrêt par SIGTERM au groupe) : irtt 54, dégradeur 54
PASS P2 vm-udp perte % dans [1,0 ; 3,5] : 1.963
PASS P2 vm-udp p50 dans [145 ; 160] ms : 150.761
PASS P2 vm-udp p95 dans [200 ; 232] ms (théorie ≈ 216) : 214.99
PASS P2 vm-udp r ajusté dans [12 ; 45] % (injecté 25) : 24.074
PASS P2 vm-udp rafale max ≥ 3 paquets (pertes groupées) : 11
PASS P2 vm-udp une tranche interrompue (SIGTERM) reconnue : 1
PASS P3 vm-udp rafale max dans [14,8 ; 15,8] s : 15.0
PASS P3 vm-udp rafale max dans [74 ; 78] paquets (15 s / 200 ms = 75) : 75
PASS P3 vm-udp une seule rafale ≥ 10 s : 1
PASS P3 vm-udp pertes hors coupure ≤ 0 : perdus 75, rafale 75
PASS P3 vm-udp panne locale = 0 s (témoin joignable) : 0
PASS P3 vm-udp perte HL = perte brute : 16.704 / 16.704
PASS P3 vm-udp K = 1, T = 1,1 s : % d'expiration = % de perte (aucun RTT > 1,05 s) : 16.7038 / 16.704
PASS P3 vm-udp K = 3, T = 5 s : la coupure fait encore basculer (2 × 5 s < 15 s) : 5.5679 %, 1 épisode
PASS P3 vm-udp Gilbert ajusté hors coupure > 10 s : p ≤ 0 % (la coupure n'y entre pas) : 0.0
PASS P4 vm-udp indisponibilité d'ouverture dans [70 ; 110] paquets (≈ 18 s / 200 ms) : 90
PASS P4 vm-udp silence max dans [16 ; 24] s : 18.747
PASS P4 vm-udp aucune perte réelle : 0.0
PASS P5 vm-udp panne locale dans [14 ; 24] s (12 s + 6 s, moins les secondes de bord) : 17
PASS P5 vm-udp brut : au moins une rafale ≥ 10 s : 1
PASS P5 vm-udp HL : aucune rafale ≥ 3 s : 0
PASS P5 vm-udp HL : perte < 1 % (brut nettement plus haut) : HL 0.759 / brut 8.275
PASS P5 vm-udp arrêt d'irtt sur erreur d'envoi reconnu : 1
PASS P1 vm-wg pertes = paquets jetés : irtt 18, dégradeur 20
PASS P1 vm-wg perte % dans [0,2 ; 1,0] : 0.503
PASS P1 vm-wg p50 dans [88 ; 95] ms : 91.908
PASS P1 vm-wg p95 dans [102 ; 113] ms (théorie 90 + 1,645 × 10 ≈ 106) : 108.717
PASS P1 vm-wg gigue dans [9 ; 14] ms (théorie 2σ/√π ≈ 11,3) : 11.383
PASS P1 vm-wg rafale max ≤ 3 paquets : 1
PASS P2 vm-wg pertes = paquets jetés (arrêt par SIGTERM au groupe) : irtt 54, dégradeur 54
PASS P2 vm-wg perte % dans [1,0 ; 3,5] : 1.952
PASS P2 vm-wg p50 dans [145 ; 160] ms : 151.312
PASS P2 vm-wg p95 dans [200 ; 232] ms (théorie ≈ 216) : 215.906
PASS P2 vm-wg r ajusté dans [12 ; 45] % (injecté 25) : 24.074
PASS P2 vm-wg rafale max ≥ 3 paquets (pertes groupées) : 11
PASS P2 vm-wg une tranche interrompue (SIGTERM) reconnue : 1
PASS P3 vm-wg rafale max dans [14,8 ; 15,8] s : 15.0
PASS P3 vm-wg rafale max dans [74 ; 78] paquets (15 s / 200 ms = 75) : 75
PASS P3 vm-wg une seule rafale ≥ 10 s : 1
PASS P3 vm-wg pertes hors coupure ≤ 1 : perdus 75, rafale 75
PASS P3 vm-wg panne locale = 0 s (témoin joignable) : 0
PASS P3 vm-wg perte HL = perte brute : 16.667 / 16.667
PASS P3 vm-wg K = 1, T = 1,1 s : % d'expiration = % de perte (aucun RTT > 1,05 s) : 16.6667 / 16.667
PASS P3 vm-wg K = 3, T = 5 s : la coupure fait encore basculer (2 × 5 s < 15 s) : 5.5556 %, 1 épisode
PASS P3 vm-wg Gilbert ajusté hors coupure > 10 s : p ≤ 0.5 % (la coupure n'y entre pas) : 0.0
PASS P4 vm-wg indisponibilité d'ouverture dans [70 ; 110] paquets (≈ 18 s / 200 ms) : 90
PASS P4 vm-wg silence max dans [16 ; 27] s : 24.077
PASS P4 vm-wg aucune perte réelle : 0.0
PASS P5 vm-wg panne locale dans [14 ; 24] s (12 s + 6 s, moins les secondes de bord) : 17
PASS P5 vm-wg brut : au moins une rafale ≥ 10 s : 1
PASS P5 vm-wg HL : aucune rafale ≥ 3 s : 0
PASS P5 vm-wg HL : perte < 1 % (brut nettement plus haut) : HL 0.755 / brut 12.048
PASS témoin ref-udp simfibre : aucune perte : 0.0 %, 0 virtuels
PASS témoin ref-udp simcoupure : aucune perte : 0.0 %, 0 virtuels
PASS témoin ref-udp simouverture : aucune perte : 0.0 %, 0 virtuels
PASS P5 corrélation ref/vm : trop peu d'épisodes hors locale -> indéterminé : indéterminé : 0 épisode(s) < 10
PASS P2 SIGTERM au groupe : tranche écrite pour les 3 cibles : 3 lignes interrompue=oui
PASS P5 journal : send_err=oui : 2 ligne(s)
PASS P1 flux clairsemé vm-wg-rare : ≥ 30 pings : 54
PASS P1 flux clairsemé vm-wg-rare : p50 dans [85 ; 100] ms : 87.9
PASS P1 flux clairsemé retour-vm : ≥ 30 pings : 55
PASS P1 flux clairsemé retour-vm : p50 dans [85 ; 100] ms : 91.5
PASS P1 flux clairsemé : surcoût p50 calculé et |surcoût| < 10 ms (pas de radio ici) : -4.008
PASS P1 syslog : débit WAN reçu dans [0,9 ; 1,1] Mbit/s : ['1.0']
PASS P1 syslog : débit WAN émis dans [0,18 ; 0,22] Mbit/s : ['0.2']
PASS P1 syslog : ligne étrangère ignorée, repère de démarrage gardé : 4 lignes gardées
RÉSULTAT : tous les contrôles passent (0 échec)
PASS J0 a perte % brut : obtenu '7.5', attendu 7.5
PASS J0 a rafale max paquets : obtenu '75', attendu 75
PASS J0 a rafale max s (pertes mesurées) : obtenu '15.0', attendu 15.0
PASS J0 a rafale max silence s : obtenu '15.0', attendu 15.0
PASS J0 a p50 ms : obtenu '100.0', attendu 100.0
PASS J0 a max ms : obtenu '1500.0', attendu 1500.0
PASS J0 a perte montante : obtenu '37', attendu 37
PASS J0 a brut échec K=1 T=1 s % : obtenu '7.6', attendu 7.6
PASS J0 a brut échec K=1 T=2 s % : obtenu '7.5', attendu 7.5
PASS J0 a brut échec K=2 T=1 s % : obtenu '7.0', attendu 7.0
PASS J0 a rafales >= 10 s : obtenu '1', attendu 1
PASS J0 b rafale max s : obtenu '5.0', attendu 5.0
PASS J0 b rafales >= 1 s : obtenu '2', attendu 2
PASS J0 a panne locale s (a, b, c muets : paquets 100-124) : obtenu '5', attendu 5
PASS J0 a HL envoyés (1000 - 25) : obtenu '975', attendu 975
PASS J0 a HL perte % (50 / 975) : obtenu '5.128', attendu 5.128
PASS J0 a HL échec K=1 T=1 s % (51 / 975) : obtenu '5.2308', attendu 5.2308
PASS J0 a,b panne a s : obtenu '15', attendu 15
PASS J0 a,b simultanées s : obtenu '5', attendu 5
PASS J0 a,b P(b|a) brut % : obtenu '33.333', attendu 33.333
PASS J0 a,b panne locale s : obtenu '5', attendu 5
PASS J0 a,b P(b|a) HL % (secondes) : obtenu '0.0', attendu 0.0
PASS J0 a,c P(c|a) HL % (secondes) : obtenu '100.0', attendu 100.0
PASS J0 a,b 1 épisode < 10 : indéterminé : obtenu '', attendu ''
PASS J1 p50 : obtenu '500.0', attendu 500
PASS J1 p95 : obtenu '950.0', attendu 950
PASS J1 p99 : obtenu '990.0', attendu 990
PASS J1 p999 : obtenu '999.0', attendu 999
PASS J2 lent p99 reçus : obtenu '900.0', attendu 900.0
PASS J2 perd p99 reçus (le survivant paraît meilleur) : obtenu '100.0', attendu 100.0
PASS J2 perd p99 effectif = perdu : obtenu 'inf', attendu 'inf'
PASS J2 perd p95 effectif : obtenu '100.0', attendu 100.0
PASS J2 lent p99 effectif : obtenu '900.0', attendu 900.0
PASS J3 paquets en vol retirés : obtenu '1', attendu 1
PASS J3 rafale max paquets : obtenu '59', attendu 59
PASS J3 rafale max s : obtenu '11.8', attendu 11.8
PASS J3 fin anticipée inexpliquée signalée : obtenu '1', attendu 1
PASS J3b cause SIGTERM : obtenu '1', attendu 1
PASS J3b paquets en vol retirés : obtenu '1', attendu 1
PASS J3c cause erreur d'envoi : obtenu '1', attendu 1
PASS J4 sans témoin : P(nbg|fsn) indéterminé : obtenu 'indéterminé : aucun témoin hors Hetzner', attendu 'indéterminé : aucun témoin hors Hetzner'
PASS J4 sans témoin : HL vide : obtenu '', attendu ''
PASS J4 sans témoin : perte HL = brut (rien retiré) : obtenu '30.0', attendu 30.0
PASS J4b panne locale s = 0 : obtenu '0', attendu 0
PASS J4b P(nbg|fsn) HL % (secondes) = 100 : obtenu '100.0', attendu 100.0
PASS J4b 1 épisode : indéterminé : obtenu 'indéterminé : 1 épisode(s) < 10', attendu 'indéterminé : 1 épisode(s) < 10'
PASS J4c panne locale s : obtenu '5', attendu 5
PASS J4c épisodes de fsn hors locale : obtenu '12', attendu 12
PASS J4c P(nbg|fsn) HL en épisodes = 6/12 : obtenu '50.0', attendu 50.0
PASS J4c P(nbg|fsn) HL en secondes = 18/36 : obtenu '50.0', attendu 50.0
PASS J4c fsn perte HL (180 / 1475) : obtenu '12.203', attendu 12.203
PASS J5 bascules/jour = % pic x 300 / 100 : obtenu '0.008', attendu 0.008
PASS J5 bascules/jour < 0,1 malgré des dizaines d'épisodes : obtenu True, attendu True
PASS J6 strict K=2 T=1 (199/999) : obtenu '19.9199', attendu 19.9199
PASS J6 tardif K=2 T=1 (99/999) : obtenu '9.9099', attendu 9.9099
PASS J7 --exclure : perte 0 : obtenu '0.0', attendu 0.0
PASS J7 --exclure : 925 envoyés : obtenu '925', attendu 925
PASS J8 série x@200ms : obtenu '500', attendu 500
PASS J8 série x@500ms : obtenu '200', attendu 200
PASS J9 saut d'horloge signalé : obtenu '1', attendu 1
PASS J9 durée = 200 s (horloge monotone) : obtenu '0.056', attendu 0.056
PASS J9 couverture 100 % : obtenu '100.0', attendu 100.0
PASS J10 heures comparées : obtenu '8', attendu 8
PASS J10 verdict apparié : obtenu 'fsn-wg meilleur', attendu 'fsn-wg meilleur'
PASS J10 p99.9 fsn soirée 1 : obtenu '100.0', attendu 100.0
PASS J10 p99.9 fsn soirée 2 : obtenu '400.0', attendu 400.0
PASS J10 IC bootstrap p95e présent : obtenu True, attendu True
RÉSULTAT : 0 échec(s) sur les contrôles ci-dessus : tout conforme
fin 2026-11-10T21:44:28Z
```

## 4. Premier passage de la version révisée : 7 FAIL, causes et corrections

Lignes en échec de `00-revision-passage1.log` :

```text
FAIL P2 vm-udp pertes = paquets jetés (arrêt par SIGTERM au groupe) : irtt 39, dégradeur 54
FAIL P2 vm-udp une tranche interrompue (SIGTERM) reconnue : 0
FAIL P2 vm-wg pertes = paquets jetés (arrêt par SIGTERM au groupe) : irtt 38, dégradeur 54
FAIL P2 vm-wg une tranche interrompue (SIGTERM) reconnue : 0
FAIL P3 vm-wg toutes les pertes sont dans la coupure : perdus 76, rafale 75
FAIL P3 vm-wg Gilbert ajusté hors coupure > 10 s : aucune perte (p = 0) : 0.269
FAIL P2 SIGTERM au groupe : tranche écrite pour les 3 cibles : 0 lignes interrompue=oui
RÉSULTAT : ÉCHEC — P2 vm-udp pertes = paquets jetés (arrêt par SIGTERM au groupe), P2 vm-udp une tranche interrompue (SIGTERM) reconnue, P2 vm-wg pertes = paquets jetés (arrêt par SIGTERM au groupe), P2 vm-wg une tranche interrompue (SIGTERM) reconnue, P3 vm-wg toutes les pertes sont dans la coupure, P3 vm-wg Gilbert ajusté hors coupure > 10 s : aucune perte (p = 0), P2 SIGTERM au groupe : tranche écrite pour les 3 cibles
RÉSULTAT : 0 échec(s) sur les contrôles ci-dessus : tout conforme
```

- **P2, 5 FAIL : tranche perdue quand SIGTERM touche tout le groupe de processus.** C'est un vrai défaut de `sonde.sh`, que le nouveau test (SIGTERM au groupe, comme systemd avec `KillMode=control-group`) a révélé : les 45 premières secondes de P2 manquaient (39 pertes au lieu de 54, aucune ligne `interrompue=oui`). Cause, isolée par `outils/essai-irtt.sh` (§5) : irtt qui reçoit **deux signaux différents presque en même temps** (le SIGTERM du groupe, puis le SIGINT que `sonde.sh` lui envoyait) sort avec le code 3 **sans écrire sa tranche**. Correction dans `sonde.sh` : à l'arrêt, ignorer les signaux suivants, laisser 2 s à irtt pour finir seul, et ne lui envoyer SIGINT que s'il tourne encore. Vérifié avant de rejouer, sur un serveur local : arrêt par le groupe en 0,1 s et arrêt par le seul processus principal en 2,1 s, avec la tranche écrite dans les deux cas. Le README conseille en plus `KillMode=mixed`.
- **P3 vm-wg, 2 FAIL : une perte isolée dans le tunnel, 5 s après la fin de la coupure**, sans que le dégradeur l'ait jetée (75 paquets coupés par le dégradeur, 76 pertes vues par irtt). Hypothèse, non vérifiée : reprise de la poignée de main WireGuard après 15 s sans réponse. Ce n'est pas un défaut des outils ; le contrôle tolère désormais 1 perte hors coupure dans le tunnel (et p de Gilbert ≤ 0,5 %), comme `verifier-test.py` tolérait déjà 3 paquets d'écart dans le tunnel pour « pertes = paquets jetés ». Au passage final, cette perte ne s'est pas reproduite (75 = 75).

## 5. Comportements d'irtt vérifiés (`irtt-essais.txt`)

```text
irtt 0.9.0  2026-11-10T21:45:26Z
### 1. Signaux (client vers un serveur local, -i 100ms -d 20s, signaux envoyés 2 s après le départ)
TERM seul                    code 0  tranche écrite : oui
INT seul                     code 0  tranche écrite : oui
TERM puis INT, aussitôt      code 3  tranche écrite : NON
INT puis TERM, aussitôt      code 3  tranche écrite : NON
TERM puis INT, 50 ms après   code 0  tranche écrite : oui
TERM puis TERM, aussitôt     code 0  tranche écrite : oui
### 2. Interface de la sonde tombée pendant une tranche (veth down 4 s, 3 s après le départ)
code de sortie d'irtt : 0
Terminated due to send error: write udp4 10.88.0.1:42779->10.88.0.2:2112: write: network is unreachable
        timer error  4.63µs   281µs           690µs   220µs
             timer stats: 0/15 (0.00%) missed, 0.14% error
durée demandée 12.0 s ; durée réelle 3.0 s ; 15 paquets ; 0 perdus
send_err : {"Op": "write", "Net": "udp4", "Source": {"IP": "10.88.0.1", "Port": 42779, "Zone": ""}, "Addr": {"IP": "10.88.0.2", "Port": 2112, "Zone": ""}, "Err": {"Syscall": "write", "Err": 101}}
```

Conséquences : `sonde.sh` n'envoie plus deux signaux différents à irtt (§4) ; une fin de tranche sur erreur d'envoi est classée à part (`send_err=oui` dans le journal, « erreur d'envoi » dans l'analyse). Sur le terrain, cela arrivera surtout si l'interface de la sonde tombe ; si c'est le WAN du routeur qui tombe, la sonde, sur le LAN, ne verra probablement que des pertes (non vérifié).

## 6. Ce que chaque profil montre (passage final)

Les deux dégradeurs d'un profil (UDP direct et WireGuard) ont la même graine : les colonnes `vm-udp` et `vm-wg` ne sont pas deux échantillons indépendants. `ref-udp`, le témoin, ne passe par aucun dégradeur.

| Profil injecté | Ce que retrouve `analyse.py` (vm-udp / vm-wg) | Contrôle exact |
|---|---|---|
| **P1** 90 ms ± 10 ms, 0,5 % de perte indépendante, sonde à 50 ms, 180 s | p50 91,3 / 91,9 ms ; p95 108,5 / 108,7 ms (théorie ≈ 106 + temps de traitement) ; gigue 11,4 ms (théorie 2σ/√π = 11,3) ; perte 0,53 / 0,50 % ; rafale max 1 paquet (0,05 s) | hors tunnel 19 = 19 ; tunnel 18 pertes pour 20 paquets jetés (tolérance de 3 : le dégradeur jette aussi des paquets WireGuard qui ne sont pas des sondes) |
| **P2** 150 ms ± 40 ms, Gilbert p = 0,51 %, r = 25 %, sonde à 50 ms, SIGTERM **au groupe** à 45 s puis reprise | p50 150,8 / 151,3 ms ; p95 215,0 / 215,9 ms (théorie ≈ 216) ; perte 1,96 / 1,95 % ; rafale max 11 paquets ; Gilbert ajusté p = 0,48 %, r = 24,1 % ; 1 fin anticipée « SIGTERM » par cible, 3 paquets en vol retirés | 54 = 54 ; 3 lignes `interrompue=oui` |
| **P3** coupure franche de 15 s, sonde à 200 ms ; témoin joignable | rafale max 75 paquets / 15,0 s ; une seule rafale ≥ 10 s ; **panne locale 0 s** (le témoin répond) ; perte HL = perte brute ; Gilbert hors coupure > 10 s : p = 0 ; K = 3, T = 5 s : encore un épisode de bascule (2 × 5 s < 15 s) | 75 pertes = 75 paquets coupés |
| **P4** cible injoignable ≈ 18 s au démarrage, fin par `-F` | 2 `echec_ouverture` de 9 s par cible (4 essais de 2 s + 1 s de pause) ; 90 paquets « indisponibles » ; pertes mesurées 18,0 s, silence 18,7 / 24,1 s ; 0 perte réelle ; dans le tunnel, une tranche close au bout de 5 s (fin anticipée « inexpliquée », 1 paquet en vol retiré : le phénomène déjà vu après une poignée de main) | 90 paquets virtuels = 18 s / 200 ms |
| **P5** panne amont de 12 s (témoin compris), puis interface de la sonde tombée 6 s | **panne locale 17 s** ; perte brute 8,3 / 12,0 %, **hors panne locale 0,76 / 0,76 %** ; brut : une rafale ≥ 10 s ; HL : aucune rafale ≥ 3 s ; hors tunnel, irtt s'arrête sur erreur d'envoi (`send_err=oui`), puis `echec_ouverture` toutes les secondes (« network is unreachable ») jusqu'au retour de l'interface ; dans le tunnel, de simples pertes ; corrélation ref / vm « indéterminé : 0 épisode(s) < 10 » | 84 à 85 paquets retirés hors locale ≈ 17 s × 5 |
| **Flux clairsemé** (P1, 2 à 4 s) | 54 pings sonde → VM, 55 VM → sonde ; p50 87,9 et 91,5 ms ; surcoût par rapport au flux dense : −4,0 ms (aucune radio ici : seul le fonctionnement est prouvé) | — |
| **Syslog** (P1, lignes simulées) | 4 lignes gardées sur 5 reçues (la ligne étrangère est écartée) ; débit WAN 1,0 Mbit/s reçu, 0,2 émis = valeurs injectées | 7,5 Mo/min = 1,0 Mbit/s |

Extrait du tableau principal (`resultat.md`) :

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

Timeout émulé au pic, hors panne locale, K = 2 (*% strict* / *% tardif* (*fausses bascules attendues par jour*)) :

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

Corrélation des pannes :

| site | accès | X | Y | s communes | panne X s | simultanées s | P(Y\|X) % brut | panne locale s | non classables s | P(Y\|X) HL % (s) | épisodes X HL | P(Y\|X) HL % (épisodes) | statut |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| labo | sim4g | ref-udp | vm-udp | 140 | 0 | 0 | — | 0 | 0 | — | 0 | — | indéterminé : 0 épisode(s) < 10 |
| labo | simcoupure | ref-udp | vm-udp | 91 | 0 | 0 | — | 0 | 0 | — | 0 | — | indéterminé : 0 épisode(s) < 10 |
| labo | simfibre | ref-udp | vm-udp | 181 | 0 | 0 | — | 0 | 0 | — | 0 | — | indéterminé : 0 épisode(s) < 10 |
| labo | simlocale | ref-udp | vm-udp | 150 | 17 | 17 | 100.0 | 17 | 0 | — | 0 | — | indéterminé : 0 épisode(s) < 10 |
| labo | simouverture | ref-udp | vm-udp | 61 | 0 | 0 | — | 0 | 0 | — | 0 | — | indéterminé : 0 épisode(s) < 10 |

Flux clairsemé :

| site | accès | nom | envoyés | perte % | p50 | p95 | max | p50 dense | surcoût p50 ms |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| labo | simfibre | retour-vm | 55 | 1.8 | 91.5 | 108.0 ⚠ | 119.0 | — | — |
| labo | simfibre | vm-wg-rare | 54 | 1.9 | 87.9 | 106.0 ⚠ | 110.0 | 91.9 | -4.0 |

## 7. Journaux (extraits mot pour mot)

P2, SIGTERM au groupe puis reprise :

```text
2026-11-10T21:36:08Z epoch=1794346568 demarrage site=labo acces=sim4g intervalle=50ms tranche=60s longueur=0 extra= uptime_s=5678.37 fin_prevue=1794346658 ntp_synchronise=inconnu irtt=0.9.0 hote=vm
2026-11-10T21:36:53Z epoch=1794346613 arret_demande
2026-11-10T21:36:53Z epoch=1794346613 tranche_ok cible=vm-udp fichier=2026-11-10-labo-sim4g-vm-udp.T213608Z.json.gz interrompue=oui
2026-11-10T21:36:53Z epoch=1794346613 tranche_ok cible=ref-udp fichier=2026-11-10-labo-sim4g-ref-udp.T213608Z.json.gz interrompue=oui
2026-11-10T21:36:53Z epoch=1794346613 tranche_ok cible=vm-wg fichier=2026-11-10-labo-sim4g-vm-wg.T213608Z.json.gz interrompue=oui
2026-11-10T21:36:53Z epoch=1794346613 arret
2026-11-10T21:36:53Z epoch=1794346613 demarrage site=labo acces=sim4g intervalle=50ms tranche=60s longueur=0 extra= uptime_s=5723.51 fin_prevue=1794346708 ntp_synchronise=inconnu irtt=0.9.0 hote=vm
2026-11-10T21:38:29Z epoch=1794346709 arret fin_programmee=oui
```

P4, échecs d'ouverture et tranche courte dans le tunnel :

```text
2026-11-10T21:40:21Z epoch=1794346821 echec_ouverture cible=vm-wg debut=1794346812 fin=1794346821 rc=1 erreur=[OpenTimeout]_no_reply_from_server
2026-11-10T21:40:21Z epoch=1794346821 echec_ouverture cible=vm-udp debut=1794346812 fin=1794346821 rc=1 erreur=[OpenTimeout]_no_reply_from_server
2026-11-10T21:40:30Z epoch=1794346830 echec_ouverture cible=vm-udp debut=1794346821 fin=1794346830 rc=1 erreur=[OpenTimeout]_no_reply_from_server
2026-11-10T21:40:30Z epoch=1794346830 echec_ouverture cible=vm-wg debut=1794346821 fin=1794346830 rc=1 erreur=[OpenTimeout]_no_reply_from_server
2026-11-10T21:40:35Z epoch=1794346835 tranche_ok cible=vm-wg fichier=2026-11-10-labo-simouverture-vm-wg.T214030Z.json.gz rc=0 send_err=non
2026-11-10T21:41:13Z epoch=1794346873 tranche_ok cible=vm-wg fichier=2026-11-10-labo-simouverture-vm-wg.T214035Z.json.gz rc=0 send_err=non
```

P5, interface tombée (6 premières lignes) :

```text
2026-11-10T21:42:55Z epoch=1794346975 tranche_ok cible=ref-udp fichier=2026-11-10-labo-simlocale-ref-udp.T214120Z.json.gz rc=0 send_err=oui
2026-11-10T21:42:56Z epoch=1794346976 tranche_ok cible=vm-udp fichier=2026-11-10-labo-simlocale-vm-udp.T214120Z.json.gz rc=0 send_err=oui
2026-11-10T21:42:57Z epoch=1794346977 echec_ouverture cible=ref-udp debut=1794346975 fin=1794346977 rc=1 erreur=Error:_dial_udp4_:0->10.77.0.2:2112:_connect:_network_is_unreachable
2026-11-10T21:42:57Z epoch=1794346977 echec_ouverture cible=vm-udp debut=1794346976 fin=1794346977 rc=1 erreur=Error:_dial_udp4_:0->10.77.0.2:3112:_connect:_network_is_unreachable
2026-11-10T21:42:58Z epoch=1794346978 echec_ouverture cible=ref-udp debut=1794346977 fin=1794346978 rc=1 erreur=Error:_dial_udp4_:0->10.77.0.2:2112:_connect:_network_is_unreachable
2026-11-10T21:42:58Z epoch=1794346978 echec_ouverture cible=vm-udp debut=1794346977 fin=1794346978 rc=1 erreur=Error:_dial_udp4_:0->10.77.0.2:3112:_connect:_network_is_unreachable
```

Journal du routeur reçu par syslog (P1, lignes **simulées** au format supposé) :

```text
2026-11-10T21:33:01Z epoch=1794346381 src=127.0.0.1 <12>script,warning wakatnet-labo demarrage routeur uptime=00:00:41 ntp=synchronized attente_ntp_s=35
2026-11-10T21:33:01Z epoch=1794346381 src=127.0.0.1 <14>script,info wakatnet-labo wan iface=ether1 rx=1000000 tx=500000
2026-11-10T21:34:01Z epoch=1794346441 src=127.0.0.1 <14>script,info wakatnet-labo wan iface=ether1 rx=8500000 tx=2000000
2026-11-10T21:35:01Z epoch=1794346501 src=127.0.0.1 <14>script,info wakatnet-labo wan iface=ether1 rx=16000000 tx=3500000
```

Compteurs des dégradeurs :

```text
degradeur 10.77.0.2:3112 -> 127.0.0.1:2112 delai=150.0ms gigue=40.0ms perte=0.0% ge_p=0.51 ge_r=25.0 coupures=None
degradeur fin {'aller': 2760, 'perdus_aller': 54, 'coupes': 0}
degradeur 10.77.0.2:51821 -> 127.0.0.1:51820 delai=150.0ms gigue=40.0ms perte=0.0% ge_p=0.51 ge_r=25.0 coupures=None
degradeur fin {'aller': 2784, 'perdus_aller': 54, 'coupes': 0}
degradeur 10.77.0.2:3112 -> 127.0.0.1:2112 delai=90.0ms gigue=10.0ms perte=0.0% ge_p=None ge_r=None coupures=['40:15']
degradeur fin {'aller': 453, 'perdus_aller': 0, 'coupes': 75}
degradeur 10.77.0.2:51821 -> 127.0.0.1:51820 delai=90.0ms gigue=10.0ms perte=0.0% ge_p=None ge_r=None coupures=['40:15']
degradeur fin {'aller': 458, 'perdus_aller': 0, 'coupes': 75}
degradeur 10.77.0.2:3112 -> 127.0.0.1:2112 delai=90.0ms gigue=10.0ms perte=0.5% ge_p=None ge_r=None coupures=None
degradeur fin {'aller': 3579, 'perdus_aller': 19, 'coupes': 0}
degradeur 10.77.0.2:51821 -> 127.0.0.1:51820 delai=90.0ms gigue=10.0ms perte=0.5% ge_p=None ge_r=None coupures=None
degradeur fin {'aller': 3696, 'perdus_aller': 20, 'coupes': 0}
degradeur 10.77.0.2:3112 -> 127.0.0.1:2112 delai=90.0ms gigue=10.0ms perte=0.0% ge_p=None ge_r=None coupures=None
degradeur fin {'aller': 657, 'perdus_aller': 0, 'coupes': 0}
degradeur 10.77.0.2:51821 -> 127.0.0.1:51820 delai=90.0ms gigue=10.0ms perte=0.0% ge_p=None ge_r=None coupures=None
degradeur fin {'aller': 665, 'perdus_aller': 0, 'coupes': 0}
degradeur 10.77.0.2:3112 -> 127.0.0.1:2112 delai=90.0ms gigue=10.0ms perte=0.0% ge_p=None ge_r=None coupures=['0:20']
degradeur fin {'aller': 220, 'perdus_aller': 0, 'coupes': 8}
degradeur 10.77.0.2:51821 -> 127.0.0.1:51820 delai=90.0ms gigue=10.0ms perte=0.0% ge_p=None ge_r=None coupures=['0:20']
degradeur fin {'aller': 211, 'perdus_aller': 0, 'coupes': 4}
```

## 8. Jeux de la relecture adversariale, rejoués (`relecture-jeux.txt`)

Les données produites par le `fabrique.py` du relecteur ont été relues telles quelles par `analyse.py` révisé. Les mêmes cas, avec leurs valeurs attendues après correction, sont aussi dans `outils/test-analyse.py` (J1 à J6, tous PASS au §3).

```text
# Jeux de la relecture adversariale du 10/11/2026 (données produites par le gen/fabrique.py du relecteur, lues telles quelles), rejoués avec analyse.py révisé
# commande : analyse.py DONNEES/jN --sortie re/jN (options par défaut : S = 50 ms, --groupes-hetzner fsn,nbg,hel)
j1 (RTT 1..1000 ms) : p50 500.0 p95 950.0 p99 990.0 p99.9 999.0
j2 lent : p99 reçus 900.0, p99.9 reçus 900.0, p95e 100.0, p99e 900.0, p99.9e 900.0
j2 perd : p99 reçus 100.0, p99.9 reçus 100.0, p95e 100.0, p99e inf, p99.9e inf
j3 (coupure réelle de 12 s en fin de tranche, RTT aberrant 4 s) : en vol retirés 1, pertes gardées 59, rafale 59 paquets / 11.8 s, fin inexpliquée 1
j4 (panne commune fsn/nbg/hel, aucun témoin) fsn-wg/hel-wg : P(Y|X) brut 100.0, HL '', statut « indéterminé : aucun témoin hors Hetzner »
j4 (panne commune fsn/nbg/hel, aucun témoin) fsn-wg/nbg-wg : P(Y|X) brut 100.0, HL '', statut « indéterminé : aucun témoin hors Hetzner »
j4 (panne commune fsn/nbg/hel, aucun témoin) hel-wg/nbg-wg : P(Y|X) brut 100.0, HL '', statut « indéterminé : aucun témoin hors Hetzner »
j5 (24 h, perte indépendante 0,5 %) : perte 0.519 % ; K=2 T=1 s au pic : 0.0028 % des instants, 0.008 fausses bascules attendues par jour (300 auth/j), 18 épisodes sur toute la mesure
j6 (10 % des RTT à 1,5 s) : K=1 T=1 s 10.0 % ; K=2 T=1 s strict 0.0 % / tardif 0.0 %
```

## 9. `serveur-vm.sh` : test partiel

Voir `serveur-vm-partiel.txt` (produit par `outils/test-serveur-vm.sh`). Conditions : `systemctl` remplacé par un bouchon qui ne fait qu'afficher l'appel, espaces de noms réseau et de montage isolés (les règles nftables ne touchent pas l'hôte ; `/etc/wireguard`, `/etc/systemd/system` et `/etc/nftables.conf` masqués). Constaté :
- `installer` deux fois de suite, avec `WG_ADRESSE_R` : code 0, clé générée au premier passage seulement, `Address = 10.254.213.1/24, 10.254.214.1/24` ;
- clé privée en mode 600 ; `wg-labo.conf` sans `PrivateKey` ; surcharge du service irtt écrite ; règles nftables chargées ;
- `ajouter-pair` en 10.254.213.0/24 (L) et en 10.254.214.0/24 (R) acceptés ; **refus d'une IP déjà attribuée à un autre nom** ; mise à jour de la clé d'un même nom acceptée ;
- refus d'une clé invalide, d'une IP hors des deux plages et d'une `WG_ADRESSE_R` hors plage.
- Vérifié après coup sur l'hôte : `/etc/wireguard` vide et `/etc/nftables.conf` inchangé (date du 19/10/2023).

**Non testé :** les vrais services systemd, `wg syncconf` sur une interface active, le comportement d'une session SSH à l'activation du pare-feu.

## 10. Volume des captures

Mesuré à la première version (999 paquets à 10 ms vers un serveur irtt local) : 96 octets par paquet en `.json.gz` avec les options par défaut, 79 avec `--tstamp=midpoint --clock=wall`, 44 avec `--tstamp=none`. Pas remesuré à la révision (les options d'irtt n'ont pas changé, hors `--timeouts` qui ne touche que l'ouverture).
