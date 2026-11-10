# WAKATNET — Protocole de mesure de latence et de perte (Burkina → datacenters candidats)

> Rédigé le 10/11/2026, révisé le même jour après deux relectures adversariales (méthode et statistiques ; réseau, RouterOS et hébergement). Sert l'ADR 0004 (point 4 : « mesure avant achat ») et le réglage du `timeout` de `/radius` (`docs/SPEC.md` §6.2). Références : SPEC §0, §4, §5.6, §6.1, §6.2, §10.2, §13 ; ADR 0003, ADR 0004 ; `docs/LABO.md` (LABO-09, LABO-16, E-ROS-7, E-ROS-8).
> Outils : `infra/lab/latence/` (voir son `README.md`).
>
> **Emplacement.** L'ADR 0004 (point 4) dit que le protocole est « à rédiger dans `docs/LABO.md` ». Il est ici, dans un document à part, parce qu'il est long et qu'il s'exécute sur le terrain et non en labo. **À acter par Yacouba** : soit un renvoi dans `docs/LABO.md` (ligne proposée en tête de LABO-09 et de LABO-16 : « Mesures terrain de latence et de perte, et réglage du `timeout` : voir `docs/PROTOCOLE_LATENCE.md` »), soit un avenant à l'ADR 0004. Ce document ne modifie ni l'un ni l'autre.
>
> **Ce document est un protocole, pas un résultat.** Aucun chiffre mesuré au Burkina n'y figure. Les seuls chiffres mesurés viennent d'un réseau **simulé** dans un conteneur Linux, et ils ne servent qu'à prouver que les outils retrouvent un profil injecté (§9).
>
> Marqueurs utilisés : **(à vérifier)** = nom d'hôte, offre, tarif ou fait d'un tiers non vérifié ; **(syntaxe à confirmer sur CHR)** = commande RouterOS non exécutée ; **[LABO]** = comportement à prouver en labo.

---

## 1. Objet et décisions servies

Mesurer, **avant tout achat**, la latence et la perte réelles entre des routeurs MikroTik au Burkina et les datacenters candidats, pour trois décisions :

| # | Décision | Ce que la mesure apporte |
|---|---|---|
| D-A | **Nœud A** et **nœud B du pilote** chez Hetzner, dans deux datacenters différents parmi Falkenstein, Nuremberg et Helsinki (ADR 0004, points 1 et 2). | Délai effectif au pic du soir, perte, rafales, comparaison appariée heure par heure, et indépendance des pannes de A et B vues du Burkina. |
| D-B | **Nœud B définitif** chez un autre hébergeur, en Europe ou en Afrique de l'Ouest, avant G-PILOTE (ADR 0004, point 3). | Comparaison avec A selon les mêmes indicateurs. Un datacenter d'Afrique de l'Ouest est-il « nettement meilleur » (ADR 0004, Conséquences) ? |
| D-T | **`timeout` de `/radius`** sur les routeurs (§6.2 : « se règle en labo avec de la latence et de la perte injectées »). | Queue de distribution du RTT **dans le tunnel**, soirée par soirée, rafales de pertes, émulation des fausses bascules, et comportement d'une liaison au repos (flux clairsemé). |
| L16 | **Données pour LABO-16** (bascule A → B sur Reject ou sur timeout). | Profils réalistes à rejouer sur CHR (`tc netem`), ajustés sur les pertes observées hors coupures longues (§6, tableau 5 de l'analyse). |

Ce que la mesure **ne décide pas** :
- le nombre d'essais de RouterOS avant bascule, ni son comportement après une bascule. C'est du **[LABO]** (§8.2) ;
- la disponibilité propre d'un hébergeur : 72 h ne montrent pas un incident Hetzner.

---

## 2. Ce qu'on mesure et pourquoi

### 2.1 En UDP d'abord, dans le tunnel, en continu et au repos

Le trafic critique est **RADIUS en UDP (1812/1813), dans un tunnel WireGuard (UDP)** (§6.1). On mesure donc :

1. **UDP hors tunnel** (irtt vers l'IP publique de la VM). C'est le transport réel de WireGuard. L'ICMP seul ne suffit pas : les opérateurs, les CGNAT 4G et Starlink peuvent le limiter, le déprioriser ou le router autrement que l'UDP.
2. **UDP dans le tunnel WireGuard** (irtt vers l'adresse de la VM dans le tunnel). C'est le chemin réel de RADIUS. Il montre le surcoût du chiffrement et les reprises de poignée de main après une coupure. Il ne montre **pas** l'effet du `persistent-keepalive` sur le NAT : à 5 paquets par seconde, la traduction NAT ne vieillit jamais.
3. **Un flux clairsemé** (`rare.sh`, une phase à part, §5.6 bis), au moins sur 4G et Starlink : un ping dans le tunnel toutes les 20 à 60 s, à intervalle aléatoire, dans les deux sens. RADIUS est un trafic clairsemé ; le flux continu masque deux effets :
   - en 4G, le **délai de réveil radio** sur le premier paquet après un silence (ordre de grandeur rapporté : 0,1 à 2 s, à vérifier) ;
   - l'**expiration d'une traduction CGNAT** entre deux keepalive : si elle est plus courte que 25 s, le CoA du nœud vers le routeur (§6.1) échoue.
4. **ICMP depuis le routeur** (sonde secondaire), pour recouper. Écart attendu : faible sur fibre, possible sur 4G et Starlink. Tout écart notable est à signaler.
5. **Charge du lien WAN**, relevée chaque minute par le routeur : sans elle, on ne distingue pas la congestion de l'opérateur de celle que créent les clients de la WiFi Zone le soir.

### 2.2 Indicateurs, par couple (accès × cible)

| Indicateur | Pourquoi |
|---|---|
| RTT **p50, p95, p99, p99.9, max**, sur les RTT reçus | p50 et p95 : confort. p99.9 : la queue que le `timeout` doit absorber. Un centile q n'a de sens qu'avec au moins 10 valeurs dans sa queue, soit 10/(1−q) valeurs : 1 000 pour le p99, **10 000 pour le p99.9**. En dessous, l'analyse marque ⚠. Même au-dessus, les valeurs de la queue sont **corrélées** (un épisode de file d'attente de 30 s fait 150 échantillons de suite) : d'où le calcul soirée par soirée et l'intervalle de confiance par blocs horaires (§6.2). |
| **Délai effectif** p95e, p99e, p99.9e | Même centile, mais une perte compte comme un délai infini (« perdu » si le centile tombe dans les pertes). Sans lui, un datacenter dont les paquets retardés sont jetés paraît **meilleur** qu'un datacenter qui les livre tard. Les règles de décision (§7) portent sur le délai effectif. |
| **Perte** (%, et montante / descendante quand irtt la distingue), **brute et hors panne locale** | Une requête perdue n'est jamais rattrapée par un `timeout` plus long : seul un renvoi la rattrape. |
| **Rafales de pertes consécutives** : plus longue rafale ; nombre de rafales ≥ 1 s, ≥ 3 s, ≥ 10 s | **Le point crucial.** RouterOS bascule vers B sur timeout (hypothèse LABO-16). Ce qui fait basculer, ce n'est pas le taux moyen de perte : c'est une rafale plus longue que `timeout` × nombre d'essais. La durée d'une rafale est donnée deux fois : **pertes mesurées** (paquets × intervalle) et **silence complet** (qui ajoute les silences de la sonde, pendant lesquels on ne sait rien du réseau). |
| **Fausses bascules** émulées, pour une grille de `timeout` T et de nombres d'essais K | Traduit directement les pertes et la queue en « fausses bascules attendues par jour » (§6.3). |
| **Gigue** (moyenne de \|ΔRTT\| entre paquets reçus consécutifs, c'est-à-dire l'IPDV moyen ; ce n'est pas l'estimateur filtré de la RFC 3550) | Une gigue forte (4G, Starlink) élargit la queue du RTT. |
| **Par heure (UTC = heure locale)**, **heures creuses (2 h–6 h) / pic du soir (19 h–23 h)**, et **soirée par soirée** | Les WiFi Zones vendent surtout le soir, et c'est aussi l'heure de congestion des réseaux. Le pic est le cas qui dimensionne. Chaque soirée est donnée à part : 2 ou 3 soirées ne font pas une moyenne. |
| **Comparaison appariée** heure par heure du pic | Deux datacenters mesurés **au même moment depuis la même sonde** : on compte les heures où l'un fait mieux que l'autre. Beaucoup plus solide qu'une comparaison de deux p95 globaux qui diffèrent de quelques ms. |
| **Pannes simultanées** entre cibles vues du même site, **hors panne locale**, comptées en **épisodes** | Une panne locale (accès Internet, courant) fait tomber A et B ensemble sans rien dire des hébergeurs. Pour la reconnaître, chaque sonde vise au moins un **témoin hors Hetzner** (§3.1) : une seconde est « locale » quand le témoin **et** toutes les cibles sont muets. Sans témoin, une panne commune à tout Hetzner serait classée locale et effacée, alors que c'est exactement celle qui compte pour choisir B. |
| **Couverture** et **coupures de courant** | Une capture trouée ne vaut pas une capture continue. Chaque coupure de courant (délestage) est notée sur la fiche du site (§5.9) et datée par le routeur (repère de démarrage) et par la sonde (journal). |
| **Débit WAN** par heure | À croiser avec le p95 par heure (tableau 7 de l'analyse). |

### 2.3 Paramètres de mesure

- irtt : 1 paquet toutes les **200 ms** (`-i 200ms`), longueur minimale (60 octets avec les en-têtes irtt). Une requête Access-Request réelle fait plutôt 150 à 400 octets. Sur un lien 4G chargé, la sérialisation de ce surplus reste négligeable devant la gigue. Une variante `-l 300` est possible si on veut le vérifier.
- Tranches de **15 min** (`-t 900`) : une coupure de courant de la sonde ne perd que la tranche en cours. Plafond : 20 min (`sonde.sh` refuse au-delà), à cause du `--timeout=20m` du serveur irtt (§3.2).
- Ouverture de session irtt : 4 essais de 2 s (`-O 2s,2s,2s,2s`). Une cible injoignable au début d'une tranche est donc constatée en 8 s ; avec la pause de 1 s, la **résolution** d'une indisponibilité à l'ouverture est d'environ 9 s.
- Phase dense : **48 h minimum, 72 h conseillées**, avec au moins deux pics du soir dont un vendredi ou un samedi.
- Phase clairsemée (§5.6 bis) : **12 h minimum** (une nuit), 24 h conseillées, sur 4G et Starlink ; facultative sur fibre.

**Volume de données (estimation par calcul, pas une mesure).** Par cible, hors tunnel : 88 octets IP par paquet, 5 paquets/s dans chaque sens, soit environ 76 Mo par jour. Dans le tunnel : environ 156 octets par paquet (en-têtes WireGuard et bourrage), soit environ 135 Mo par jour. Le flux clairsemé est négligeable (un ping par 40 s en moyenne).

| Configuration par site | 48 h | 72 h |
|---|---|---|
| 3 datacenters Hetzner + 1 témoin, hors tunnel + tunnel, 200 ms | ≈ 1,7 Go | ≈ 2,5 Go |
| + 1 candidat B distinct du témoin, hors tunnel + tunnel, 200 ms | ≈ 2,1 Go | ≈ 3,2 Go |
| 4 cibles × 2, **500 ms** (variante 4G économe) | ≈ 0,7 Go | ≈ 1,0 Go |

**Volume des captures (mesuré en local) :** environ 96 octets par paquet en `.json.gz` avec les options par défaut d'irtt, 44 avec `-X "--tstamp=none"`. Pour 72 h, 8 cibles et 200 ms, cela fait environ 1 Go par sonde, ou 450 Mo sans horodatage serveur. Prévoir la carte SD ou le disque en conséquence.

Sur 4G, vérifier le forfait avant de lancer. Passer à 500 ms dégrade la finesse des rafales (pas de 0,5 s), mais reste suffisant pour une grille de `timeout` ≥ 1 s. L'intervalle est inscrit dans chaque capture, et l'analyse en tient compte. **Ne pas changer d'intervalle en cours de mesure** : l'analyse traite alors chaque intervalle comme une série à part (`cible@500ms`).

---

## 3. Cibles

### 3.1 VM temporaires, une par datacenter candidat, plus un témoin

| Code (groupe) | Datacenter | Hébergeur | Adresse tunnel L | Adresse tunnel R |
|---|---|---|---|---|
| `fsn` | Falkenstein (`fsn1`, à vérifier) | Hetzner Cloud | 10.254.213.1 | 10.254.214.1 |
| `nbg` | Nuremberg (`nbg1`, à vérifier) | Hetzner Cloud | 10.254.213.2 | 10.254.214.2 |
| `hel` | Helsinki (`hel1`, à vérifier) | Hetzner Cloud | 10.254.213.3 | 10.254.214.3 |
| `b1`, `b2`… | candidat(s) B définitif | autre hébergeur, Europe ou Afrique de l'Ouest (à choisir, **à vérifier**) | 10.254.213.4, .5… | 10.254.214.4… |
| `ref` | **témoin** (s'il n'y a pas encore de candidat B) | autre hébergeur que Hetzner, autre réseau (à choisir, **à vérifier**) | 10.254.213.9 | — |

- **Témoin obligatoire.** Chaque sonde vise au moins une cible **hors Hetzner**, en UDP, pendant toute la mesure : le candidat B définitif s'il existe déjà, sinon une petite VM `ref` chez un autre hébergeur. Sans témoin, l'analyse refuse de classer les pannes (« indéterminé »), et les règles 7.2 et 7.3 ne peuvent pas être remplies. Limite : une panne de tout le transit Burkina → Europe touche aussi un témoin européen et sera classée locale. Un témoin proche (Afrique de l'Ouest) la distinguerait mieux.
- **Groupes.** Le nom d'une cible est `<groupe>-<transport>` (`fsn-wg`, `ref-udp`). L'analyse range dans « Hetzner » les groupes `fsn`, `nbg`, `hel` (option `--groupes-hetzner`) ; tous les autres sont des témoins.
- **Type de VM :** la plus petite VM Debian à facturation horaire (2 vCPU partagés suffisent : irtt et WireGuard ne consomment presque rien). Nom exact de l'offre et prix : **à vérifier** le jour de l'achat.
- **Coût, estimation à vérifier :** de l'ordre de 0,01 € par heure et par VM chez Hetzner, IPv4 comprise ou facturée à part. Pour 3 VM pendant 4 à 5 jours (préparation et phase clairsemée comprises), cela fait **quelques euros au total**. Une VM chez un autre hébergeur coûte du même ordre, ou un peu plus en Afrique de l'Ouest. Hypothèse, non vérifiée : la facturation horaire s'arrête à la **suppression** de la VM, pas à son arrêt. Il faut aussi vérifier qu'une Primary IP détachée n'est plus facturée (§5.8).
- **Candidats B définitif, à vérifier :** en Europe, un hébergeur indépendant de Hetzner, sur un autre réseau et avec une autre facturation (ADR 0004, point 3). Marseille est une hypothèse à tester, parce que plusieurs câbles sous-marins africains y atterrissent (à vérifier). En Afrique de l'Ouest, un hébergeur présent à Abidjan, Dakar, Accra ou Lagos, avec IPv4 fixe et facturation à l'heure ou au mois (noms et offres : **à vérifier**). Un candidat sans VM à l'heure peut se mesurer sur un mois de location minimal.
- **Plages de labo `10.254.213.0/24` (variante L) et `10.254.214.0/24` (variante R)**, volontairement **hors** de l'overlay de production `10.213.0.0/16` (§6.1). Aucune route de labo oubliée ne doit entrer en conflit avec un futur enrôlement.

### 3.2 Logiciel côté cible

- **irtt serveur** (UDP 2112), lancé par `serveur-vm.sh` avec `-i 10ms -d 2h --timeout=20m`. Le `--timeout` de 20 min est délibéré. Avec la valeur par défaut d'irtt (1 min), une coupure de plus d'une minute fermerait la session côté serveur, et toute la fin de la tranche paraîtrait perdue. irtt renvoie des paquets de la taille de la requête : il n'amplifie rien. On n'utilise pas de HMAC : ce serait un secret à distribuer, pour des VM qui ne vivent que quelques jours.
- **WireGuard** (`wg-labo`, UDP 51820). La clé privée est générée **sur la VM** et n'en sort pas. La configuration ne la contient pas : elle est chargée au démarrage par `PostUp` depuis un fichier en mode 600.
- **nftables minimal :** en entrée, politique `drop` ; SSH, WireGuard, irtt et ICMP acceptés sur toutes les interfaces ; aucun transfert.
- **Pare-feu de l'hébergeur :** si un pare-feu de l'hébergeur est attaché à la VM (Hetzner Cloud Firewall, **à vérifier**), il s'ajoute à nftables : y ouvrir aussi **UDP 51820 et UDP 2112**, sinon rien ne passe.
- **chrony** pour l'horloge. Le RTT n'en dépend pas, mais le classement par heure et le recoupement avec les journaux en dépendent.
- **`ping`** (`iputils-ping`) pour le flux clairsemé dans le sens VM → routeur.

### 3.3 Hôtes de test publics : premier tri ICMP seulement

Hetzner publierait des hôtes de test par datacenter, du type `fsn1-speed.hetzner.com`, `nbg1-speed.hetzner.com`, `hel1-speed.hetzner.com` (**à vérifier**). Ils permettent un **premier tri en ICMP**, sans rien acheter, depuis le poste Windows :

```bat
ping -n 600 fsn1-speed.hetzner.com > 2026-MM-JJ-SITE-ACCES-fsn-icmp-windows.txt
tracert -d fsn1-speed.hetzner.com >> 2026-MM-JJ-SITE-ACCES-fsn-icmp-windows.txt
```

Limites : ICMP seulement, pas de tunnel, pas forcément la même machine ni le même réseau que les VM. Ce tri **ne remplace pas** la mesure UDP de 48 h : il sert seulement à écarter un candidat aberrant.

---

## 4. Sources (sondes)

### 4.1 Un routeur réel par type d'accès

| Accès | Ce qu'il faut noter sur la fiche du site (§5.9) |
|---|---|
| **Fibre ou ADSL** | Opérateur, type de lien, débit souscrit, IP publique fixe ou dynamique, routeur de l'opérateur en amont (double NAT ?), PPPoE ou non (MTU). |
| **4G** | Opérateur, modèle du modem ou du routeur LTE, signal : RSRP, RSRQ et SINR si disponibles (`/interface lte info` sur un MikroTik LTE, syntaxe à confirmer sur CHR). Présence d'un CGNAT : l'adresse WAN est-elle privée ou en 100.64.0.0/10 ? |
| **Starlink** | Deux montages possibles : **par défaut**, le MikroTik est derrière le routeur Starlink, avec une adresse WAN privée (192.168.x) : double NAT, plus le CGNAT de Starlink ; **en bypass**, le MikroTik reçoit directement l'adresse WAN, en général en **100.64.0.0/10** (CGNAT), donc pas une adresse publique, sauf offre particulière (à vérifier). Noter aussi : le **type d'abonnement** (résidentiel, itinérance, professionnel) et le **pays d'enregistrement du kit**, qui déterminent la passerelle (PoP) et l'adresse (à vérifier) ; la présence d'IPv6 ; les obstructions signalées par l'appli ; la **position de la passerelle** si elle est observable (`traceroute` / `mtr` depuis la sonde ; le nom inverse des premiers sauts indique parfois la ville du PoP, à vérifier). **Statut réglementaire de Starlink au Burkina : à vérifier** avant de s'appuyer sur ce type d'accès. Un profil Starlink mesuré sur **un** abonnement ne se généralise pas aux autres. |

Le même routeur peut servir à la mesure et à l'exploitation. Les objets ajoutés portent `comment="wakatnet-labo…"` et se retirent en une passe. Noter sur la fiche si le routeur **porte de vrais clients** pendant la mesure : leur trafic charge le lien le soir et garde la radio 4G éveillée.

### 4.2 Sonde principale : un petit Linux derrière le routeur

- Raspberry Pi, mini-PC ou portable sous Linux (Debian, Raspberry Pi OS ou Ubuntu), **en Ethernet** sur le LAN du routeur, jamais en Wi-Fi : le Wi-Fi ajouterait sa propre gigue.
- **Routeur avec hotspot (WiFi Zone)** : derrière `/ip hotspot`, la sonde serait redirigée vers le portail ou bloquée jusqu'à une connexion, et la mesure ne démarrerait pas (ou s'arrêterait à l'expiration de la session). Deux solutions : un port Ethernet **hors du bridge du hotspot**, ou une exception `ip-binding` de type `bypassed` pour la MAC de la sonde (section H de `routeros-sonde.rsc`, syntaxe à confirmer sur CHR, retirée en fin de mesure). Dans les deux cas, le noter sur la fiche.
- Paquets : `irtt`, `wireguard-tools`, `chrony`, `iputils-ping`. Présents dans Ubuntu 24.04 (vérifié) ; dans Debian et Raspberry Pi OS, à vérifier. Repli : `go install github.com/heistp/irtt/cmd/irtt@latest`.
- Client irtt lancé par `sonde.sh`, en service systemd pour repartir seul après une coupure de courant.
- **Horloge.** Un Raspberry Pi n'a pas d'horloge matérielle : après une coupure de courant, il repart à l'heure de son dernier arrêt (fake-hwclock) jusqu'à ce que NTP la corrige. Le service attend donc la synchronisation (`chrony-wait.service`, à vérifier selon la distribution), et `sonde.sh` attend encore `NTPSynchronized=yes` (au plus 15 min, puis il démarre quand même et le journalise). À l'intérieur d'une tranche, l'analyse suit l'horloge **monotone** d'irtt et signale les sauts d'horloge murale.
- Le plus robuste : alimenter **la sonde et le routeur** sur le même onduleur ou la même batterie. Sinon, noter lequel des deux est secouru.
- WSL2 sur le poste Windows n'est qu'un **dernier recours** : NAT supplémentaire, mise en veille du poste, horloge qui dérive après la veille.

**Deux variantes pour la mesure dans le tunnel :**

| Variante | Tunnel terminé sur | Plage | Avantage | Inconvénient |
|---|---|---|---|---|
| **L** (par défaut) | la sonde Linux (`wg-quick`) | 10.254.213.0/24 | Rien à changer sur le routeur. Testée en local (§9). | Ne mesure pas le coût CPU de WireGuard sur le routeur (hAP lite MIPS, ADR 0003). |
| **R** (facultative) | le routeur (section C de `routeros-sonde.rsc`) | 10.254.214.0/24 | C'est le chemin de production (§6.1). | Modifie le routeur (interface, pairs, adresse, masquerade). **Non exécutée.** (syntaxe à confirmer sur CHR) |

Les deux plages sont distinctes : L et R tournent **en même temps** sur le même site, vers les mêmes VM (qui portent une adresse dans chaque plage). Conseil : variante L partout, plus la variante R sur **un** routeur bas de gamme. L'écart L / R, mesuré au même moment, montre si le CPU du routeur ajoute de la queue de RTT : c'est une donnée utile pour l'ADR 0003.

### 4.3 Sonde secondaire : RouterOS lui-même

`routeros-sonde.rsc` (**non exécuté**, syntaxe à confirmer sur CHR) installe :
- **(A)** un `/tool netwatch` de type `icmp` par cible (20 pings à 200 ms **chaque minute**), relevé chaque minute par un script qui écrit une ligne `wakatnet-labo netwatch …` : perte et RTT ICMP ;
- **(B)** un `/ping` planifié chaque minute (20 pings par cible) : **perte seulement** (le script ne lit que le nombre de réponses) ;
- **(W)** les compteurs d'octets de l'interface WAN chaque minute (`wakatnet-labo wan rx=… tx=…`) ;
- **(D)** un repère `wakatnet-labo demarrage routeur` à chaque démarrage, écrit une fois NTP synchronisé (au plus 5 min d'attente), pour dater les coupures de courant ;
- un **journal envoyé en syslog UDP** vers la sonde Linux (`recepteur-syslog.py`, port 5514), qui l'horodate avec son horloge NTP. Un journal disque de secours (2 fichiers × 5 000 lignes, environ 1,5 Mo) n'est créé que s'il reste au moins 4 Mo libres : sur un hAP lite (16 Mo de flash), une flash pleine peut empêcher la sauvegarde de la configuration.

Il ne touche pas au client NTP du routeur : vérifier à la main que l'heure du routeur est juste. La référence de temps reste la sonde Linux.

---

## 5. Procédure pas à pas

### 5.1 Calendrier conseillé

| J | Action |
|---|---|
| J-7 | Fiches de site (§5.9). Premier tri ICMP Windows (§3.3) depuis chaque accès. Vérification des forfaits 4G. Choix du témoin (§3.1). |
| J-1 | Sondes Linux préparées et testées sur le LAN : service, NTP, `irtt client` vers une VM de test, réception syslog. Script RouterOS **validé sur CHR d'abord** (§13, règle 6). |
| J0, 10 h | Création des VM (§5.2), déclaration des sondes, vérification (§5.5), relevé de MTU. |
| J0, 12 h | Démarrage des sondes, le jeudi de préférence. |
| J0 + 72 h | Fin de la phase dense. Début de la phase clairsemée (§5.6 bis) sur 4G et Starlink. |
| J0 + 84 à 96 h | Fin de la phase clairsemée, collecte (§5.7), puis destruction des VM le jour même (§5.8). |

### 5.2 Préparer chaque VM cible

1. Créer la VM Debian stable dans le datacenter voulu, avec **authentification SSH par clé**. La clé publique SSH de Yacouba est déposée à la création. Aucun mot de passe n'est noté nulle part. Si l'hébergeur attache un pare-feu à la VM (Hetzner Cloud Firewall, à vérifier), y ouvrir TCP 22, **UDP 51820 et UDP 2112**.
2. Copier les scripts et lancer l'installation. L'adresse dans le tunnel dépend du datacenter (§3.1) ; `WG_ADRESSE_R` seulement si la variante R est prévue :
   ```bash
   scp infra/lab/latence/serveur-vm.sh infra/lab/latence/rare.sh root@IP_PUBLIQUE_VM:/root/
   ssh root@IP_PUBLIQUE_VM 'WG_ADRESSE=10.254.213.1/24 WG_ADRESSE_R=10.254.214.1/24 /root/serveur-vm.sh installer'
   ```
   Sortie attendue : la **clé publique** WireGuard de la VM, l'adresse dans le tunnel et les ports. La clé privée reste dans `/etc/wireguard/wg-labo.cle-privee`, en mode 600.
3. Vérifier : `ssh root@IP_PUBLIQUE_VM /root/serveur-vm.sh etat`. Il faut irtt actif, `wg-labo` présent et la table `inet wakatnet_labo` chargée.
   - Si la session SSH tombe à l'activation du pare-feu, passer par la console de l'hébergeur.
   - Le script accepte SSH **avant** toute règle `drop`, mais `serveur-vm.sh` n'a **pas** été exécuté de bout en bout sur une vraie VM (§9).

### 5.3 Préparer chaque sonde Linux (variante L)

1. Paquets et clé, générée **sur la sonde** :
   ```bash
   apt-get install -y irtt wireguard-tools chrony iputils-ping
   install -d -m 700 /etc/wireguard
   ( umask 077; wg genkey > /etc/wireguard/wg-labo.cle-privee )
   wg pubkey < /etc/wireguard/wg-labo.cle-privee      # seule la clé PUBLIQUE est recopiée
   systemctl enable chrony-wait.service                # attente NTP au démarrage (nom à vérifier selon la distribution)
   ```
2. Configuration `/etc/wireguard/wg-labo.conf`, **sans clé privée** dans le fichier. Une adresse par sonde : `.11`, `.12`, `.13`… Un bloc `[Peer]` par VM, témoin compris. Les marqueurs sont à remplacer par les clés publiques et les IP des VM :
   ```ini
   # wakatnet-labo : tunnel de mesure (la clé privée est chargée par PostUp)
   [Interface]
   Address = 10.254.213.11/24
   PostUp = wg set %i private-key /etc/wireguard/wg-labo.cle-privee

   [Peer]
   # fsn
   PublicKey = CLE_PUBLIQUE_VM_FSN
   Endpoint = IP_PUBLIQUE_VM_FSN:51820
   AllowedIPs = 10.254.213.1/32
   PersistentKeepalive = 25

   [Peer]
   # nbg
   PublicKey = CLE_PUBLIQUE_VM_NBG
   Endpoint = IP_PUBLIQUE_VM_NBG:51820
   AllowedIPs = 10.254.213.2/32
   PersistentKeepalive = 25

   [Peer]
   # hel
   PublicKey = CLE_PUBLIQUE_VM_HEL
   Endpoint = IP_PUBLIQUE_VM_HEL:51820
   AllowedIPs = 10.254.213.3/32
   PersistentKeepalive = 25

   [Peer]
   # ref (témoin hors Hetzner) ou b1
   PublicKey = CLE_PUBLIQUE_VM_REF
   Endpoint = IP_PUBLIQUE_VM_REF:51820
   AllowedIPs = 10.254.213.9/32
   PersistentKeepalive = 25
   ```
   `PersistentKeepalive = 25` est la valeur de production (§6.1).
3. Sur **chaque VM**, déclarer la sonde avec sa clé publique : `/root/serveur-vm.sh ajouter-pair ouaga1-fibre CLE_PUBLIQUE_SONDE 10.254.213.11`. Le script refuse une IP déjà attribuée à un autre nom.
4. Sur la sonde : `systemctl enable --now wg-quick@wg-labo`, puis `wg show` : chaque pair doit avoir un `latest handshake` récent.
5. Fichier `cibles.conf`, une ligne par cible : `fsn-udp IP_PUBLIQUE_VM_FSN:2112`, `fsn-wg 10.254.213.1:2112`, …, **`ref-udp IP_PUBLIQUE_VM_REF:2112`** et `ref-wg 10.254.213.9:2112`. Voir `infra/lab/latence/README.md`.
6. Services systemd `wakatnet-sonde` et `wakatnet-syslog` (modèles dans le README), avec les bons `-s SITE -a ACCES` et une **date de fin absolue** `-F AAAA-MM-JJTHH:MM:SSZ`. Avec `-F`, un redémarrage après une coupure de courant ne repousse pas la fin, alors qu'il la repousserait avec `-H`. Une fois la date passée, la sonde sort avec le code 4 et systemd ne la relance pas. Ne pas encore activer `wakatnet-sonde`.
7. Si le routeur a un hotspot : port hors bridge, ou section H de `routeros-sonde.rsc` (§4.2).

Conventions de nom : `SITE` et `ACCES` en `[a-z0-9]` (`ouaga1`, `fibre`, `adsl`, `4g`, `starlink`) ; cible en `[a-z0-9-]` (`fsn-udp`, `fsn-wg`, `ref-udp`).

### 5.4 Sonde RouterOS (secondaire)

1. **D'abord sur CHR** (vierge, puis déjà configuré), et seulement ensuite sur le routeur réel. Remplacer les marqueurs (`IP_PUBLIQUE_VM_*` à deux endroits, `IP_LAN_SONDE`, `NOM_INTERFACE_WAN` à deux endroits, `MAC_SONDE` si hotspot) et retirer les cibles inutilisées.
2. `/import file-name=routeros-sonde.rsc`, puis vérifier : `/tool netwatch print where comment~"wakatnet-labo"` et, sur la sonde, l'arrivée des lignes dans `/var/lib/wakatnet-latence/*.routeros.log` après 2 minutes.
3. Variante R seulement : mettre `avecTunnel` à `true` et `adresseTunnelR` à l'adresse de ce routeur (`.21`, `.22`, `.23`), recopier la clé publique affichée sur chaque VM (`ajouter-pair NOM-r CLE 10.254.214.21`), et sur la sonde Linux ajouter une route `10.254.214.0/24 via IP_LAN_DU_ROUTEUR` **en plus de** `wg-quick`. Cibles supplémentaires : `fsn-wgr 10.254.214.1:2112`, etc.

### 5.5 Démarrer et vérifier

```bash
systemctl enable --now wakatnet-syslog wakatnet-sonde
sleep 120
tail /var/lib/wakatnet-latence/*.sonde.log          # « cible_lancee » pour chaque cible, aucun « echec_ouverture »
ls /var/lib/wakatnet-latence/en-cours/              # une tranche en cours par cible
timedatectl show -p NTPSynchronized --value         # yes
tail -3 /var/lib/wakatnet-latence/*.routeros.log    # lignes « wakatnet-labo netwatch », « wan »
```

**Relevé de MTU, une fois par accès** (hors tunnel vers l'IP publique d'une VM, puis dans le tunnel) : 1452 + 28 octets d'en-têtes = 1480 = 1420 (MTU WireGuard de la SPEC §6.1) + 60 octets d'encapsulation. Si 1452 ne passe pas sans fragmentation, diminuer par pas de 10 jusqu'à ce que ça passe, et noter la valeur sur la fiche. C'est sans effet sur RADIUS (paquets inférieurs à 500 octets), mais une MTU de chemin inférieure à 1480 (ADSL en PPPoE à 1492, certains réseaux 4G, transport extérieur en IPv6) remet en cause la MTU 1420 de la SPEC.

```bash
ping -M do -c 3 -s 1452 IP_PUBLIQUE_VM_FSN       # Linux ; sous Windows : ping -f -l 1452 IP_PUBLIQUE_VM_FSN
ping -M do -c 3 -s 1392 10.254.213.1             # dans le tunnel : 1392 + 28 = 1420
```

Contrôle à 20 min : première tranche close (`tranche_ok`), puis analyse rapide sur place pour voir des RTT plausibles :

```bash
python3 analyse.py /var/lib/wakatnet-latence --sortie /tmp/controle --sans-heures --bootstrap 0 && head -20 /tmp/controle.md
```

### 5.6 Pendant la mesure

- Ne rien changer : ni le routeur, ni l'accès, ni la position de l'antenne Starlink.
- Noter sur la fiche du site, à la minute près : **coupures de courant** (début, fin, qui est secouru), incidents opérateur, travaux, orage, usage inhabituel du lien.
- La charge du lien est une donnée, pas un défaut : c'est la réalité d'une WiFi Zone le soir. La noter, sans la supprimer. Le routeur la relève chaque minute (§4.3, W).

### 5.6 bis Phase clairsemée (4G et Starlink ; facultative sur fibre)

But : mesurer une liaison **au repos**, comme celle d'un routeur entre deux authentifications. Pendant cette phase, **aucun flux dense ne doit tourner sur le même accès** : sinon la radio ne retombe jamais au repos et la traduction NAT ne vieillit jamais.

1. Arrêter le flux dense : `systemctl stop wakatnet-sonde`.
2. Sur le routeur, couper les sondes ICMP (bloc « PHASE CLAIRSEMÉE » de `routeros-sonde.rsc`, syntaxe à confirmer sur CHR). Les compteurs WAN peuvent continuer : ils ne sortent pas sur le WAN.
3. Ne garder que **deux** pairs WireGuard actifs sur la sonde, les deux meilleurs candidats, comme en production (A et B) : chaque pair envoie son propre keepalive, et cinq pairs réveilleraient la radio plus souvent qu'en production. Retrait temporaire, sans toucher au fichier de configuration : `wg set wg-labo peer CLE_PUBLIQUE_VM_HEL remove` (une ligne par pair retiré ; `systemctl restart wg-quick@wg-labo` les remet).
4. Lancer dans les deux sens, pour la même durée (12 à 24 h) :
   ```bash
   # sur la sonde : sonde -> VM (chemin de l'Access-Request)
   ./rare.sh -s ouaga1 -a 4g -n fsn-wg-rare -c 10.254.213.1 -o /var/lib/wakatnet-latence -F 2026-11-16T12:00:00Z
   # sur la VM : VM -> sonde (chemin du CoA)
   /root/rare.sh -s ouaga1 -a 4g -n retour-fsn -c 10.254.213.11 -o /root/rare -F 2026-11-16T12:00:00Z
   ```
5. Noter sur la fiche si le routeur porte de vrais clients pendant la phase : leur trafic garde la radio éveillée.

Lecture (tableau 8 de l'analyse) : un surcoût net du p50 clairsemé par rapport au p50 dense signale le délai de réveil radio ; des pertes nettement plus fréquentes dans le sens VM → sonde que dans l'autre signalent une traduction NAT qui expire entre deux keepalive. Un tel résultat remet en cause `persistent-keepalive=25s` (§6.1) : à signaler à Yacouba.

### 5.7 Arrêt et collecte

```bash
systemctl stop wakatnet-sonde              # irtt écrit la tranche en cours (vérifié en local, §9)
systemctl disable wakatnet-sonde wakatnet-syslog
systemctl stop wakatnet-syslog
tail -2 /var/lib/wakatnet-latence/*.sonde.log    # « tranche_ok … interrompue=oui » pour chaque cible, puis « arret »
```

L'arrêt a été vérifié en local par un SIGTERM envoyé au seul processus principal **et** par un SIGTERM envoyé à tout le groupe de processus en même temps (ce que fait systemd par défaut), pas par un vrai `systemctl stop` : la dernière ligne ci-dessus le vérifie sur la vraie sonde.

Copie vers le poste Windows (OpenSSH intégré à Windows), puis dans le dépôt, sous `docs/labo/latence/` :

| Fichier | Contenu |
|---|---|
| `AAAA-MM-JJ-<site>-<acces>-<cible>.THHMMSSZ.json.gz` | tranche irtt (nom produit par `sonde.sh` ; date et heure UTC de début de tranche) |
| `AAAA-MM-JJ-<site>-<acces>.sonde.log` | journal de la sonde |
| `AAAA-MM-JJ-<site>-<acces>.routeros.log` | journal du routeur, reçu par syslog sur la sonde |
| `AAAA-MM-JJ-<site>-<acces>-<nom>.rare.log` | flux clairsemé (sonde et VM) |
| `AAAA-MM-JJ-<site>-<acces>-fiche.md` | fiche du site (§5.9) |
| `AAAA-MM-JJ-<site>-<acces>-<cible>-traceroute.txt` | `mtr -rwc 100 IP` ou `traceroute`, au début, au pic et à la fin |
| `AAAA-MM-JJ-resultat.md`, `.csv`, `-heures.csv`, `-correlation.csv`, `-soirees.csv`, `-appariement.csv`, `-rare.csv` | sorties d'`analyse.py` |

AAAA-MM-JJ = date de début de la mesure, ou de la tranche pour les fichiers irtt.

**Taille :** les captures brutes peuvent peser des centaines de Mo (§2.3). Avant de les versionner, mesurer leur taille. Si elles sont trop lourdes, les archiver hors du dépôt et versionner les résultats, les journaux et un `SHA256SUMS` des captures. C'est à décider par Yacouba. Les `.log` sont acceptés par `.gitignore` sous `docs/labo/**`.

Les captures irtt contiennent le nom d'hôte de la sonde, son adresse locale et l'IP publique de la VM. Ce ne sont pas des secrets, mais c'est à savoir avant de les publier. Le journal de la sonde et celui du routeur ne contiennent aucune clé.

### 5.8 Arrêt et destruction des VM

1. Sur chaque sonde : `systemctl disable --now wg-quick@wg-labo`, puis `shred -u /etc/wireguard/wg-labo.cle-privee`.
2. Sur chaque routeur : coller la section « RETRAIT » de `routeros-sonde.rsc` (elle retire aussi l'exception hotspot), après avoir copié les journaux.
3. Chez l'hébergeur : **supprimer** chaque VM, puis vérifier qu'aucune IP réservée (Primary IP chez Hetzner) ni aucun volume ne reste facturé (à vérifier sur la facture du mois).
4. Noter dans `docs/JOURNAL.md` les dates de création et de suppression des VM, et leur coût réel.

### 5.9 Fiche de site (modèle)

```markdown
# AAAA-MM-JJ — <site> — <acces>
- Lieu (quartier, ville) :
- Routeur : modèle, RouterOS (version), carte (/system routerboard print)
- Accès : opérateur, offre, débit souscrit, adresse WAN (privée / CGNAT 100.64/10 / publique), PPPoE oui/non
- Starlink : montage (derrière le routeur Starlink / bypass), type d'abonnement, pays d'enregistrement du kit,
  IPv6 oui/non, obstructions (appli), PoP présumé (traceroute) ; statut réglementaire au Burkina : à vérifier
- 4G : opérateur, bande, RSRP / RSRQ / SINR au début et au pic
- MTU du chemin : hors tunnel ____ ; dans le tunnel ____ (§5.5)
- Hotspot sur le routeur : oui/non ; sonde hors bridge / ip-binding bypassed
- Vrais clients sur le routeur pendant la mesure : oui/non (nombre approximatif le soir)
- Sonde : machine, OS, irtt (version), câble Ethernet oui/non, onduleur oui/non
- Routeur sur onduleur : oui/non
- Cibles : fsn / nbg / hel / ref ou b… (IP publiques NON notées ici si la fiche est publiée)
- Phase dense : début (UTC) ____ fin (UTC) ____ ; phase clairsemée : début ____ fin ____
- Coupures de courant (début–fin UTC, secouru ?) :
- Incidents et remarques :
```

---

## 6. Analyse

`infra/lab/latence/analyse.py` utilise Python 3 et la bibliothèque standard seulement, et tourne aussi sous Windows. Il lit les tranches irtt, les journaux de sonde, les journaux du routeur reçus par syslog et les journaux du flux clairsemé :

```bash
python3 infra/lab/latence/analyse.py docs/labo/latence/ --sortie docs/labo/latence/AAAA-MM-JJ-resultat \
    [--timeouts 0.5,1,1.1,1.5,2,2.3,3,5] [--essais 1,2,3] [--temps-serveur-ms 50] \
    [--pic 19-23] [--creuses 2-6] [--groupes-hetzner fsn,nbg,hel] [--auth-par-jour 300] \
    [--episode-min-s 2] [--episodes-min 10] [--bootstrap 200] \
    [--exclure 2026-11-12T19:05:00Z/2026-11-12T20:40:00Z]
```

Durée de calcul mesurée : environ 8 s pour 432 000 paquets (24 h d'une cible) avec la grille par défaut ; compter quelques minutes pour 72 h et 8 cibles.

### 6.1 Ce qu'il produit

| Section du `.md` | Contenu |
|---|---|
| 1. Tableau principal | Par (site, accès, cible), sur toute la mesure : durée, couverture, envoyés, perte brute et hors panne locale, p50 / p95 / p99 / p99.9 reçus, p95e / p99e / p99.9e hors panne locale, max, gigue, plus longue rafale (paquets, pertes mesurées, silence), rafales ≥ 1 s / ≥ 3 s / ≥ 10 s, paquets « indisponibles à l'ouverture », témoin et secondes de panne locale. |
| 2. Timeout émulé | Au pic, hors panne locale : pour chaque K et chaque T, % strict / % tardif et **fausses bascules attendues par jour**. Le CSV donne aussi le calcul brut et sur toute la mesure. |
| 3. Creuses / pic | Mêmes indicateurs sur 2 h–6 h et 19 h–23 h, hors panne locale, avec ⚠. |
| 3 bis. Soirées | Min et max du p95e et du p99.9 sur les soirées (Q = max), IC 90 % par bootstrap en blocs horaires. Détail : `-soirees.csv`. |
| 4. Corrélation | Par paire de cibles de même transport : secondes en panne, P(Y\|X) brut, panne locale, secondes non classables, P(Y\|X) hors locale en secondes et **en épisodes**, statut (« mesuré » / « indéterminé »). |
| 4 bis. Appariement | Heures du pic comparées, % d'heures où chaque cible fait mieux, écart médian, soirées, verdict. |
| 5. Profil équivalent | Paramètres de Gilbert (p, r) hors panne locale et hors rafales de plus de 10 s, ligne `tc netem` indicative, et liste des coupures longues, pour LABO-16. |
| 6. Qualité | Début, fin, tranches, intervalle, fins de tranche perdues ≥ 30 s, fins anticipées par cause (SIGTERM / erreur d'envoi / inexpliquée) et paquets en vol retirés, sauts d'horloge, perte montante / descendante, événements des journaux. |
| 7. Heure par heure | Perte, p50, p95, p99, p95e, rafale max, et débit WAN moyen relevé par le routeur, par heure UTC. |
| 8. Flux clairsemé | Envoyés, perte, p50, p95, max, et surcoût du p50 par rapport au flux dense de la même cible. |

### 6.2 Définitions

- **Centiles :** méthode du rang le plus proche. *Reçus* : sur les seuls RTT reçus. *Effectifs* (`e`) : une perte compte comme un délai infini ; « perdu » si le centile tombe dans les pertes (perte > 1 − q). ⚠ signale un centile q calculé sur moins de 10/(1 − q) valeurs (1 000 pour le p99, 10 000 pour le p99.9), dans tous les tableaux.
- **Soirée :** heures de pic d'une même date. **Bootstrap en blocs** : on tire au hasard, avec remise, autant de blocs « une heure de pic d'une soirée » qu'il y en a, et on recalcule p95e et p99.9 ; l'IC 90 % va du 5ᵉ au 95ᵉ centile des tirages. Avec 8 à 12 blocs (2 ou 3 soirées), l'IC est grossier : il dit surtout si l'écart entre deux datacenters est dans le bruit.
- **Rafale :** suite de paquets perdus consécutifs dans un même segment contigu (plus de 15 s sans aucun paquet coupe la série). *Durée des pertes mesurées* = paquets × intervalle (pertes virtuelles comprises). *Silence complet* = du dernier paquet reçu avant la rafale au premier reçu après, moins un intervalle : il ajoute les trous entre tranches et l'attente d'ouverture, pendant lesquels on ne sait rien du réseau. Les compteurs ≥ 1 / 3 / 10 s portent sur la durée des pertes mesurées.
- **Indisponibilité à l'ouverture :** si irtt ne peut pas ouvrir sa session, `sonde.sh` journalise `echec_ouverture debut=… fin=…`. L'analyse remplit cette fenêtre de pertes « virtuelles » pour les rafales, la panne locale et le `timeout` émulé. Le taux de perte affiché, lui, ne compte que les paquets réels. Résolution : environ 9 s (§2.3).
- **Fin anticipée :** irtt s'est arrêté plus d'une seconde avant la durée demandée. Cause notée : *SIGTERM* (journal `interrompue=oui`), *erreur d'envoi* (champ `send_err` d'irtt ; vérifié en local : quand l'interface de la sonde tombe, irtt s'arrête avec le code 0 et ce champ rempli), ou *inexpliquée*. Dans tous les cas, irtt n'a pas attendu les réponses de ses derniers paquets : les pertes de queue envoyées dans la dernière fenêtre **min(2 s ; 2 × p99 du RTT de la tranche)** sont retirées (« en vol »), et seulement elles. Une vraie coupure plus longue reste comptée.
- **Panne locale :** seconde où au moins un témoin (cible hors Hetzner) a des paquets et où **toutes** les cibles qui en ont sont muettes. Sans témoin : **indéterminée**, rien n'est retiré, et la corrélation est « indéterminée ». *Secondes non classables* : secondes de panne sans aucune donnée de témoin ; elles sont exclues du calcul de corrélation hors locale, mais gardées (comme pertes) dans les autres indicateurs.
- **Hors panne locale (HL) :** les paquets des secondes de panne locale sont retirés, et la série est coupée à cet endroit (une rafale ne « traverse » pas une panne locale). Tous les indicateurs de décision sont calculés HL ; la perte brute est donnée à côté.
- **Épisode de panne de X :** suite d'au moins `--episode-min-s` secondes consécutives (2 par défaut) où X est en panne, hors panne locale et hors secondes non classables. Y « tombe aussi » s'il est en panne au moins la moitié des secondes de l'épisode où il a des données (convention).
- **Horloge :** dans une tranche, l'instant d'envoi suit l'horloge monotone d'irtt, calée sur l'horloge murale du premier paquet. Un écart de plus de 1 s entre les deux horloges est signalé (« saut d'horloge »).
- **Fins de tranche perdues ≥ 30 s :** une tranche qui finit sur 30 s de pertes ou plus est suspecte. Ce peut être une vraie coupure, ou un artefact : par exemple, le CGNAT a changé le port source en cours de tranche, et le serveur irtt ne reconnaît plus le client. À recouper avec la tranche suivante et avec le tunnel, que WireGuard reprend de lui-même.

### 6.3 Émulation du `timeout`

Chaque paquet de la sonde sert d'instant de départ d'une requête RADIUS fictive.
- L'essai j (j = 0 … K-1) utilise le paquet envoyé à l'instant t + j·T.
- **Variante stricte :** l'essai échoue si ce paquet est perdu, ou si son RTT + temps serveur dépasse T. La requête **expire sur A** si ses K essais échouent.
- **Variante tardive** (dépend de LABO-16) : RouterOS accepterait une réponse au premier envoi arrivée avant la fin des K essais (même identifiant RADIUS). La requête réussit s'il existe un essai j tel que j·T + RTT_j + S ≤ K·T. Elle est moins pessimiste ; la règle de décision (§7.4) prend la variante stricte tant que LABO-16 n'a pas tranché.
- Une requête dont le premier essai réussit n'a pas besoin des essais suivants : elle est évaluée même en fin de capture.

On obtient ainsi, au pic et hors panne locale :
- le **% des instants** où un client qui se connecte à cet instant aurait déclenché une bascule alors que A était en bonne santé : c'est le taux de **fausses bascules** ;
- les **fausses bascules attendues par jour** = taux × nombre d'authentifications par jour et par routeur. Le volume est une **hypothèse** (`--auth-par-jour`, 300 par défaut, **à valider par Yacouba** sur les ventes réelles des sites). Prendre le taux du pic est prudent : c'est l'heure la plus défavorable ;
- le nombre d'**épisodes** (suites d'instants en échec). Un épisode n'est **pas** une requête réelle : avec 5 instants par seconde, une perte aléatoire isolée fait un épisode, même si personne ne se connecte à ce moment-là. Il est donné pour information, pas pour décider.

Le temps serveur par défaut vaut 50 ms : c'est l'objectif p95 de `authorize` (§5.6), un objectif et non une mesure. Le remplacer par la mesure dès qu'elle existe.

Hypothèses du modèle, à confirmer en labo :
- RouterOS renvoie la même requête après chaque T, jusqu'à K essais, puis passe à l'entrée suivante de `/radius`. Le nombre réel d'essais n'est **pas vérifié** (§8.2), d'où la grille K = 1, 2, 3.
- Les essais ont la même probabilité de perte que les paquets de la sonde. En réalité, une requête RADIUS est plus grosse, et sa réponse peut être plus lente qu'un écho irtt.
- Le temps serveur est une constante. En réalité, il a sa propre distribution, à mesurer sur le nœud.

---

## 7. Règles de décision (proposition, à valider par Yacouba)

Toutes les valeurs ci-dessous sont des **propositions**. Elles s'appliquent aux mesures **dans le tunnel** (`*-wg`), qui est le chemin réel de RADIUS, **au pic du soir** et **hors panne locale**, sauf mention contraire. Les mesures hors tunnel servent à interpréter : si le tunnel est nettement pire que l'UDP direct, le problème vient de WireGuard ou du keepalive.

**Principe :** avec un routeur par type d'accès et 2 ou 3 soirées, un écart de quelques ms entre deux datacenters est souvent dans le bruit. Une règle ne départage donc que si l'écart est **net** (même sens sur la plupart des heures et sur chaque soirée) et **utile** (au moins max(10 ms ; 5 %)). Sinon le résultat est « indistinct », et on départage par d'autres critères (perte, rafales, puis prix ou exploitation). Une valeur « indéterminée » n'est **jamais** une condition remplie.

### 7.1 Datacenter du nœud A (Hetzner)

1. Pour chaque datacenter d et chaque type d'accès a : p95e_pic(d, a) (délai effectif), perte_pic(d, a), rafales_≥1s_pic(d, a), et le verdict de la comparaison appariée (tableau 4 bis) pour chaque paire de datacenters.
2. d₁ **bat** d₂ sur l'accès a si le verdict apparié est « d₁ meilleur » (au moins 80 % des heures du pic et chaque soirée) **et** si l'écart médian est d'au moins max(10 ms ; 5 % du p95e de d₂).
3. **A** = le datacenter qui bat les autres sur au moins un accès et n'est battu sur aucun.
   - S'il n'y en a pas (indistinct), départager par la plus petite perte au pic (max sur les accès), puis par le moins de rafales ≥ 1 s, puis par le prix ou l'exploitation. Le noter comme « départage hors latence ».
   - **Seuil d'alerte**, sans être un seuil d'élimination : perte_pic > **1 %** sur fibre ou ADSL, ou > **3 %** sur 4G ou Starlink. Dans ce cas, regarder les heures, la charge WAN et les traceroutes avant de conclure.

### 7.2 Nœud B du pilote (Hetzner, autre datacenter)

- B = le meilleur datacenter **restant** selon 7.1, **à condition que** P(B en panne | A en panne, hors panne locale), **compté en épisodes**, soit ≤ **20 %** sur chaque accès, avec au moins **10 épisodes** de panne de A hors panne locale.
- Moins de 10 épisodes : « indéterminé ». La mesure ne prouve alors ni l'indépendance ni la dépendance. C'est le cas le plus probable sur 72 h : le risque est déjà accepté pour le pilote (ADR 0004, « Risque accepté »). Le noter, et en tenir compte dans le choix du B définitif.
- Sans témoin hors Hetzner (§3.1), la règle ne peut pas être évaluée.
- B doit rester utilisable quand il sert : p95e_pic(B) ≤ p95e_pic(A) + **40 ms** sur chaque accès.

### 7.3 Nœud B définitif (autre hébergeur)

Un candidat c est **éligible** si les trois conditions suivantes sont remplies :
- p95e_pic(c) ≤ p95e_pic(A) + **50 ms**, sur chaque accès ;
- perte_pic(c) ≤ perte_pic(A) + **0,5 point**, sur chaque accès ;
- P(c en panne | A en panne, hors panne locale), en épisodes, ≤ **10 %**, ou « indéterminé » faute d'épisodes. Dans ce dernier cas, l'indépendance repose seulement sur la vérification des traceroutes ci-dessous, et il faut le dire.

Vérification sur les traceroutes : c ne doit pas partager avec A le même dernier opérateur de transit avant l'Europe. Sinon, c'est le même câble ou le même point d'échange.

Un candidat d'**Afrique de l'Ouest** est préféré (ADR 0004) s'il est « nettement meilleur ». Proposition : il bat A au sens de 7.1, point 2, avec un écart médian d'au moins **30 ms**, sur au moins 2 des 3 accès, et sa perte n'est pire sur aucun accès.

### 7.4 `timeout` de `/radius`

Notations, par type d'accès a :
- K = nombre d'essais de RouterOS avant bascule (**[LABO]**, §8.2) ;
- S = temps serveur : 50 ms visés au §5.6, à remplacer par la mesure ;
- W = attente maximale acceptable pour le client quand A est vraiment tombé ;
- R_B = p99 du RTT reçu dans le tunnel vers B, au pic, et S_B le temps serveur de B ;
- seuil de fausses bascules : **0,1 %** des requêtes au pic, soit **0,3 fausse bascule attendue par jour et par routeur** avec l'hypothèse de 300 authentifications par jour (§6.3).

**Définitions :**

```text
T_min(a) = le plus petit T d'une grille fine (pas de 100 ms) pour lequel l'émulation stricte
           (§6.3), au pic, hors panne locale, avec le K mesuré en labo, donne au plus 0,1 %
           de fausses bascules.
T_max    = (W − R_B − S_B) / K                     W proposé : 5 s (à valider, voir ci-dessous)
T        = T_max arrondi aux 100 ms inférieurs, une seule valeur pour tous les accès,
           si T ≥ T_min(a) pour chaque accès a.
```

T_min(a) n'est pas une formule « Q + S + marge » : il est lu directement sur la distribution mesurée (RTT dans le tunnel et pertes, soirée par soirée), avec le temps serveur ajouté. Il se calcule en relançant l'analyse avec une grille fine, par exemple `--timeouts 0.3,0.4,…,3.0 --essais K`. Pour mémoire, Q = max sur les soirées du p99.9 reçu au pic (tableau 3 bis) donne un ordre de grandeur : T_min est en général un peu au-dessus de Q + S quand la perte est faible.

**Hypothèses de T_max, à vérifier en LABO-16 :**
- B répond au premier essai (sa propre perte n'est pas comptée : si son essai se perd, le client attend plus que W) ;
- RouterOS n'ajoute aucun délai propre entre deux essais, ni avant de passer à B ;
- l'attente du client se compte depuis l'émission de la première requête ; le délai propre du portail et du mini-navigateur s'y ajoute (à observer avec LABO-11 et LABO-12) ;
- RouterOS ne mémorise pas la panne de A : chaque authentification paie K·T. S'il la mémorise, seule la première la paie, et W peut être plus large.

**Pourquoi viser le haut de l'intervalle [T_min ; T_max] :**
- **T trop court → fausses bascules**, un jour où A est en bonne santé. Une réponse arrive trop tard ou se perd, et la requête part vers B :
  - B répond depuis une réplique en lecture seule (§10.2) ;
  - les activations et les compteurs ne sont rattrapés qu'au rejeu des fichiers `detail` ;
  - si une réponse tardive de A arrive quand même, son effet est inconnu (**[LABO]**, §8.2).
- **T trop long → attente** seulement quand A est vraiment tombé, ce qui est rare, et borné par W, qui est **par définition** une attente acceptable.

Le coût d'une fausse bascule (cohérence des données) est donc payé les jours normaux, celui d'un T long seulement pendant une panne réelle. Viser T_max minimise les fausses bascules sans dépasser W. Si Yacouba préfère raccourcir l'attente en panne réelle, l'autre choix défendable est **max(T_min(a) ; 1,1 s)** (1,1 s = valeur par défaut de RouterOS, E-ROS-8), au prix de plus de fausses bascules : la vérification ci-dessous dit combien.

**Vérification :** avec le T retenu, relire au tableau 2 les fausses bascules attendues par jour au pic, pour chaque accès, avec le K mesuré en labo. Elles doivent rester sous 0,3 par jour (ou sous le seuil que Yacouba fixera). Si la variante tardive donne un chiffre nettement plus bas, c'est un argument pour trancher vite LABO-16.

**Ce qu'un T plus long ne règle pas : la perte.** Avec K = 1, un paquet perdu fait basculer, quel que soit T. Le taux de fausses bascules ne peut donc pas descendre sous le taux de perte. Seul le **renvoi** (K ≥ 2) le fait baisser, à condition que les pertes ne viennent pas en rafales plus longues que T. C'est pourquoi le nombre d'essais de RouterOS est la donnée qui manque le plus (§8.2). Les rafales mesurées (§6.1, tableau 1) disent si K = 2 suffit.

**W, l'attente acceptable : 5 s proposées.** L'utilisateur vient de valider son ticket sur la page du portail. Au-delà de quelques secondes, il recommence ou abandonne.

**Une valeur par type d'accès ?** Seulement si T_min(a) > T_max pour un accès : il n'y a alors pas de valeur unique. Dans ce cas, ne poser une valeur par type d'accès à l'enrôlement (§6.2) **qu'après une seconde mesure sur un autre routeur du même type** : un seul routeur par type ne représente pas le type (§8.1). Si T_min(a) > T_max même ainsi, il n'y a pas de bonne valeur : accepter plus de fausses bascules sur cet accès, et le dire au propriétaire.

**Exemple chiffré FICTIF, pas une mesure :**
- Hypothèses : K = 2 ; S = S_B = 50 ms ; W = 5 s ; R_B = 300 ms ; T_min lus sur l'émulation : 0,4 s (fibre), 1,2 s (Starlink), 2,0 s (4G).
- T_max = (5 000 − 300 − 50) / 2 = 2 325 ms, d'où **T = 2,3 s** pour tous les accès : 2,3 s ≥ 2,0 s.
- Attente en panne réelle de A : 2 × 2,3 + 0,3 + 0,05 ≈ 4,95 s ≤ W.
- La valeur `timeout=3s` de l'exemple de la spec ferait attendre 6,35 s avec K = 2 : au-delà de W.
- Avec l'autre choix, max(T_min ; 1,1 s), on aurait 1,1 s (fibre), 1,2 s (Starlink) et 2,0 s (4G) : trois valeurs à poser à l'enrôlement, et plus de fausses bascules sur fibre qu'avec 2,3 s.

---

## 8. Limites et incertitudes

### 8.1 Limites de la mesure

- **48 à 72 h ne sont pas une saison.** La mesure ne couvre :
  - ni la saison des pluies (atténuation, coupures), ni l'harmattan ;
  - ni les pics de délestage de la saison chaude ;
  - ni les fêtes et les grands matchs (trafic) ;
  - ni les incidents de câble sous-marin.
  Il faudra rejouer une mesure courte à une autre saison avant G-PILOTE, et garder une supervision continue en production (§10.3).
- **Trois routeurs ne sont pas un parc.** Un seul opérateur 4G, un seul quartier, une seule antenne et un seul abonnement Starlink. Les écarts entre opérateurs ne sont pas mesurés. D'où la règle du §7.4 : pas de valeur par type d'accès sans seconde mesure.
- **2 ou 3 soirées ne sont pas une statistique.** L'IC par bootstrap le dit, mais avec si peu de blocs il est lui-même fragile. Les règles du §7 exigent donc un écart net sur chaque soirée.
- **Une VM n'est pas le nœud final.** Même datacenter, mais pas forcément la même baie ni le même réseau. Une IP publique réattribuée peut aussi changer de route. L'écart est probablement faible : à vérifier en comparant la VM et le nœud réel après l'achat.
- **72 h ne mesurent pas la fiabilité de l'hébergeur.** La corrélation mesurée est celle des **chemins** vus du Burkina, pas celle des incidents propres à Hetzner. ADR 0004 traite ce risque autrement (point 3). Sur 72 h, le nombre d'épisodes de panne de A hors panne locale sera probablement trop faible pour conclure (« indéterminé »).
- **Panne locale et témoin.** Un témoin européen tombe avec Hetzner si tout le transit vers l'Europe tombe : cette panne commune est classée locale. Un témoin en Afrique de l'Ouest la distinguerait.
- **Le modèle de `timeout` est un modèle** (§6.3) : taille des paquets, temps serveur réel, volume d'authentifications supposé, et comportement de RouterOS supposé.
- **Flux clairsemé :** il ne remplace pas un vrai routeur au repos avec de vrais clients ; le ping vise la VM, pas FreeRADIUS ; un intervalle de 20 à 60 s ne teste pas les silences plus longs (nuit sans client). Le sens VM → sonde passe par le NAT du routeur et par celui de l'opérateur, pas par `/radius incoming`.
- **CGNAT et irtt :** si le CGNAT change le port source pendant une tranche, le serveur irtt peut ne plus reconnaître le client jusqu'à la tranche suivante (comportement d'irtt non vérifié). L'indicateur « fins de tranche perdues » le signale. Le tunnel, lui, survit grâce à WireGuard.
- **irtt et les erreurs d'envoi :** vérifié en local, irtt s'arrête dès qu'un envoi échoue (« network is unreachable »), avec le code 0. Sur le terrain, cela arrivera surtout si l'interface de la sonde tombe ; si c'est le WAN du routeur qui tombe, la sonde, sur le LAN, ne voit en général que des pertes (non vérifié). `sonde.sh` rouvre aussitôt une tranche, et l'analyse compte ces arrêts à part.
- **irtt après une poignée de main WireGuard :** au premier test local, 2 fois en 3 passages complets, une tranche ouverte dans le tunnel juste après une coupure s'est close au bout de 0,2 s, avec un seul paquet et un code de retour 0. Hypothèse, non vérifiée : WireGuard a retenu plusieurs demandes d'ouverture irtt pendant la poignée de main, puis les a livrées ensemble. L'analyse classe cette tranche en « fin anticipée inexpliquée » et retire son paquet en vol. Il reste un silence de quelques secondes, compté dans le silence complet de la rafale, pas dans la durée des pertes mesurées.
- **Horloges :** RTT et rafales ne dépendent que de l'horloge de la sonde (monotone dans une tranche). Le classement par heure suppose une sonde synchronisée par NTP. Le journal de la sonde note `ntp_synchronise` à chaque démarrage, et l'attente NTP éventuelle.
- **Starlink :** des pics de latence périodiques liés aux changements de satellite sont rapportés par des tiers (période de 15 s, à vérifier). Ils se verront dans la gigue et dans la queue de distribution. Si besoin, les rechercher dans le détail par paquet des captures.

### 8.2 Ce qui reste [LABO]

| Question | Pourquoi c'est bloquant | Où la trancher |
|---|---|---|
| **Nombre d'essais de RouterOS** sur une entrée `/radius` avant de passer à la suivante, et intervalle entre essais (non vérifié). La description du paramètre `timeout` parlerait d'un renvoi de la requête : à vérifier dans la doc 7.25. | K dans le §7.4 ; c'est lui qui fixe le plancher des fausses bascules et T_max. | LABO-16 / LABO-09 : `tcpdump` sur A pendant qu'A ne répond pas, et compte des Access-Request identiques (même identifiant RADIUS). |
| **Mémoire de la bascule :** après un timeout sur A, la requête suivante repart-elle vers A ou directement vers B ? | Fixe le coût d'un vrai incident sur A : K·T par authentification, ou une seule fois. | LABO-16. |
| **Bascule sur Reject ou seulement sur timeout** (E-ROS-7). | T13, §10.2. | LABO-16 (tel que décrit dans `docs/LABO.md` §4.18). |
| **Que devient une réponse tardive de A** arrivée avant la fin des essais, ou après la bascule ? | Variante « tardive » de l'émulation ; risque de double session ou de décision contradictoire. | LABO-16 : `tc netem delay` sur A, réglé un peu au-dessus de T. |
| Valeur par défaut et bornes de `timeout` en 7.15 et en stable (E-ROS-8 : 1 100 ms par défaut d'après un extrait). | Point de départ du réglage ; T = 2,3 s doit être accepté. | Relecture de la doc 7.25 et `print` sur CHR. |

Les profils équivalents produits par l'analyse (§6.1, tableau 5) donnent à LABO-16 des pertes et des latences réalistes, au lieu de valeurs inventées.

---

## 9. Preuves : test local des outils (10/11/2026)

**Ce test prouve que les outils fonctionnent et retrouvent un profil connu. Il ne dit rien du Burkina.** Preuves : `infra/lab/latence/evidence/`, détail et chiffres dans `evidence/RESULTATS-TEST.md`.

### 9.1 Montage

- Deux espaces de noms réseau, reliés par une paire veth : « sonde » et « cible ».
- Côté cible :
  - serveur irtt, avec les options de `serveur-vm.sh` ;
  - WireGuard en espace utilisateur (wireguard-go : pas de module noyau dans le conteneur) ;
  - deux dégradeurs UDP (`outils/degradeur.py`), un sur le trafic irtt direct et un sur le trafic WireGuard, qui injectent le même profil.
- Côté sonde : `sonde.sh` vers `vm-udp` (hors tunnel, dégradé), `vm-wg` (dans le tunnel, dégradé) et `ref-udp` (témoin, non dégradé) ; `rare.sh` dans les deux sens ; `recepteur-syslog.py`.
- Pourquoi un dégradeur et pas `tc netem` : le noyau n'a pas `sch_netem` (« Specified qdisc kind is unknown », revérifié lors de la révision). **`tc netem` n'a donc pas été testé.**

Rejeu : `infra/lab/latence/outils/test-local.sh` (environ 13 min, root).

### 9.2 Résultats

Passage final du 10/11/2026, 21:32–21:44 UTC (`evidence/00-test-local.log`).

| Profil injecté | Retrouvé par `analyse.py` (hors tunnel / tunnel) |
|---|---|
| ~90 ms ± 10 ms, 0,5 % de perte (sonde à 50 ms) | p50 91,3 / 91,9 ms ; p95 108,5 / 108,7 ms ; gigue 11,4 ms ; perte 0,53 / 0,50 % ; pertes vues = paquets jetés |
| ~150 ms ± 40 ms, 2 % de perte en rafales (Gilbert p = 0,51 %, r = 25 %), SIGTERM à tout le groupe de processus | p50 150,8 / 151,3 ms ; p95 215,0 / 215,9 ms ; Gilbert ajusté p = 0,48 %, r = 24 % ; 54 pertes = 54 paquets jetés ; tranche interrompue écrite pour chaque cible |
| Coupure franche de 15 s (sonde à 200 ms), témoin joignable | plus longue rafale 75 paquets, 15,0 s ; **panne locale 0 s** ; perte hors panne locale = perte brute |
| Cible injoignable ≈ 18 s au démarrage | 2 échecs d'ouverture de 9 s ; 90 paquets « indisponibles » ; 0 perte réelle |
| Panne amont de 12 s (témoin compris), puis interface de la sonde tombée 6 s | **panne locale 17 s** ; perte brute 8,3 / 12,0 %, hors panne locale 0,76 % ; arrêt d'irtt sur erreur d'envoi reconnu ; corrélation « indéterminé » (0 épisode) |
| Flux clairsemé et syslog simulés | 54 et 55 pings, p50 ≈ 90 ms ; débit WAN 1,0 / 0,2 Mbit/s = valeurs injectées |

- Contrôles automatiques : **73/73 PASS** (`verifier-test.py`, contre le profil injecté) et **67/67 PASS** (`test-analyse.py`, 11 jeux synthétiques aux valeurs calculées à la main, dont les jeux de la relecture adversariale).
- Le premier passage de la version révisée avait **7 FAIL** (`evidence/RESULTATS-TEST.md` §4). Cinq révélaient un vrai défaut : quand SIGTERM touche tout le groupe de processus (systemd par défaut), irtt recevait deux signaux différents et sortait **sans écrire sa tranche**. `sonde.sh` a été corrigé, puis tout a été rejoué. Les deux autres venaient d'une perte isolée dans le tunnel, 5 s après une coupure (reprise de poignée de main WireGuard, hypothèse) : contrôle élargi d'une perte, pour le tunnel seulement.
- Comportements d'irtt vérifiés à part (`evidence/irtt-essais.txt`) : deux signaux différents presque simultanés → code 3, tranche non écrite ; interface tombée → arrêt avec le code 0 et `send_err` rempli.

### 9.3 Ce qui est prouvé, et ce qui ne l'est pas

| Prouvé (sortie réelle dans `evidence/`) | Non prouvé |
|---|---|
| `sonde.sh` : tranches horodatées et bien nommées ; arrêt propre sur SIGTERM au processus principal (1ᵉʳ passage) et au groupe de processus entier (passage final) ; reprise ; échec d'ouverture journalisé ; arrêt d'irtt sur erreur d'envoi reconnu (`send_err=oui`) ; fin par `-D` et par `-F`. | Aucune mesure sur Internet ; **aucun chiffre du Burkina**. |
| `analyse.py` retrouve perte, RTT, gigue, rafales et paramètres de Gilbert ; distingue une coupure du chemin (témoin joignable) d'une panne locale (témoin muet) ; centiles effectifs, soirées, appariement, épisodes, fausses bascules par jour et variante tardive vérifiés sur des captures synthétiques aux valeurs calculées à la main. | `tc netem` (absent du noyau de test) ; le dégradeur ne simule ni file d'attente ni débit ; aucune radio 4G : le flux clairsemé n'est testé que pour son fonctionnement. |
| Mesure dans le tunnel WireGuard (wireguard-go). | WireGuard noyau ; WireGuard sur RouterOS (variante R). |
| `recepteur-syslog.py` et la lecture des compteurs WAN, sur des lignes **au format supposé** du routeur. | Le format réel des messages syslog de RouterOS. |
| `serveur-vm.sh` : installation répétée, clés, conf sans clé privée, seconde adresse R, nftables, refus des entrées invalides et d'une IP déjà attribuée. Tout cela avec systemd simulé. | `serveur-vm.sh` sur une vraie Debian avec systemd ; tenue de SSH à l'activation du pare-feu ; un vrai `systemctl stop` sur la sonde ; `chrony-wait.service`. |
| — | `routeros-sonde.rsc` : **jamais exécuté** (pas de CHR). |
| — | Le comportement de RouterOS (essais, bascule) : [LABO] (§8.2). |
