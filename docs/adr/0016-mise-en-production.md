# ADR 0016 — Mise en production de l'API et du portail : service systemd, nginx, TLS, limites, pare-feu public

- **Statut** : **accepté le 12/11/2026, par délégation de Yacouba** (« continue avec la phase 6 »).
- **Références** :
  - `docs/SPEC.md` §3 (D7), §4, §10.1 (limitation de débit), §12 (phase 6) ;
  - ADR 0004, 0013 §10 (IP dédiée du portail), 0015 §7 ;
  - `docs/REVUE_SECURITE.md` M1, M7, F5, F10.

## Contexte

La revue de sécurité de la phase 5 a relevé qu'aucun fichier du dépôt ne déploie l'API ni le portail : ni TLS, ni proxy inverse, ni limite de débit. Le pilote (phase 6) en a besoin dès le premier jour.

## 1. L'API en service systemd, et non en conteneur : écart avec D7

D7 prévoyait l'API, le portail et le tableau de bord en conteneurs.

| Forme | Pour | Contre |
|---|---|---|
| A. Conteneur Docker | Image figée, déploiement atomique | Démon Docker de plus sur le nœud ; ses propres règles nftables ; une seconde copie de Node et des dépendances |
| B. **Service systemd** (`node src/serveur.ts`) | Le Node officiel et le code sont **déjà** sur le nœud pour les tâches (ADR 0015 §7) ; même durcissement que les autres unités ; une couche de moins | Mise à jour par Ansible plutôt que par image |

**Retenu : B.** C'est un seul processus, qui sert `/v1`, `/admin`, `/tableau`, `/p`, `/webhooks`, `/enroll` et `/etat`. Il écoute sur `127.0.0.1:3000` seulement. L'unité est `wakatnet-api.service`, durcie, avec `DynamicUser`.

## 2. nginx devant l'API

nginx est retenu, comparé à Caddy :
- c'est un paquet Debian ;
- `limit_req` est intégré, alors que la limitation de débit de Caddy est un greffon hors de la version standard.

- **Noms et filtrage par en-tête `Host`** (F10) :

  | Nom | Sert | Refuse |
  |---|---|---|
  | `api.DOMAINE` | `/v1`, `/admin`, `/tableau`, `/enroll`, `/webhooks`, `/etat` | `/p/` (404) |
  | `portail.DOMAINE` (IP dédiée, ADR 0013 §10) | `/p/`, `/etat` | tout le reste (404) |
  | tout autre nom | — | la connexion est fermée (`return 444`) |

- **TLS** :
  - Let's Encrypt par certbot (défi http-01, webroot), renouvelé par la minuterie du paquet. Les certificats passent à 64 jours le 10/02/2027 : certbot renouvelle aux deux tiers de leur durée ;
  - aucun agrafage OCSP (arrêté par Let's Encrypt) ;
  - HSTS sur `api.` seulement : le portail est ouvert depuis un hotspot, en clair, puis redirigé.
- **Limites par source** (M1) : l'IPv4, ou le /64 d'une IPv6 (un abonné en reçoit un entier), comme dans l'API :

  | Zone | Chemins | Limite |
  |---|---|---|
  | `connexion` | `/v1/connexion`, `/v1/inscription`, `/v1/totp` | 10 par minute, rafale de 5 : protège scrypt et le pool de threads de libuv |
  | `payer` | `POST /p/*/payer` | 30 par minute, rafale de 10 : les clients d'un site sortent tous par l'IP WAN de son routeur, dont l'API garde aussi le budget (30 par minute et par source, migration 0031) |
  | `general` | tout le reste | 20 par seconde, rafale de 40 |

  - `client_max_body_size 64k`, comme l'API.
  - **Dans l'API** (migration 0031, M2 et M7) : la garde des paiements compte par (site, source), avec un plafond de 100 par minute et par site ; le verrou des connexions compte par (adresse, source), avec un plafond de 10 par adresse pour les sources inconnues, et un budget propre à chaque appareil connu (cookie posé à une connexion réussie).
  - **Budget propre aux routeurs** (migration 0032, M7) : `wg-agent` note l'IP publique de chaque routeur, point de terminaison de son pair sur `wg0` après une poignée de main de moins de 3 min. WireGuard ne la change que sur un paquet authentifié par la clé du routeur. Une demande qui vient de l'IP d'un routeur actif du site, vue il y a moins de 10 min, a son propre budget de 30 par minute, hors plafond. Les autres sources gardent les règles ci-dessus. Le rôle `wk_wg`, qui ne faisait que lire, écrit désormais ces IP, par une seule fonction, sans effet sur une réplique. Règle de santé `ip_routeurs` : sur le primaire, plus aucune IP notée.
  - **Reste de M7** : un voisin de NAT ou de CGNAT, qui partage l'IP publique du routeur, partage aussi son budget et peut le vider. Quand le routeur n'est pas reconnu (double WAN, CGNAT qui sépare TCP et UDP, clients en IPv6, `wg-agent` arrêté), le hotspot retombe sur les règles de 0031.
- **IP réelle** : nginx pose `X-Forwarded-For` ; l'API fait confiance au seul proxy local (`trustProxy: 127.0.0.1`, `WAKATNET_TRUST_PROXY`). L'API **refuse de démarrer en production** sans lui : toutes les requêtes viendraient de 127.0.0.1, et les limites par source retomberaient en silence sur une seule source.
- **Ce qui est gardé** : la source n'est jamais gardée en clair, mais en HMAC (clé `WAKATNET_CLE_HMAC`, renouvelée chaque jour UTC ; l'API refuse de démarrer en production sans elle) ; une heure pour les paiements, un jour pour les connexions. Le journal d'accès de nginx garde, lui, les IP en clair (rotation du paquet, environ 14 jours) : à décrire au registre de traitement (`docs/CONFORMITE.md`).

## 3. Pare-feu de l'interface publique (F5)

- La table `inet wakatnet_public` filtre l'entrée **hors** `lo`, `wg0` et `wk-noeuds`, qui ont chacune leur table.
  - Politique `drop` ; sont admis :
    - `established` ;
    - ICMP limité ;
    - SSH sur le port déclaré ;
    - 80 et 443 ;
    - le port UDP de `wg0` et celui de `wk-noeuds`.
- **Anti-lockout** :
  1. avant de charger la table, Ansible programme son retrait dans 5 minutes (`systemd-run --on-active=300`) ;
  2. il charge la table, rouvre une connexion **neuve** au nœud et la vérifie ;
  3. il n'annule le retrait qu'ensuite.

  Une erreur de port SSH se corrige donc seule en 5 minutes.

## 4. Preuves attendues

`infra/ansible/essais/essai.sh` sur conteneurs :
- `nginx -t` ;
- filtrage par `Host` ;
- 429 au-delà de la limite ;
- `X-Forwarded-For` transmis ;
- pare-feu : 443 ouvert, PostgreSQL et le port de l'API fermés depuis l'autre nœud ;
- minuterie de retour arrière programmée puis annulée.

Certbot réel et DNS restent à jouer sur les nœuds.

## Audit du 13/11/2026

### Frontal, pare-feu public, unité de l'API

- **Renouvellement TLS** (élevé) : certbot n'avait pas de `--deploy-hook`. nginx ne relisait donc jamais le certificat renouvelé, et servait l'ancien jusqu'à son expiration.
  - Correctif : `--deploy-hook "systemctl reload nginx"` à l'obtention.
  - Pour les nœuds déjà installés, le crochet `/etc/letsencrypt/renewal-hooks/deploy/wakatnet-nginx.sh` est déposé par Ansible.
- **TLS par nœud** (élevé) : `letsencrypt` était le mode par défaut de tous les nœuds. Sur B, le défi ACME échoue, puisque le DNS pointe vers A. Le passage s'arrêtait dans `frontal`, avant `parefeu` : la réplique restait sans pare-feu public, et ne pouvait plus être mise à jour. Correctifs :
  - `frontal_tls` se règle par nœud, et vaut `autosigne` par défaut : un certificat auto-signé local, sans certbot ;
  - l'inventaire met `letsencrypt` sur le seul nœud visé par le DNS. À la bascule, B passe en `letsencrypt` (RUNBOOK §3) ;
  - un nœud `letsencrypt` sans certificat sert aussi l'auto-signé pendant le défi : il n'y a plus de configuration « port 80 seul » ;
  - `parefeu` passe juste après `socle` dans `site.yml`.
- **Retour arrière du pare-feu** (moyen) : il ne retirait la table qu'en mémoire. Au passage suivant, Ansible répondait « ok » sans pare-feu actif, et le prochain démarrage rechargeait le fichier fautif. Correctifs :
  - le script `wakatnet-parefeu-retour` remet aussi le fichier précédent en place (sauvegarde du gabarit) et le recharge. Sans fichier précédent, il efface le fichier et la table ;
  - à chaque passage, Ansible vérifie que la table est chargée, et la recharge, avec retour arrière, si elle manque ;
  - le banc déclenche désormais le retour arrière (étape 10), au lieu de seulement l'annuler.
- **nginx** :
  - `return 444` aussi dans le serveur TLS par défaut : un SNI connu suivi d'un `Host` inconnu y aboutissait ;
  - `server_tokens off` ;
  - `X-Forwarded-Host` réécrit et `X-Real-IP` retiré ;
  - `/etat` du portail limité (zone `general`) ;
  - zone `payer` indexée sur (site, source) : un client derrière le NAT d'un hotspot, ou un voisin de CGNAT, ne vide plus que le budget de ce site, et plus celui de tous les sites vendus depuis cette IP. Reste de M7 : le voisin de NAT **sur le même site** ;
  - journal d'accès au format `wakatnet` : chemin masqué comme dans l'API (`/enroll/<jeton>`, `/webhooks/<fournisseur>/<secret>`, sans chaîne de requête). La décision se prend sur `$uri`, normalisé, et couvre donc un chemin encodé ;
  - les deux rendus du gabarit sont validés (`nginx -t`).
- **DHCP** : seules les réponses d'un serveur (`udp sport 67 dport 68`, IPv4) sont admises, et non plus tout paquet vers le port 68.
- **Unité de l'API** : `SystemCallFilter=@system-service`, avec `SystemCallErrorNumber=EPERM`, ainsi que `ProtectProc=invisible`, `ProcSubset=pid`, `ProtectClock`, `ProtectHostname` et `UMask=0077`. L'exposition passe de 3,1 à 1,5 (`systemd-analyze security --offline=true`). Les appels de Node 22 relevés par strace sont tous dans `@system-service`.
  - Un appel hors liste rend EPERM au lieu de tuer le processus. Node retombe alors sans erreur hors de io_uring et des clés de protection mémoire (essai avec EPERM injecté).
  - Non prouvé : sur un processeur doté de PKU, sous le systemd de Debian 13.
- **Rôle `noeud_wakatnet`** :
  - Node est réinstallé quand `node --version` diffère de `node_version` (le marqueur ne dépendait pas de la version) ;
  - le code arrive par deux archives des fichiers connus de Git : aucun fichier ignoré (`*.key`, `*.pem`, `clients.local.conf`, `node_modules`) n'est copié ;
  - un changement d'`infra/` seul ne redémarre plus l'API ;
  - les fichiers d'environnement doivent être en 0600, ou en 0640 avec le groupe `root`.
