# Labo de latence — outils du protocole

Ce dossier outille `docs/PROTOCOLE_LATENCE.md`, qui fait foi pour le « pourquoi » et les règles de décision. Ici, on ne trouve que le « comment » et le rejeu.

**Statut :** les scripts Linux sont testés de bout en bout sur une seule machine, avec un réseau simulé (section 4). Ils n'ont **pas** été lancés sur une vraie VM Debian, ni depuis le Burkina, ni sur un routeur. `routeros-sonde.rsc` n'a **jamais** été exécuté (pas de CHR dans la session qui l'a écrit).

## 1. Fichiers

| Fichier | Où il tourne | Rôle |
|---|---|---|
| `serveur-vm.sh` | VM cible (Debian, root) | Installe irtt, wireguard-tools, nftables, chrony et iputils-ping ; crée le service irtt, l'interface `wg-labo` et un pare-feu minimal. Idempotent. La clé privée WireGuard est générée sur la VM et ne s'affiche jamais. |
| `sonde.sh` | Linux derrière le routeur | Client irtt continu vers chaque cible, par tranches horodatées (`.json.gz`), avec journal d'événements, attente NTP et reprise. |
| `rare.sh` | Linux derrière le routeur, et VM | Flux clairsemé : un ping dans le tunnel toutes les 20 à 60 s (phase clairsemée, PROTOCOLE §5.6 bis). |
| `recepteur-syslog.py` | Linux derrière le routeur | Reçoit le journal du routeur en syslog UDP (port 5514), l'horodate avec l'horloge NTP de la sonde. |
| `analyse.py` | n'importe où (Python 3, bibliothèque standard) | Indicateurs par (accès × cible), brut et hors panne locale ; centiles effectifs ; timeout émulé (strict et tardif, fausses bascules par jour) ; pic, soirées, bootstrap ; comparaison appariée ; corrélation des pannes en épisodes ; profil netem ; charge WAN ; flux clairsemé. Écrit `.md` et `.csv`. |
| `routeros-sonde.rsc` | routeur MikroTik | Sonde secondaire ICMP (netwatch + `/ping` planifié), compteurs WAN, repère de démarrage, journal en syslog vers la sonde ; exception hotspot et tunnel de labo (variante R) facultatifs. **Non exécuté.** |
| `outils/degradeur.py` | test local | Relais UDP qui injecte délai, gigue, perte (indépendante ou Gilbert) et coupures. Sert à remplacer `tc netem` quand le noyau n'a pas `sch_netem`. |
| `outils/test-local.sh` | test local (root) | Rejoue le test de bout en bout : 2 espaces de noms réseau, WireGuard, témoin, 5 profils, flux clairsemé, syslog. |
| `outils/test-analyse.py` | test local | Vérifie `analyse.py` sur des captures synthétiques au format irtt, aux valeurs connues d'avance (11 jeux, dont ceux de la relecture adversariale). |
| `outils/test-serveur-vm.sh` | test local (root) | Test partiel de `serveur-vm.sh` : espaces de noms réseau et de montage isolés, `systemctl` remplacé par un bouchon. |
| `outils/verifier-test.py` | test local | Compare la sortie d'`analyse.py` aux profils injectés par `test-local.sh` (PASS / FAIL). |
| `evidence/` | — | Captures et sorties du test local du 10/11/2026. |

## 2. Rejouer le test local (sans Burkina, sans VM)

Il faut root sur un Linux avec `ip netns`, `irtt`, `wireguard-tools`, `nftables`, `iputils-ping`, `python3`. Sans module noyau WireGuard, il faut aussi `wireguard-go`.

```bash
apt-get install -y irtt wireguard-tools iputils-ping nftables
# Si « ip link add x type wireguard » échoue (pas de module noyau) :
GOBIN=$PWD/bin go install golang.zx2c4.com/wireguard@latest   # binaire « wireguard » = wireguard-go
sudo WG_GO=$PWD/bin/wireguard infra/lab/latence/outils/test-local.sh /tmp/latence-test
# le script enchaîne : analyse.py, verifier-test.py, test-analyse.py ; résumé dans /tmp/latence-test/00-test-local.log
sudo infra/lab/latence/outils/test-serveur-vm.sh       # test partiel de serveur-vm.sh (quelques secondes)
```

Durée : environ 13 minutes. Le script nettoie ses espaces de noms et ses processus à la fin, même s'il est interrompu. Il arrête ses processus par PID, jamais par motif (`pkill -f` tuait le shell appelant lors d'un premier essai).

Profils injectés (dégradeur sur l'aller, mêmes paramètres pour le trafic irtt direct et pour le trafic WireGuard). La sonde vise trois cibles : `vm-udp` et `vm-wg` (dégradées) et `ref-udp` (le **témoin**, non dégradé) ; l'analyse est lancée avec `--groupes-hetzner vm`.

| Accès simulé | Profil | Durée |
|---|---|---|
| `simfibre` | 90 ms ± 10 ms (gaussien), 0,5 % de perte indépendante ; sonde à 50 ms pour avoir assez de pertes. En parallèle : `rare.sh` dans les deux sens (2 à 4 s au lieu de 20 à 60 s) et `recepteur-syslog.py` avec des lignes au format supposé du routeur | 180 s |
| `sim4g` | 150 ms ± 40 ms, perte de Gilbert p = 0,51 %, r = 25 % (moyenne 2 %, rafale moyenne 4 paquets) ; sonde à 50 ms ; SIGTERM à **tout le groupe de processus** à 45 s (comme systemd avec `KillMode=control-group`), puis reprise | 45 + 95 s |
| `simcoupure` | 90 ms ± 10 ms, sans perte, coupure totale de 15 s (de +40 s à +55 s) ; le témoin reste joignable | 90 s |
| `simouverture` | cible coupée pendant les 20 premières secondes : la sonde ne peut pas ouvrir sa session ; fin donnée en date absolue (`-F`) | 60 s |
| `simlocale` | panne amont de 12 s (tout l'UDP jeté côté cible, témoin compris), puis interface de la sonde tombée 6 s (irtt s'arrête sur erreur d'envoi) | 150 s |

## 3. Sur le terrain : rejeu pas à pas

La procédure complète, avec les vérifications, est au §5 de `docs/PROTOCOLE_LATENCE.md`. En résumé :

```bash
# --- Sur chaque VM cible (root) ---
WG_ADRESSE=10.254.213.1/24 ./serveur-vm.sh installer     # .1 Falkenstein, .2 Nuremberg, .3 Helsinki, .4 candidat B, .9 témoin
# (variante R prévue : ajouter WG_ADRESSE_R=10.254.214.1/24, etc.)
# noter la clé publique affichée ; ouvrir UDP 51820 et 2112 dans le pare-feu de l'hébergeur s'il y en a un

# --- Sur chaque sonde Linux ---
apt-get install -y irtt wireguard-tools
umask 077; wg genkey > /etc/wireguard/wg-labo.cle-privee      # reste sur la sonde
wg pubkey < /etc/wireguard/wg-labo.cle-privee                   # à recopier sur chaque VM

# --- Sur chaque VM : déclarer la sonde (clé publique seulement) ---
./serveur-vm.sh ajouter-pair ouaga1-fibre CLE_PUBLIQUE_DE_LA_SONDE 10.254.213.11

# --- Sur la sonde : lancer 48 à 72 h (en pratique : par les services systemd ci-dessous) ---
./sonde.sh -s ouaga1 -a fibre -c cibles.conf -o /var/lib/wakatnet-latence -F 2026-11-15T12:00:00Z
```

Exemple de `cibles.conf` (adresses de documentation, à remplacer) :

```text
# NOM        HOTE:PORT
fsn-udp      203.0.113.10:2112
fsn-wg       10.254.213.1:2112
nbg-udp      203.0.113.20:2112
nbg-wg       10.254.213.2:2112
hel-udp      203.0.113.30:2112
hel-wg       10.254.213.3:2112
# témoin hors Hetzner (obligatoire : sans lui, les pannes locales ne sont pas reconnues)
ref-udp      198.51.100.40:2112
ref-wg       10.254.213.9:2112
```

Service systemd conseillé sur la sonde, pour repartir seul après une coupure de courant :

```ini
# /etc/systemd/system/wakatnet-sonde.service
[Unit]
Description=wakatnet-labo sonde de latence
# time-sync.target n'attend une vraie synchronisation que si chrony-wait.service
# (ou systemd-time-wait-sync.service avec timesyncd) est activé : à vérifier selon
# la distribution. sonde.sh attend de toute façon NTPSynchronized=yes (-N, 15 min au plus).
Wants=network-online.target chrony-wait.service
After=network-online.target time-sync.target chrony-wait.service

[Service]
ExecStart=/opt/wakatnet-latence/sonde.sh -s ouaga1 -a fibre -c /opt/wakatnet-latence/cibles.conf -o /var/lib/wakatnet-latence -F 2026-11-15T12:00:00Z
# Relance seulement sur échec ; jamais sur erreur d'usage (2) ni date de fin passée (4).
Restart=on-failure
RestartPreventExitStatus=2 4
RestartSec=10
# SIGTERM au seul sonde.sh, qui arrête proprement ses clients irtt ; SIGKILL au reste après 30 s.
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/wakatnet-syslog.service
[Unit]
Description=wakatnet-labo réception du journal du routeur
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/python3 /opt/wakatnet-latence/recepteur-syslog.py -s ouaga1 -a fibre -o /var/lib/wakatnet-latence --ecoute 0.0.0.0:5514 --source IP_LAN_DU_ROUTEUR
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Utiliser `-F` (date de fin absolue, UTC) plutôt que `-H` : après une coupure de courant, `-H 72` repartirait de zéro. Une fois la date passée, la sonde sort avec le code 4 (« date déjà passée ») et systemd ne la relance pas. `KillMode=mixed` et `RestartPreventExitStatus` n'ont **pas** été essayés avec un vrai systemd (le conteneur de test n'en a pas) : vérifier `systemctl stop` sur la vraie sonde (PROTOCOLE §5.7).

Analyse :

```bash
python3 analyse.py docs/labo/latence/ --sortie docs/labo/latence/2026-MM-JJ-resultat
# pour T_min (PROTOCOLE §7.4) : grille fine, K mesuré en labo
python3 analyse.py docs/labo/latence/ --sortie /tmp/tmin --essais 2 --bootstrap 0 \
    --timeouts 0.3,0.4,0.5,0.6,0.7,0.8,0.9,1,1.1,1.2,1.3,1.4,1.5,1.6,1.7,1.8,1.9,2,2.1,2.2,2.3,2.5,3
```

## 4. Ce qui est prouvé, et ce qui ne l'est pas

Prouvé dans le conteneur de test (Ubuntu 24.04, noyau 6.18, irtt 0.9.0, wireguard-go, Python 3.13), preuves dans `evidence/` (synthèse : `evidence/RESULTATS-TEST.md`) :
- `sonde.sh` produit des tranches `.json.gz` lisibles, horodatées et nommées selon la convention. Il journalise les échecs d'ouverture, reprend après eux, reconnaît l'arrêt d'irtt sur erreur d'envoi (`send_err=oui`), s'arrête proprement sur SIGTERM envoyé au processus principal **ou à tout le groupe de processus** (irtt écrit sa tranche en cours), et s'arrête seul à la date `-F` ou après `-D`.
- Un défaut réel trouvé et corrigé pendant la révision : irtt qui reçoit deux signaux différents presque en même temps sort avec le code 3 **sans écrire sa tranche** ; avec `KillMode=control-group` (défaut de systemd), la dernière tranche était perdue. Détail dans `evidence/RESULTATS-TEST.md`.
- `analyse.py` retrouve les profils injectés (`verifier-test.py`) et les valeurs calculées à la main sur 11 jeux synthétiques (`test-analyse.py`) : centiles reçus et effectifs, fins anticipées, panne locale avec et sans témoin, épisodes, fausses bascules par jour, variante tardive, `--exclure`, intervalles mélangés, sauts d'horloge, soirées et comparaison appariée.
- La mesure dans le tunnel WireGuard fonctionne (wireguard-go en espace utilisateur, pas le module noyau).
- `rare.sh` (dans les deux sens) et `recepteur-syslog.py` fonctionnent, et `analyse.py` lit leurs journaux. Les lignes du routeur sont **simulées**, au format supposé.
- `serveur-vm.sh installer` (deux fois de suite, avec seconde adresse R) et `ajouter-pair` (L, R, refus d'une IP déjà attribuée, mise à jour d'une clé), avec `systemctl` remplacé par un bouchon, dans un espace de noms réseau et de montage isolé (`outils/test-serveur-vm.sh`, sortie dans `evidence/serveur-vm-partiel.txt`).

Non prouvé :
- `serveur-vm.sh` sur une vraie Debian avec systemd : démarrage réel des services `irtt` et `wg-quick@wg-labo`, `wg syncconf` lors d'un ajout de pair sur une interface active, tenue de la session SSH à l'activation du pare-feu.
- Les unités systemd du §3 (`KillMode=mixed`, `RestartPreventExitStatus`, `chrony-wait.service`) : pas de systemd dans le conteneur.
- `routeros-sonde.rsc` n'a pas tourné. Toutes ses lignes sont à valider sur CHR (règle 6 du §13), y compris le format des messages syslog.
- Le comportement de `tc netem` n'a pas été testé : le noyau n'avait pas `sch_netem`. Le dégradeur le remplace, avec ses propres limites : il ne fait pas de file d'attente, il n'a pas de débit limité et sa gigue est gaussienne.
- Aucune radio 4G, aucun CGNAT : le flux clairsemé n'est testé que pour son fonctionnement.
- Rien n'a été mesuré sur Internet. Aucun chiffre de ce dossier ne décrit le Burkina.

## 5. À savoir avant de versionner

- `.gitignore` ignore `*.log`. Seuls `infra/lab/freeradius/evidence/*.log`, `infra/dev/evidence/*.log` et `docs/labo/**/*.log` sont réintégrés. **Les `.log` de `infra/lab/latence/evidence/` sont donc ignorés tant qu'on n'ajoute pas** `!infra/lab/latence/evidence/**/*.log` (ce dossier n'a pas le droit de toucher `.gitignore`). Les `.json.gz`, `.md` et `.csv` ne sont pas ignorés : c'est vérifié avec `git check-ignore`.
- Les vraies mesures vont dans `docs/labo/latence/`, où les `.log` sont déjà réintégrés.
- Volume mesuré ici : environ **96 octets par paquet** en `.json.gz` avec les options par défaut, **44** avec `-X "--tstamp=none"` (999 paquets, irtt 0.9.0). 72 h × 8 cibles (3 Hetzner et un témoin, hors tunnel et dans le tunnel) × 5 paquets/s font environ 10,4 millions de paquets par sonde, soit **≈ 1 Go** (ou ≈ 450 Mo sans horodatage serveur). C'est trop pour le dépôt : versionner le résultat de l'analyse, les journaux et un `SHA256SUMS`, et archiver les captures ailleurs (décision de Yacouba).
