# WAKATNET — Laboratoire de la phase 0

> Rédigé le 10/11/2026. Référence : `docs/SPEC.md` v1.4, §1, §5, §6.2, §7, §12 (porte G0) et §13 (règles 1, 2 et 11).
>
> **État en une phrase : aucun [LABO] de la spec n'est tranché.** Tous portent sur le comportement de RouterOS ou des téléphones. Or aucun CHR n'a pu tourner dans cette session (pas de KVM). Seuls des points côté serveur FreeRADIUS ont été prouvés, et uniquement sur **FreeRADIUS 3.2.5**, pas sur la version visée.
>
> Rappel de la règle 2 du §13 : comportement observé en labo > doc officielle de la version visée > journal des modifications > forums. Un blog ou un miroir tiers n'est qu'un **indice**.

---

## 1. Choix du labo (§13, règle 11)

### 1.1 Ce qui est retenu

| Rôle | Choix | Pourquoi |
|---|---|---|
| **Labo principal** | GNS3 sur le PC Windows de Yacouba : CHR 7.15 et CHR stable courante côte à côte, clients Alpine, une VM ou un nœud Docker Debian « RAD1 » pour FreeRADIUS, tcpdump, nginx et `tc netem` | Gratuit, déjà en place. Les deux versions tournent dans le même projet. On peut injecter de la latence. |
| **Complément obligatoire** | Un routeur MikroTik physique (hAP ou équivalent), à la même version que le CHR stable, avec de vrais téléphones | LABO-10 à LABO-13 portent sur les mini-navigateurs de portail captif et sur l'appli Wave. Un CHR seul ne peut pas les tester. |
| **Repli** | VPS Linux de test **avec `/dev/kvm`** | Pour LABO-09 si GNS3 tourne en émulation, et pour un vrai chemin Internet routeur → nœud. Impossible pour les essais avec téléphone. |
| **Labo serveur (déjà fait)** | FreeRADIUS + PostgreSQL natifs dans un conteneur Linux, routeurs simulés par des espaces de noms réseau (`infra/lab/freeradius/`) | Couvre ce qui ne dépend pas de RouterOS : clients dynamiques, rôle SQL, Message-Authenticator côté serveur, cache, base arrêtée. |

Points à vérifier sur le poste avant de commencer. **Aucun n'a été vérifié par l'agent.**
1. **Virtualisation imbriquée.** Docker Desktop et WSL2 activent Hyper-V. Dans ce cas, la VM GNS3 sous VMware ou VirtualBox peut perdre VT-x. Les CHR tourneraient alors en émulation, et les timeouts de LABO-09 seraient faussés.
   - Test dans la VM GNS3 : `ls -l /dev/kvm && grep -cE 'vmx|svm' /proc/cpuinfo`.
   - Si `/dev/kvm` est absent, deux solutions : la VM GNS3 au format Hyper-V avec `Set-VMProcessor -VMName "GNS3 VM" -ExposeVirtualizationExtensions $true` (VM arrêtée, PowerShell administrateur), ou Hyper-V désactivé pendant les sessions de labo.
   - Noter ici le choix fait.
2. **FreeRADIUS hors de WSL2.** WSL2 est derrière un NAT : les CHR ne le joignent pas directement, et le CoA (nœud → routeur) le traverse mal. Placer FreeRADIUS **dans** la topologie GNS3.
3. **Licence CHR.** La licence gratuite bride chaque interface, environ 1 Mbit/s d'après la politique connue. **Non vérifié** : mikrotik.com est injoignable. Si le bridage gêne, activer l'essai de 60 jours avec `/system license renew`.

### 1.2 Ce que cette session cloud a pu faire, et ce qu'elle n'a pas pu faire

| Fait | Détail |
|---|---|
| **Pas de KVM ni de QEMU** | Aucun CHR possible. Aucun comportement de RouterOS n'a été observé. |
| **Hôtes injoignables** (refus du proxy : 403 ou ENOTFOUND) | `manual.mikrotik.com`, `help.mikrotik.com`, `mikrotik.com`, `forum.mikrotik.com`, `download.mikrotik.com`, `www.bceao.int`, `www.rfc-editor.org`, `datatracker.ietf.org`, `www.freeradius.org`, `web.archive.org`, `api.github.com` (403) ; `launchpad.net` a répondu 503. |
| **Hôtes joignables** | `github.com` et `raw.githubusercontent.com` (source et ChangeLog FreeRADIUS, `git ls-remote`), `archive.ubuntu.com`, Docker Hub. |
| **Conséquence pour RouterOS** | Les constats RouterOS de la §5 viennent tous de **résumés de moteur de recherche** d'extraits de pages officielles, souvent sur l'URL non versionnée du manuel et non sur `/docs/7.25/`. Aucun n'est donc marqué « confirmé ». |
| **Compilation refusée** | Le classificateur de permissions a refusé la compilation de FreeRADIUS 3.2.8 depuis les sources. Le labo serveur a donc tourné sur le paquet Ubuntu 24.04 (3.2.5). La procédure pour le rejouer sur une autre version est dans `infra/lab/freeradius/README.md`. |
| **Fait dans la session** | Labo FreeRADIUS côté serveur (§3) ; pile `docker-compose` de développement (§6) ; protocoles CHR (§4) ; recherche documentaire contre-vérifiée par un second agent (§5). |

Pour lever le blocage documentaire, il faudrait ajouter aux hôtes autorisés de l'environnement : `manual.mikrotik.com`, `help.mikrotik.com`, `mikrotik.com`, `forum.mikrotik.com`, `download.mikrotik.com` et `www.rfc-editor.org`. Sinon, la vérification se fait sur le CHR, ce qui prime de toute façon (règle 2).

---

## 2. Tableau de synthèse

Légende :
- **TRANCHÉ** : une preuve observée existe, avec un fichier de preuve.
- **OUVERT** : pas encore de preuve observée.
- Les preuves CHR iront sous `docs/labo/`. Ce dossier n'existe pas encore.

### 2.1 Les [LABO] écrits dans la spec

| ID | Réf. spec | Objet | Statut | Preuve |
|---|---|---|---|---|
| S-01 | §1.1 `Mikrotik-Total-Limit` | Attribut 17 respecté dans un Access-Accept hotspot ? | **OUVERT** → LABO-04 | — |
| S-02 | §1.1 Accounting | Sens entrée / sortie (inversion upload / download) | **OUVERT** → LABO-03 | — |
| S-03 | §1.1 Utilisateurs locaux ; §6.3 | Base locale consultée avant RADIUS avec `use-radius=yes` ? | **OUVERT** → LABO-05 | — |
| S-04 | §1.1 `mac-cookie` | Reconnexion face à RADIUS : Access-Request envoyé ? Reject respecté ? | **OUVERT** → LABO-06 | — |
| S-05 | §1.3 Wave ; §7.2 étape 2 | Wave depuis un hotspot non authentifié (walled garden ou `trial`) | **OUVERT** → LABO-10 | — |
| S-06 | §6.2 exigence 6 | `/tool fetch` vérifie-t-il le certificat TLS ? | **OUVERT** → LABO-08 | — |
| S-07 | §7.1 | Causes de refus du §5.2 transmises par `Reply-Message` → `$(error)` | **OUVERT** → LABO-07 | — |
| S-08 | §7.2 étape 2 | Lien `tel:` du code Orange Money dans le mini-navigateur | **OUVERT** → LABO-11 | — |
| S-09 | §7.2 étape 5 | Auto-connexion : redirection GET ou POST depuis HTTPS | **OUVERT** → LABO-12 | — |
| S-10 | §7.2 « Piste » | Annonce du portail captif (RFC 7710 / 8910) et temps restant | **OUVERT** → LABO-13 | — |

**Bilan : 0 sur 10 tranché.** La porte G0 n'est pas franchissable sur ce point.

### 2.2 Points à prouver ajoutés par la phase 0

Ces points sont marqués « à valider sur CHR » dans la spec, ou bien la recherche (§5) les a fait passer en [LABO].

| ID | Réf. spec | Objet | Statut | Preuve |
|---|---|---|---|---|
| LABO-00 | §1.1 Message-Authenticator, Access-Request ; T10 | Contenu de l'Access-Request ; échec du login si le serveur ne renvoie pas Message-Authenticator ; valeur `no` ou `none` | **OUVERT** | — |
| LABO-01 | §1.1 `/radius incoming` ; §6.1 | Port par défaut (1700 ou 3799), source non déclarée, Message-Authenticator entrant | **OUVERT** | — |
| LABO-02 | §5.4 ; T9 ; §1.1 CoA | Disconnect et CoA de bout en bout ; attributs modifiables (Session-Timeout, Idle-Timeout, Port-Limit incertains) | **OUVERT** | — |
| LABO-09 | §6.2 (dernier paragraphe) ; §1.1 ordre des entrées | Valeur de `timeout`, bascule A → B, ordre des entrées `/radius` | **OUVERT** | — |
| LABO-14 | §1.1 Hotspot (walled garden) ; §7.1 | HTTPS par nom d'hôte : `walled-garden` (HTTP) ou `walled-garden ip` + `dst-host` | **OUVERT** | — |
| LABO-15 | §1.1 Hotspot | Code d'option DHCP réellement envoyé (160 ou 114) ; conditions (nom DNS, certificat) | **OUVERT** (couvert par LABO-13) | — |
| LABO-16 | T13 ; §10.2 | RouterOS bascule-t-il vers B sur un Reject, ou seulement sur un timeout ? | **OUVERT** (la partie serveur est prouvée : L6e) | — |
| LABO-17 | ADR 0004 point 4 ; §6.2 `timeout` | Latence et perte réelles depuis le Burkina (fibre, 4G, Starlink) vers les datacenters candidats | **OUVERT** : protocole et scripts prêts, testés en simulation (`infra/lab/latence/evidence/`) | `docs/PROTOCOLE_LATENCE.md` |

### 2.3 Points côté serveur FreeRADIUS (labo exécuté dans cette session)

Statut TRANCHÉ **uniquement pour FreeRADIUS 3.2.5** (paquet Ubuntu `3.2.5+dfsg-3~ubuntu24.04.3`), avec PostgreSQL 16.15. Ces résultats ne valent pas automatiquement pour 3.2.10.

| ID | Réf. spec | Objet | Statut | Preuve (`infra/lab/freeradius/evidence/`) |
|---|---|---|---|---|
| L1 | §1.2 ; §5.1 | Clients dynamiques par `radius.client_lookup` ; IP inconnue, routeur inactif ou hors overlay ignorés ; secret propre à chaque routeur | **TRANCHÉ (3.2.5)** | `radiusd-A-L1-L3-L5.log`, `L1-r1-known.log`, `L1-r2-known.log`, `L1-r9-unknown.log`, `L1-r3-inactive.log`, `L1-out-of-overlay.log`, `L1-r2-with-r1-secret.log` |
| L2 | §5.1 (rôle limité à EXECUTE) | Aucun accès direct aux tables | **TRANCHÉ (3.2.5 / PG 16.15)** | `L2-psql.log` |
| L3 | §1.2 BlastRADIUS ; §5.1 ; T10 (côté serveur) | `require_message_authenticator` pour les clients dynamiques | **TRANCHÉ (3.2.5)** : le bloc seul ne suffit pas, l'attribut `&FreeRADIUS-Client-Require-MA = yes` décide, et `auto` est sans effet. **OUVERT pour 3.2.6 et plus** (lecture du code seulement) | `L3-A-r1-noma-first.log`, `L3-A-r1-noma-cached.log`, `L3-A-r1-ma-cached.log`, `L3-{B,C,D,E}-*.log`, `radiusd-L3-{B,C,D,E}.log`, `00-summary.log` |
| L4 | §5.1 (`lifetime`, révocation) | Durée de vie du cache (20 s en labo) ; expiration paresseuse | **TRANCHÉ (3.2.5)** | `L4-0[1-8]-*.log`, `L4-psql-update.log`, `radiusd-A-L4.log` |
| L5 | §1.1 CHAP ; §5.2 | Authorize SQL jouet + CHAP avec mot de passe en clair renvoyé par une fonction | **TRANCHÉ (3.2.5)**, seulement pour la fonction jouet | `L5-chap-ok.log`, `L5-chap-badpw.log`, `L5-chap-unknown.log` |
| L6 | §4 / règle 2 (accounting découplé) ; T13 | Accounting vers `detail` quand la base est arrêtée ; comportement de l'authentification sans base | **TRANCHÉ (3.2.5)** | `L6-0[1-6]-*.log`, `L6-detail-files.log`, `radiusd-A-L6.log`, `radiusd-A-L6c-start-pg-down.log`, `radiusd-A-L6d-start0-pg-down.log`, `L6d-auth.log` |
| L6e | T13 | `do_not_respond` quand SQL échoue ; l'accounting reste répondu | **TRANCHÉ (3.2.5)** côté serveur | `L6e-0[1-4]-*.log`, `radiusd-A-L6e-do-not-respond.log` |
| L7 | §1.2 | Rejeu de L1 à L6 sur la version retenue (3.2.10) | **OUVERT** | — |
| L8 | §1.2 ; §5.1 | `rate_limit` des clients dynamiques : limite d'un nouveau client par seconde (inconditionnelle en 3.2.5, optionnelle d'après le code à partir de 3.2.6) | **OUVERT** | — |
| L9 | règle 2 (accounting) | Lecteur `detail` qui rejoue vers PostgreSQL (bogue #5870 en 3.2.9) | **OUVERT** (non testé) | — |

---

## 3. Résultats du labo FreeRADIUS exécuté dans cette session

### 3.1 Cadre

- **Rejeu :** `sudo infra/lab/freeradius/run-lab.sh`. Le script recrée tout depuis zéro, teste L1 à L6, et sort avec un code différent de 0 si un test échoue.
  - `sudo LAB_KEEP=1 infra/lab/freeradius/run-lab.sh` garde le réseau et la base à la fin, pour inspecter.
- **Dernier passage complet :** code de sortie 0, **36 PASS, 0 FAIL** (`evidence/00-summary.log`). Le réseau et le cluster de labo ont ensuite été démontés.
- **Versions** (en tête de `00-summary.log`) :
  - FreeRADIUS 3.2.5 (`3.2.5+dfsg-3~ubuntu24.04.3`) et radclient 3.2.5 ;
  - PostgreSQL 16.15 ;
  - Ubuntu 24.04.5.
- **3.2.8 non compilée :** compilation refusée par le classificateur de permissions. La procédure est dans `infra/lab/freeradius/README.md`.
- **Routeurs simulés :** radclient n'a pas d'option d'IP source. Chaque routeur est donc un espace de noms réseau, relié au pont `wkbr0` (10.213.0.1/16), et radclient tourne par `ip netns exec`.
- **Base :** cluster PostgreSQL dédié `16/wklab`, port 55432. Le cluster `16/main` n'a pas été touché.
- **Fichiers :** `infra/lab/freeradius/` contient `README.md`, `run-lab.sh`, `sql/`, `raddb/*.in`, `packets/`, `tools/radreq.py` et `evidence/`.

### 3.2 L1 — Clients dynamiques par `radius.client_lookup` : prouvé

- **Routeurs connus :** r1 (10.213.1.10) et r2 (10.213.1.20) sont acceptés avec leur propre secret.
  - `radiusd-A-L1-L3-L5.log` montre `Executing select query: SELECT secret FROM radius.client_lookup('10.213.1.10')`, puis `Adding client 10.213.1.10/32`.
  - Le paquet qui déclenche la recherche est traité tout de suite : `L1-r2-known.log` contient un seul `Sent`, suivi de `Received Access-Accept`.
- **Paquets ignorés :** une IP inconnue (10.213.9.99), un routeur inactif (10.213.1.30) et une IP hors overlay (10.99.0.5). Le log montre `Virtual-Server dynamic_clients returned fail, creating dynamic client failed`, puis `Ignoring request ... from unknown client`.
- **Mauvais secret :** r2 avec le secret de r1 donne `Dropping packet ... invalid Message-Authenticator! (Shared secret is incorrect.)`.
- **Pas de cache négatif.** Chaque paquet ou retransmission venant d'une IP inconnue relance la recherche SQL. C'est à considérer pour la charge et le déni de service (voir L8).

### 3.3 L2 — Rôle `wk_radius` limité à EXECUTE : prouvé

- `client_lookup` et `authorize` s'exécutent en tant que `wk_radius`.
- Les 6 accès directs testés sont refusés, au niveau du schéma :
  - `ERROR: permission denied for schema app` pour les SELECT sur `app.routers` et `app.tickets_lab`, et pour l'UPDATE ;
  - le même refus pour le schéma `ledger` ;
  - CREATE est refusé dans `radius` et dans `public`.
- Preuve : `L2-psql.log`.

### 3.4 L3 — Message-Authenticator pour les clients dynamiques

- **Outil d'envoi.** radclient 3.2.5 ajoute **toujours** un Message-Authenticator. D'après le ChangeLog, il ne sait le supprimer qu'à partir de 3.2.9. Les paquets « sans » ont donc été forgés avec `tools/radreq.py` (CHAP, bibliothèque standard Python).
- **Variante A** (bloc `yes` + attribut `&FreeRADIUS-Client-Require-MA = yes`) :
  - un paquet sans Message-Authenticator est ignoré, **y compris le tout premier** d'une IP pas encore en cache. Le client est créé, puis le paquet est rejeté : `Packet does not contain required Message-Authenticator attribute.` (`L3-A-r1-noma-first.log`, `L3-A-r1-noma-cached.log`) ;
  - avec Message-Authenticator, le paquet est accepté (`L3-A-r1-ma-cached.log`).

| Variante | Bloc `client` | Attribut | Paquet sans Message-Authenticator | Preuve |
|---|---|---|---|---|
| A | `yes` | `yes` | ignoré | `L3-A-*.log` |
| B | `yes` | non positionné | **accepté** (`BlastRADIUS check: Received packet without Message-Authenticator.`) | `radiusd-L3-B.log` |
| C | `auto` | non positionné | accepté, sans bascule même après un paquet qui en porte un | `radiusd-L3-C.log` |
| D | `auto` | `yes` | ignoré | `radiusd-L3-D.log` |
| E | `no` | `yes` | ignoré | `radiusd-L3-E.log` |

- **Portée.** Le résultat est observé sur 3.2.5, donc avant l'héritage ajouté en 3.2.6.
- **Ce que dit le code de 3.2.6 et plus.** Dans `client_afrom_request()` (`src/main/client.c`), l'héritage existe : `c->require_ma = request->client->require_ma;`. Mais il est écrasé plus loin, sans condition, par `c->require_ma = (fr_bool_auto_t) c->dynamic_require_ma;` :
  - ligne 1591 en 3.2.8 ;
  - ligne 1594 en 3.2.10 ;
  - ligne 1646 sur la tête de v3.2.x.
- Sans l'attribut, cette valeur vaut `no`. Les deux agents ont fait la même lecture. **C'est une lecture du code, non observée en labo** : point L7.
- **Configuration à retenir :** `require_message_authenticator = yes` dans le bloc **et** `&FreeRADIUS-Client-Require-MA = yes` dans le serveur `dynamic_clients`.

### 3.5 L4 — Durée de vie du cache (`lifetime` = 20 s en labo) : prouvé

- **À t0 :** on change le secret de r1 et on désactive r2 en base (`L4-psql-update.log`).
- **Avant l'expiration :**
  - l'ancien secret de r1 est encore accepté ;
  - le nouveau est ignoré (`Shared secret is incorrect`) ;
  - r2, désactivé, est encore servi : il reçoit un Reject de l'authorize jouet au lieu d'être ignoré.
- **Après t0 + 23 s :** l'ancien secret est ignoré, le nouveau est accepté, et r2 est ignoré (`unknown client 10.213.1.20`).
- **L'expiration est paresseuse.** Le premier paquet après `lifetime` relance la recherche (`Adding client 10.213.1.10/32`, `radiusd-A-L4.log`) et il est vérifié avec le nouveau secret.
- **Conséquences pour la conception :**
  - une rotation de secret coupe le routeur pendant au plus `lifetime` secondes ;
  - la révocation par la base n'agit qu'à l'expiration. Cela confirme le double mécanisme du §5.1 : pair WireGuard supprimé **et** routeur désactivé.

### 3.6 L5 — Authorize SQL jouet + CHAP : prouvé, pour un jouet

| Cas | Résultat | Preuve |
|---|---|---|
| Bon mot de passe | Access-Accept avec `Session-Timeout = 3600`, `Mikrotik-Rate-Limit = "512k/2M"` et un Message-Authenticator dans la réponse | `L5-chap-ok.log` |
| Mauvais mot de passe | Reject | `L5-chap-badpw.log` |
| Ticket inconnu | Reject avec `Reply-Message = "ticket_inconnu"` | `L5-chap-unknown.log` |

Limite : la fonction jouet est appelée deux fois par requête (check puis reply). La vraie `radius.authorize` devra éviter ce double appel ou le rendre bon marché.

### 3.7 L6 — Accounting `detail` et base arrêtée : prouvé

- **Accounting.** PostgreSQL arrêté, l'Accounting-Interim reçoit sa réponse en 0,04 s environ. Le Start et l'Interim sont écrits dans `detail-10.213.1.10-20261110` (`L6-detail-files.log`). La section accounting ne contient aucun SQL.
- **Authentification, client déjà en cache :** Access-Reject après le `reject_delay` de 1 s, sans Reply-Message. Lignes de `radiusd-A-L6.log` :
  - `rlm_sql (sql): Failed to reconnect (0), no free connections are available`
  - `Error getting check attributes`
  - `[sql] = fail`
  - `Sent Access-Reject`
- **Authentification, client pas encore en cache :** aucune réponse (`creating dynamic client failed`).
- **Retour de la base :** reconnexion automatique au plus tard après `retry_delay` (5 s en labo, 30 s par défaut dans la distribution).
- **Démarrage sans base :**
  - avec `pool { start = 1 }`, radiusd refuse de démarrer : `Instantiation failed for module "sql"` (`radiusd-A-L6c-start-pg-down.log`) ;
  - avec `start = 0`, il démarre (`radiusd-A-L6d-start0-pg-down.log`, `L6d-auth.log`).
- **Variante L6e.** Avec `sql { fail = 1 }` suivi de `if (fail) { do_not_respond }` :
  - le serveur ne répond pas (`Not sending reply to client.`) ;
  - l'accounting reste répondu (`L6e-0[1-4]-*.log`).
  - **Hypothèse à prouver sur CHR (LABO-16) :** RouterOS ne bascule sur la 2e entrée `/radius` qu'en cas de timeout. Un nœud dont la base est tombée et qui renvoie Reject bloquerait alors la bascule vers B (T13).

### 3.8 Autres constats

- **Secrets en clair dans les logs.** `radiusd -X` en 3.2.5 écrit en clair le mot de passe PostgreSQL et le secret de chaque client. Ici, ce ne sont que des valeurs de labo jetables.
  - Selon le ChangeLog, la 3.2.9 met `suppress_secrets = true` par défaut.
  - Le §6 en donne un indice pour 3.2.10 : le secret apparaît masqué dans `-X`, sous la forme `<<< secret >>>`.
  - **Règle :** ne jamais publier une sortie `-X` d'un nœud réel sans l'avoir relue.
- **Cas isolé en L6e.** Une fois, radclient s'est arrêté sans imprimer « No reply », alors que le serveur avait bien répondu « Not sending reply ». Le classificateur du script traite maintenant « Sent sans Received » comme une absence de réponse. Le cas ne s'est pas reproduit.
- **Non testé :**
  - le lecteur `detail` qui rejoue vers PostgreSQL (L9) ;
  - la limite d'un nouveau client par seconde (L8) ;
  - tout ce qui touche RouterOS.

---

## 4. Protocoles détaillés pour les items OUVERTS

> **Aucun de ces essais n'a été exécuté. Tous sont « OUVERT — à exécuter par Yacouba ».**
>
> Aucune syntaxe RouterOS n'a pu être vérifiée dans la doc 7.25, qui est injoignable. Les paramètres douteux portent la mention **(syntaxe à confirmer sur CHR)**. Ce qui fait foi : `export verbose` et la touche Tab sur le CHR.
>
> **Sources réellement lues pour ces protocoles :**
> - `share/dictionary.mikrotik` (branche v3.2.x) : vendeur 14988 ; Recv-Limit = 1, Xmit-Limit = 2, Rate-Limit = 8, Total-Limit = 17, Total-Limit-Gigawords = 18 ;
> - `man/man1/radclient.1` (v3.2.x) : l'option `-S` lit le secret depuis un fichier ;
> - la RFC 8910, connue par un extrait de recherche : rfc-editor.org n'a pas pu être lu directement.

### 4.1 Topologie de référence

```
                 [Cloud NAT GNS3]  (Internet du PC, pour /tool fetch, DNS, licence)
                        |
                     ether1 (DHCP client)
   [ALP1 Alpine] --- ether2  CHR715  ether3 --- [SW-LAB] --- ether0 [RAD1 Debian: FreeRADIUS 3.2.x, tcpdump, nginx]
   10.5.50.0/24      10.5.50.1      10.99.0.1                       10.99.0.10 (+10.99.0.11 = « nœud B »)
                                                   |
   [ALP2 Alpine] --- ether2  CHRSTB  ether3 -------+
   10.5.60.0/24      10.5.60.1      10.99.0.2
                                                   |
                                          [Port physique / AP]  → téléphone réel (LABO-10..13)
                                          ou MikroTik physique 10.99.0.3
```

- **Les deux CHR :** `CHR715` est un CHR 7.15. `CHRSTB` est la stable courante, probablement 7.25.1 (non confirmé, voir §5). Relever sa version avec `/system resource print`, et la noter dans chaque preuve.
- **Les deux nœuds :** `RAD1` porte 10.99.0.10 (nœud A) et 10.99.0.11 (nœud B). Il faut deux instances FreeRADIUS pour LABO-09 et LABO-16 ; une seule suffit pour les autres essais.
- **Nommage des preuves :** `docs/labo/LABO-NN_<version>_<objet>.<ext>`. Chaque fichier texte commence par la date et par la sortie de `/system resource print`.

### 4.2 Socle commun (une fois par CHR)

**Secrets : aucun secret réel.**
- Générer un secret de labo jetable sur RAD1 : `openssl rand -hex 16 > /etc/freeradius/labo.secret; chmod 600 /etc/freeradius/labo.secret`.
- Le taper à la main sur le CHR à la place de `SECRET_LABO`.
- Le masquer dans tous les `.txt` avant commit.
- N'utiliser que des tickets fictifs : les `.pcap` contiennent les User-Password chiffrés.

**RouterOS (CHR715).** Pour CHRSTB, remplacer `10.5.50.x` par `10.5.60.x`, et `10.99.0.1` par `10.99.0.2`.

```routeros
/system identity set name=CHR715-labo
/ip address
add address=10.5.50.1/24 interface=ether2 comment="wakatnet-labo"
add address=10.99.0.1/24 interface=ether3 comment="wakatnet-labo"
/ip dhcp-client add interface=ether1 comment="wakatnet-labo"
/ip pool add name=pool-hs-labo ranges=10.5.50.10-10.5.50.200 comment="wakatnet-labo"
/ip dhcp-server network add address=10.5.50.0/24 gateway=10.5.50.1 dns-server=10.5.50.1 comment="wakatnet-labo"
/ip dhcp-server add name=dhcp-hs-labo interface=ether2 address-pool=pool-hs-labo comment="wakatnet-labo"
/ip dns set allow-remote-requests=yes
/ip firewall nat add chain=srcnat out-interface=ether1 action=masquerade comment="wakatnet-labo"

/radius
add service=hotspot address=10.99.0.10 src-address=10.99.0.1 secret="SECRET_LABO" \
    timeout=1100ms require-message-auth=yes-for-request-resp comment="wakatnet-labo noeud A"

/ip hotspot profile
add name=hsprof-labo hotspot-address=10.5.50.1 dns-name=hotspot.labo \
    html-directory=hotspot login-by=http-chap,http-pap use-radius=yes \
    radius-accounting=yes radius-interim-update=1m
/ip hotspot
add name=hs-labo interface=ether2 address-pool=pool-hs-labo profile=hsprof-labo
# /ip hotspot et /ip hotspot profile acceptent-ils comment= ? (syntaxe à confirmer sur CHR) — sinon s'appuyer sur name=*-labo.

/system logging
add topics=radius,debug action=memory comment="wakatnet-labo"
add topics=hotspot,debug action=memory comment="wakatnet-labo"
```

**Relevés, réutilisés dans tous les essais :**

```routeros
/system resource print
/radius print detail where comment~"wakatnet-labo"
/radius monitor [find comment~"wakatnet-labo noeud A"] once
/ip hotspot active print detail
/ip hotspot host print detail
/ip hotspot cookie print detail
/log print where topics~"radius|hotspot"
/export verbose file=LABO-NN_export
```

**FreeRADIUS sur RAD1** (paquet Debian 3.2.x). Noter `freeradius -v` dans chaque preuve.

```bash
# /etc/freeradius/3.0/clients.conf  (ajout ; secret saisi à la main sur RAD1 uniquement)
client chr715 {
    ipaddr = 10.99.0.1
    secret = "SECRET_LABO"
    require_message_authenticator = yes
    limit_proxy_state = yes
    shortname = chr715
}
client chrstb {
    ipaddr = 10.99.0.2
    secret = "SECRET_LABO"
    require_message_authenticator = yes
    limit_proxy_state = yes
    shortname = chrstb
}

# Mode debug, sortie conservée comme preuve
systemctl stop freeradius
freeradius -X 2>&1 | tee /root/LABO-NN_<version>_radiusd-X.log

# Capture côté serveur
tcpdump -ni eth0 -s0 -w /root/LABO-NN_<version>.pcap 'udp port 1812 or udp port 1813 or udp port 1700 or udp port 3799'

# radclient : secret lu depuis un fichier (-S), jamais sur la ligne de commande (§13 règle 5)
install -m 600 /etc/freeradius/labo.secret /root/labo.secret
```

- Ces clients sont statiques. Ici, on teste le routeur, pas les clients dynamiques : ceux-ci sont couverts par le §3.
- Les utilisateurs de test sont déclarés dans `/etc/freeradius/3.0/mods-config/files/authorize`, avec le module `files`, sans SQL.

**Client Alpine (ALP1)** : `apk add curl tcpdump iperf3 bind-tools`.

```bash
udhcpc -i eth0
# login PAP (exige http-pap dans login-by) ; -c/-b conservent le cookie hotspot
curl -sS -c /tmp/cj -b /tmp/cj -o /tmp/login.out -w '%{http_code} %{time_total}\n' \
  -d 'username=T-XXXX&password=T-XXXX&dst=&popup=false' http://10.5.50.1/login
curl -sS -b /tmp/cj http://10.5.50.1/status | head -50
curl -sS -b /tmp/cj http://10.5.50.1/logout
```

### 4.3 LABO-00 — Access-Request et Message-Authenticator (7.15 et stable)

**Réf. :** §1.1, lignes « Message-Authenticator », « Access-Request » et « Méthode d'auth » ; T10 ; porte G0.

**Questions :**
1. L'Access-Request hotspot contient-il ces attributs ?
   - `Message-Authenticator`
   - `NAS-Identifier`, `NAS-IP-Address`
   - `Calling-Station-Id`, `Called-Station-Id`
   - `Framed-IP-Address`, `Mikrotik-Host-IP`
   - `WISPr-Location-ID` / `-Name`

   D'après les extraits, `NAS-IP-Address` et `WISPr-Location-Name` ne sont pas documentés.
2. Avec `yes-for-request-resp`, le login échoue-t-il si la réponse ne porte pas Message-Authenticator ?
3. Quelle est la valeur qui désactive l'exigence : `no` (doc) ou `none` (forum) ?
4. Quel est le format de la MAC (`radius-mac-format`) ?

**Commandes :**
- **Sur RAD1, dans `authorize` :**
  ```
  T-BASE  Cleartext-Password := "T-BASE"
          Reply-Message := "ok"
  ```
- **Cas A :** FreeRADIUS 3.2.x tel quel. D'après le code 3.2.5, il ajoute toujours Message-Authenticator aux réponses : à observer sur la capture.
- **Cas B :** un serveur qui ne renvoie **pas** Message-Authenticator. Deux possibilités :
  - un conteneur FreeRADIUS 3.0.x ;
  - ou `update reply { Message-Authenticator !* ANY }` en `post-auth`. Le serveur peut réajouter l'attribut à l'encodage : vérifier dans `-X` et dans le pcap.
- **Depuis ALP1 :**
  - login PAP avec curl ;
  - login CHAP avec un navigateur sans interface (`chromium --headless` ou Playwright), car c'est le JS de `login.html` qui calcule le hash.
- **Sur le CHR :**
  ```routeros
  /radius set [find comment~"wakatnet-labo noeud A"] require-message-auth=no
  ```
  puis retour à `yes-for-request-resp`. Relever les valeurs possibles avec Tab.

**Attendu :**
- **H1 (doc) :**
  - les attributs sont présents ;
  - Message-Authenticator figure dans l'Access-Request, pas dans l'Accounting-Request ;
  - cas B : login refusé avec `yes-for-request-resp`, accepté avec `no`.
- **H2 :** 7.15 et la stable diffèrent. Noter l'écart.
- **À relever dans tous les cas :** `User-Password` (PAP) ou `CHAP-Password` + `CHAP-Challenge` (CHAP), et le format de la MAC.

**Preuves :** `LABO-00_<ver>_radiusd-X.log`, `LABO-00_<ver>.pcap`, `LABO-00_<ver>_routeros.txt`.

**Résultat :** OUVERT.

### 4.4 LABO-01 — Port par défaut de `/radius incoming` et conditions d'acceptation

**Réf. :** §1.1 `/radius incoming` ; §6.1 ; §6.2.

**Questions :**
1. Quelle est la valeur par défaut de `port` sur 7.15 et sur la stable ? D'après les extraits, c'est 1700 sur la page RADIUS actuelle, et 3799 sur l'ancien wiki et chez des tiers.
2. Le routeur accepte-t-il un Disconnect venant d'une IP qui n'est pas une entrée `/radius` ?
3. Exige-t-il Message-Authenticator sur les requêtes entrantes ?
4. Sur quelle adresse écoute-t-il ?

**Commandes :**
- **Sur le CHR, état usine** (ne rien régler avant de lire) :
  ```routeros
  /radius incoming print
  /radius incoming export verbose
  /ip service print
  /radius incoming set accept=yes        # SANS fixer le port
  /radius incoming print
  /radius incoming monitor once          # (syntaxe à confirmer sur CHR)
  ```
- **Sur RAD1 :**
  ```bash
  for p in 1700 3799; do
    echo "User-Name = T-NONE, Message-Authenticator = 0x00" | \
      radclient -x -r 1 -t 3 -S /root/labo.secret 10.99.0.1:$p disconnect
  done
  # sans Message-Authenticator : radclient < 3.2.9 en ajoute toujours un (§3.4) ; utiliser radclient >= 3.2.9
  # ou infra/lab/freeradius/tools/radreq.py adapté au Disconnect-Request
  echo "User-Name = T-NONE" | radclient -x -r 1 -t 3 -S /root/labo.secret 10.99.0.1:1700 disconnect
  ```
- **Source non déclarée :** envoyer la même requête depuis 10.99.0.12. Utiliser un netns sur RAD1, comme dans `infra/lab/freeradius/run-lab.sh`.
- **Pour finir :** `/radius incoming set port=3799`, puis rejouer la série.

**Attendu :**
- **H1 :** port 1700. Un Disconnect-NAK (session inconnue) revient sur 1700, rien sur 3799.
- **H2 :** port 3799.
- **H3 :** la valeur diffère entre 7.15 et la stable.
- **IP non déclarée :** rejet silencieux attendu. Toute réponse est un risque, à remonter.

**Preuves :** `LABO-01_<ver>_incoming-print.txt`, `LABO-01_<ver>.pcap`, `LABO-01_<ver>_radclient.txt`.

**Résultat :** OUVERT.

### 4.5 LABO-02 — Disconnect et CoA de bout en bout (T9)

**Réf. :** §5.4 ; T9 ; §1.1 (attributs modifiables par CoA).

**Questions :**
- **(a)** Un Disconnect coupe-t-il la session et déclenche-t-il un Stop ? Avec quel `Acct-Terminate-Cause` ?
- **(b)** Quelle clé d'identification faut-il envoyer : `User-Name`, `Acct-Session-Id`, `Framed-IP-Address`, `Calling-Station-Id` ?
- **(c)** Un CoA sur `Mikrotik-Rate-Limit`, `Session-Timeout`, `Idle-Timeout` et `Port-Limit` s'applique-t-il sans couper la session ? Ces trois derniers sont incertains d'après la doc.
- **(d)** Un CoA qui change l'IP ou le pool est-il refusé ?
- **(e)** Le cookie MAC est-il supprimé après un Disconnect (doc) ?

**Commandes :**
- **Sur le CHR :**
  ```routeros
  /radius incoming set accept=yes port=3799
  /ip hotspot active print detail     # user, address, mac-address, id de session (nom du champ à confirmer)
  /queue simple print detail where dynamic
  ```
- **Sur RAD1 (`authorize`) :**
  ```
  T-COA  Cleartext-Password := "T-COA"
         Session-Timeout := 3600, Mikrotik-Rate-Limit := "1M/2M"
  ```
  ```bash
  cat > /root/dm1.txt <<'EOF'
  User-Name = "T-COA"
  Message-Authenticator = 0x00
  EOF
  radclient -x -r 1 -t 3 -S /root/labo.secret -f /root/dm1.txt 10.99.0.1:3799 disconnect
  # Variantes : + Acct-Session-Id (relevé dans l'Accounting-Start), + Framed-IP-Address,
  #             Acct-Session-Id seul, mauvais Acct-Session-Id avec bon User-Name
  cat > /root/coa1.txt <<'EOF'
  User-Name = "T-COA"
  Acct-Session-Id = "REMPLACER"
  Mikrotik-Rate-Limit = "256k/512k"
  Session-Timeout = 600
  Message-Authenticator = 0x00
  EOF
  radclient -x -r 1 -t 3 -S /root/labo.secret -f /root/coa1.txt 10.99.0.1:3799 coa
  # Puis un CoA par attribut : Idle-Timeout, Port-Limit, Mikrotik-Group
  # (d) : CoA avec Framed-IP-Address ou Framed-Pool différent → CoA-NAK attendu
  ```
- **Débit :** `iperf3 -c <serveur> -t 30 -R`, avant et après le CoA. Tenir compte du bridage de la licence CHR.
- **Variantes réseau :** jouer l'essai avec, puis sans, un pare-feu input restrictif sur ether3.

**Attendu :**
- **(a)** H1 : ACK, la session disparaît de `/ip hotspot active`, et un Stop part avec une cause à relever. H2 : ACK mais pas de Stop. `radius.acct_stop` devra alors être déclenché autrement.
- **(b)** Remplir un tableau combinaison × ACK/NAK × `Error-Cause`.
- **(c)** Remplir un tableau attribut × ACK/NAK × effet observé.
- **(d)** NAK.

**Preuves :** `LABO-02_<ver>.pcap`, `LABO-02_<ver>_radclient.txt`, `LABO-02_<ver>_active-avant-apres.txt`, `LABO-02_<ver>_iperf.txt`.

**Résultat :** OUVERT.

### 4.6 LABO-03 — Sens de l'accounting (S-02)

**Réf. :** §1.1 Accounting ; §5.3 (rx = upload client, tx = download client) ; T12.

**Questions :**
1. `Acct-Input-Octets` compte-t-il l'upload ou le download du client ?
2. Lequel de `Mikrotik-Recv-Limit` et `Mikrotik-Xmit-Limit` coupe sur le download ?
3. Dans quel ordre `Mikrotik-Rate-Limit` lit-il `rx/tx` ?
4. Les gigawords sont-ils présents ?

**Précaution :** pendant LABO-03 et LABO-04, aucune entrée de walled garden vers 10.99.0.10 ni aucun netem ne doit être actif. Vérifier avec `/ip hotspot walled-garden ip print` et `tc qdisc show`.

**Commandes :**
- **Sur RAD1 :**
  ```
  T-ACCT  Cleartext-Password := "T-ACCT"
          Acct-Interim-Interval := 60, Mikrotik-Rate-Limit := "512k/2M"
  ```
- **Sur le CHR :**
  ```routeros
  /ip hotspot profile set [find name=hsprof-labo] radius-interim-update=received
  ```
- **Sur ALP1**, dans cet ordre, en horodatant :
  ```bash
  date; curl -sS -o /dev/null -w 'down %{size_download}\n' http://10.99.0.10/f20M.bin
  sleep 70; date
  head -c 2000000 /dev/urandom > /tmp/up2M ; curl -sS -T /tmp/up2M http://10.99.0.10/upload/ -o /dev/null -w 'up %{size_upload}\n'
  iperf3 -c 10.99.0.10 -t 20        # upload client
  iperf3 -c 10.99.0.10 -t 20 -R     # download client
  ```
- **Sur le CHR, à chaque étape :** `/ip hotspot active print detail` (noms des champs à confirmer) et `/queue simple print stats where dynamic`.
- **Sur RAD1 :** `/var/log/freeradius/radacct/10.99.0.1/detail-*`.
- **Volet limites :**
  - `T-RECV` avec `Mikrotik-Recv-Limit := 5000000` ;
  - `T-XMIT` avec `Mikrotik-Xmit-Limit := 5000000` ;
  - download de 20 Mo avec chacun : noter s'il est coupé vers 5 Mo.

**Attendu :**
- **H1 (point de vue routeur) :** `Acct-Output-Octets` ≈ 20 Mo après le download ; `T-XMIT` coupe le download ; `512k/2M` = 512k en upload, 2M en download.
- **H2 :** au moins un de ces points est inversé.
- **H3 :** 7.15 et la stable diffèrent.
- **Débouché :** le résultat devient un test unitaire de `radius.acct_*`.

**Preuves :** `LABO-03_<ver>_detail.txt`, `LABO-03_<ver>.pcap`, `LABO-03_<ver>_active-steps.txt`, `LABO-03_<ver>_iperf.txt`, et un tableau sens × attribut.

**Résultat :** OUVERT.

### 4.7 LABO-04 — `Mikrotik-Total-Limit` (S-01)

**Réf. :** §1.1 ; §5.3 `data_limit` ; T12.

**Questions :**
1. L'attribut 17, envoyé seul, coupe-t-il la session quand upload + download atteint la limite ?
2. Comment interagit-il avec Recv-Limit et Xmit-Limit ?
3. Le compteur repart-il à zéro à chaque login ?
4. Quel `Acct-Terminate-Cause` accompagne la coupure ?

**Commandes :**
- **Sur RAD1 :**
  ```
  T-TOT   Cleartext-Password := "T-TOT"
          Mikrotik-Total-Limit := 8000000, Acct-Interim-Interval := 60
  T-TOT2  Cleartext-Password := "T-TOT2"
          Mikrotik-Total-Limit := 8000000, Mikrotik-Xmit-Limit := 20000000, Acct-Interim-Interval := 60
  ```
- **Sur ALP1 :** download de 20 Mo, puis reconnexion et nouveau download.
- **Sur le CHR :** `/ip hotspot active print detail` (un champ de limite totale est-il rempli ?) et `/log print where topics~"hotspot"`.

**Attendu :**
- **H1 :** coupure vers 8 Mo cumulés ; au relogin, le budget repart à zéro, donc le serveur doit envoyer le reste.
- **H2 :** attribut ignoré. Ne pas l'utiliser.
- **H3 :** 7.15 et la stable diffèrent. N'utiliser l'attribut que si les deux versions le respectent.

**Preuves :** `LABO-04_<ver>_radiusd-X.log`, `LABO-04_<ver>.pcap`, `LABO-04_<ver>_active.txt`, la sortie curl.

**Résultat :** OUVERT.

### 4.8 LABO-05 — Utilisateurs locaux consultés avant RADIUS ? (S-03)

**Réf. :** §1.1 ; §6.3 ; phase 2.

D'après les extraits, la doc ne décrit l'ordre « local, puis RADIUS » que pour `/user` et PPP, pas pour le HotSpot.

**Commandes :**
- **Sur le CHR :**
  ```routeros
  /ip hotspot user profile add name=up-labo-mikhmon shared-users=1 \
      on-login=":log info \"labo on-login \$user\"" comment="wakatnet-labo"
  # (on-login et son échappement : syntaxe à confirmer sur CHR)
  /ip hotspot user
  add name=L-LOCAL  password=L-LOCAL  profile=up-labo-mikhmon limit-uptime=10m comment="wakatnet-labo"
  add name=L-BOTH   password=pw-local profile=up-labo-mikhmon comment="wakatnet-labo"
  ```
- **Sur RAD1 :** `L-BOTH  Cleartext-Password := "pw-radius"` et `R-ONLY  Cleartext-Password := "R-ONLY"`.
- **Cas à jouer, avec tcpdump actif sur RAD1 :**

| Cas | Identifiants | État de RADIUS |
|---|---|---|
| 1 | L-LOCAL / L-LOCAL | actif |
| 2 | L-BOTH / pw-local | actif |
| 3 | L-BOTH / pw-radius | actif |
| 4 | R-ONLY / R-ONLY | actif |
| 5 | L-LOCAL / L-LOCAL | arrêté |
| 6 | R-ONLY / R-ONLY | arrêté (noter le message) |

- **Après chaque cas :** `/ip hotspot active print detail` (un champ indique-t-il une session RADIUS ?), et noter si de l'accounting arrive.
- **À vérifier aussi :** les limites locales (`limit-uptime`, scripts `on-login` de Mikhmon) s'appliquent-elles encore ?

**Attendu :**
- **H1 (hypothèse de la spec) :** cas 1, 2 et 5 réussis sans aucun paquet vers RAD1 ; cas 3 en échec ; cas 4 réussi.
- **H2 :** le cas 3 réussit (repli sur RADIUS). C'est un risque de double base.
- **H3 :** tout part en RADIUS. L'import devient obligatoire (§6.3).
- **Accounting des sessions locales :** à noter, à cause de l'impact sur la commission.

**Preuves :** `LABO-05_<ver>.pcap`, `LABO-05_<ver>_cas.txt`, `LABO-05_<ver>_log.txt`.

**Résultat :** OUVERT.

### 4.9 LABO-06 — `mac-cookie` avec RADIUS (S-04)

**Réf. :** §1.1 ; §5.4 ; §6.2.

**Ce que disent les extraits de la doc :**
- le routeur garde nom d'utilisateur et mot de passe par MAC ;
- `mac-cookie-timeout` vaut 3d par défaut ;
- le cookie est supprimé lors d'un logout, d'une limite atteinte, d'un Session-Timeout, d'un échec, d'une MAC partagée ou d'un Disconnect-Request.

Rien n'indique si un Access-Request repart vers RADIUS.

**Commandes :**
- **Sur le CHR :**
  ```routeros
  /ip hotspot profile set [find name=hsprof-labo] login-by=http-chap,http-pap,mac-cookie mac-cookie-timeout=1d   # (syntaxe à confirmer sur CHR)
  /ip hotspot user profile print
  /ip hotspot cookie print detail
  ```
- **Sur RAD1 :**
  ```
  T-MC  Cleartext-Password := "T-MC"
        Session-Timeout := 1800, Idle-Timeout := 120
  ```
- **Séquence :**
  1. login ;
  2. logout ;
  3. coupure de 5 min ;
  4. passer T-MC en `Auth-Type := Reject` avec `Reply-Message := "epuise"`, puis revenir ;
  5. reboot du CHR ;
  6. changement de MAC (`ip link set eth0 down; ip link set eth0 address 02:..; ip link set eth0 up`).
- **À chaque étape :** relever cookie, active et les paquets reçus sur RAD1.

**Attendu :**
- **H1 :** un Access-Request part au retour, le Reject est respecté, et le changement de MAC empêche la reconnexion.
- **H2 :** aucun Access-Request. Il faut alors interdire `mac-cookie` : un ticket épuisé continuerait de fonctionner, c'est une fuite de chiffre d'affaires.
- **H3 :** le logout supprime le cookie (doc).
- **Reboot :** noter si les cookies persistent.

**Preuves :** `LABO-06_<ver>.pcap`, `LABO-06_<ver>_cookie-steps.txt`, `LABO-06_<ver>_radiusd-X.log`.

**Résultat :** OUVERT.

### 4.10 LABO-07 — `Reply-Message` → `$(error)` → portail (S-07)

**Réf. :** §7.1 ; §5.2.

**Questions :**
1. `$(error)` reçoit-il le texte exact, un texte traduit par `errors.txt`, ou une valeur préfixée ?
2. `$(error-orig)` existe-t-il ?
3. Comment sont échappés les espaces, `&`, `=` et les accents ?
4. Que contient `$(error)` en cas de timeout, ou de Reject sans Reply-Message ?

**Commandes :**
- **Sur le CHR :**
  ```routeros
  /ip hotspot walled-garden ip add action=accept dst-address=10.99.0.10 protocol=tcp dst-port=80 comment="wakatnet-labo portail"
  /file print where name~"hotspot"
  ```
- **Remplacer `login.html` :** `scp admin@10.99.0.1:hotspot/login.html .` (chemin `hotspot/` ou `flash/hotspot/`, à confirmer), puis déposer la page de labo :
  ```html
  <html><body>
  <pre>error=[$(error)]
  error-orig=[$(error-orig)]
  mac=[$(mac)] ip=[$(ip)] link-login-only=[$(link-login-only)] link-orig=[$(link-orig)]</pre>
  <a href="http://10.99.0.10/portail?err=$(error-orig-esc)&mac=$(mac-esc)">go</a>
  </body></html>
  ```
  `$(error-orig)` et `$(…-esc)` viennent de la mémoire d'un agent et ne sont **pas vérifiés (syntaxe à confirmer sur CHR)**. Une variable non substituée apparaîtra telle quelle dans la page : c'est en soi une observation.
- **Sur RAD1, un ticket par cas,** plus les 7 codes du §5.2 :
  ```
  E-INCONNU  Auth-Type := Reject
             Reply-Message := "ticket_inconnu"
  E-EPUISE   Auth-Type := Reject
             Reply-Message := "epuise"
  E-SPECIAL  Auth-Type := Reject
             Reply-Message := "a b&c=d é"
  E-NOMSG    Auth-Type := Reject
  ```
- **Sur ALP1 :**
  ```bash
  for u in E-INCONNU E-EPUISE E-SPECIAL E-NOMSG; do
    curl -sS -d "username=$u&password=$u" http://10.5.50.1/login | grep -E 'error|href'
  done
  ```
- **Cas timeout :** arrêter FreeRADIUS, puis tenter un login.
- **Facultatif :** un Accept avec `Reply-Message := "bienvenue"`. Apparaît-il dans `status.html` ?

**Attendu :**
- **H1 :** texte exact.
- **H2 :** texte préfixé ou traduit. Le portail le parse, ou utilise `error-orig`.
- **H3 :** Reply-Message ignoré. Il faut remonter la cause autrement.
- **E-SPECIAL :** l'encodage observé fixe l'alphabet des codes. Rester sur `[a-z_]`.

**Preuves :** `LABO-07_<ver>_curl.txt`, `LABO-07_<ver>_radiusd-X.log`, `LABO-07_login-labo.html`.

**Résultat :** OUVERT.

### 4.11 LABO-08 — `/tool fetch` et vérification TLS (S-06)

**Réf. :** §6.2, exigence 6.

**Questions :**
1. `check-certificate=yes` refuse-t-il :
   - **(a)** un certificat auto-signé ?
   - **(b)** un nom qui ne correspond pas ?
   - **(c)** un certificat expiré ?
   - **(d)** une chaîne publique valide, quand aucune racine n'a été importée ?
2. Le CHR a-t-il un magasin de racines intégré ?
3. Un refus arrête-t-il l'`/import` enchaîné ?
4. Que fait `yes-without-crl` ?

**Topologie :** nginx sur RAD1 en HTTPS sur 8443 (auto-signé), 8444 (CN faux) et 8445 (expiré), avec des certificats générés par openssl. Pour la chaîne publique, `raw.githubusercontent.com`.

**Commandes :**

```routeros
/certificate print
/certificate settings print           # magasin intégré (syntaxe à confirmer sur CHR ; peut ne pas exister en 7.15)
/tool fetch url="https://raw.githubusercontent.com/FreeRADIUS/freeradius-server/v3.2.x/README.rst" \
    mode=https check-certificate=yes dst-path=labo-fetch-ok.txt
/tool fetch url="https://10.99.0.10:8443/test.rsc" mode=https check-certificate=yes dst-path=labo-selfsigned.rsc
/tool fetch url="https://10.99.0.10:8444/test.rsc" mode=https check-certificate=yes dst-path=labo-badcn.rsc
/tool fetch url="https://10.99.0.10:8445/test.rsc" mode=https check-certificate=yes dst-path=labo-expired.rsc
# Même série avec check-certificate=no puis yes-without-crl
/certificate import file-name=labo-ca.crt passphrase=""
/certificate print detail where name~"labo"
:do { /tool fetch url="https://10.99.0.10:8444/test.rsc" mode=https check-certificate=yes dst-path=labo-badcn.rsc; /import file-name=labo-badcn.rsc } on-error={ :log warning "wakatnet-labo fetch refuse" }
/file print where name~"labo-"
```

`test.rsc` contient seulement `:log info "wakatnet-labo import execute"`.

**Attendu :**
- **H1 :** (a), (b) et (c) sont refusés, sans fichier écrit. (d) n'est accepté que si le magasin de racines est actif ; sinon, l'empreinte affichée reste nécessaire.
- **H2 :** (b) est accepté. TLS seul ne suffit pas, et l'empreinte SHA-256 devient obligatoire. Il faut chercher un moyen de la calculer dans RouterOS (**à rechercher**).
- **H3 :** 7.15 et la stable diffèrent. Cela fixe la version minimale d'enrôlement.

**Preuves :** `LABO-08_<ver>_fetch.txt`, `LABO-08_<ver>_certificate.txt`, `LABO-08_nginx-certs.md` (génération des certificats, sans clé privée).

**Résultat :** OUVERT.

### 4.12 LABO-09 — `/radius timeout` sous latence et perte ; ordre des entrées

**Réf. :** §6.2 (dernier paragraphe) ; §1.1 (1100 ms par défaut, ordre des entrées : non vérifiable dans la doc) ; §0, exigence 1.

**Questions :**
1. Pour un timeout de 1100 ms, 2 s, 3 s et 5 s, et pour chaque profil réseau : taux de fausses bascules vers B, taux d'échecs, temps de login (p50 et p95).
2. Quand A est réellement mort, combien de temps avant que B réponde ?
3. Combien de retransmissions RouterOS envoie-t-il vers A avant de basculer ?
4. RouterOS mémorise-t-il que A est mort ?
5. L'ordre des entrées fait-il bien la priorité ?

**Commandes RouterOS :**
```routeros
/radius add service=hotspot address=10.99.0.11 src-address=10.99.0.2 secret="SECRET_LABO" \
    timeout=1100ms require-message-auth=yes-for-request-resp comment="wakatnet-labo noeud B"
/radius print where comment~"wakatnet-labo"            # A avant B
/radius set [find comment~"wakatnet-labo"] timeout=2s  # puis 3s, 5s
/radius reset-counters [find comment~"wakatnet-labo"]  # (syntaxe à confirmer sur CHR)
/radius monitor [find comment~"wakatnet-labo noeud A"] once
/radius monitor [find comment~"wakatnet-labo noeud B"] once
```

**Recette netem** (sur RAD1, uniquement le trafic de et vers 10.99.0.10, dans les deux sens via ifb) :
```bash
IF=eth0
modprobe ifb numifs=1 ; ip link set ifb0 up
# Sortie (réponses de A)
tc qdisc del dev $IF root 2>/dev/null
tc qdisc add dev $IF root handle 1: prio bands 3 priomap 2 2 2 2 2 2 2 2 2 2 2 2 2 2 2 2
tc qdisc add dev $IF parent 1:1 handle 10: netem delay 40ms 15ms distribution normal loss 1%
tc filter add dev $IF parent 1: protocol ip prio 1 u32 match ip src 10.99.0.10/32 flowid 1:1
# Entrée (requêtes vers A) redirigée vers ifb0
tc qdisc del dev $IF ingress 2>/dev/null
tc qdisc add dev $IF handle ffff: ingress
tc filter add dev $IF parent ffff: protocol ip u32 match ip dst 10.99.0.10/32 \
   action mirred egress redirect dev ifb0
tc qdisc del dev ifb0 root 2>/dev/null
tc qdisc add dev ifb0 root netem delay 40ms 15ms distribution normal loss 1%
# Changer de profil :
#   tc qdisc change dev $IF parent 1:1 handle 10: netem delay 80ms 40ms distribution normal loss 3%
#   tc qdisc change dev ifb0 root netem delay 80ms 40ms distribution normal loss 3%
# Panne de A : loss 100%
# Nettoyage : tc qdisc del dev $IF root; tc qdisc del dev $IF ingress; tc qdisc del dev ifb0 root
tc -s qdisc show dev $IF ; tc -s qdisc show dev ifb0
```

- **Contrôle :** `/tool ping 10.99.0.10 src-address=10.99.0.2 count=200`. Le RTT doit valoir environ 2 × le délai.
- **Alternative :** les filtres de lien GNS3. Ils ne filtrent pas par IP : noter si cette méthode est utilisée.

**Profils indicatifs.** Ce ne sont **pas** des mesures : les remplacer par des mesures terrain avant de conclure.

| Profil | Délai (par sens) | Gigue | Perte (par sens) | Remarque |
|---|---|---|---|---|
| P0 témoin | 0 | 0 | 0 | |
| P1 « Starlink » | 20–40 ms | 10–15 ms | 0,5–1 % | Micro-coupures : `loss 1% 25%`, ou `loss 100%` pendant 1 s toutes les 15 s |
| P2 « 4G » | 40–80 ms | 30–40 ms | 1–3 % | |
| P3 dégradé | 300 ms | 100 ms | 10 % | |
| P4 A mort | — | — | 100 % | |

**Calibrage terrain :** sur un vrai site, `/tool ping ADRESSE count=1000 interval=200ms` à plusieurs heures de la journée. Consigner dans `docs/labo/LABO-09_mesures-terrain.txt`.

> **Mesures terrain de latence et de perte, et réglage du `timeout` : voir `docs/PROTOCOLE_LATENCE.md`** (ADR 0004, point 4). Ce protocole remplace le calibrage sommaire ci-dessus : mesure UDP dans et hors tunnel pendant 48 à 72 h, rafales de pertes, pic du soir, formule de `timeout` proposée.

**Charge** (ALP2, 100 logins par combinaison timeout × profil) :
```bash
for i in $(seq 1 100); do
  curl -sS -o /dev/null -w "$i %{http_code} %{time_total}\n" -d 'username=T-TO&password=T-TO' http://10.5.60.1/login
  curl -sS -o /dev/null http://10.5.60.1/logout ; sleep 1
done | tee LABO-09_<timeout>_<profil>.txt
```
- Le succès se juge sur la page renvoyée ; adapter d'après LABO-07.
- Lancer un tcpdump séparé pour A et pour B :
  - une fausse bascule est une requête reçue par B alors que A était vivant ;
  - relever les retransmissions (même Identifier, même Authenticator).

**Attendu :**
- Un tableau timeout × profil : % de succès, % de fausses bascules, p50/p95, temps de bascule en P4.
- Hypothèse de travail : 1100 ms est trop court en P2/P3, et 5 s trop long en P4.

**Preuves :** `LABO-09_<ver>_<timeout>_<profil>.txt`, `..._A.pcap` et `..._B.pcap`, `LABO-09_<ver>_tc.txt`, `LABO-09_synthese.csv`.

**Résultat :** OUVERT.

### 4.13 LABO-10 — Wave depuis un hotspot non authentifié (S-05)

**Réf. :** §1.3 ; §7.2, étape 2 ; §11.

**Matériel réel obligatoire :**
- un MikroTik physique (ou un CHR ponté sur un AP) en version stable ;
- un Android d'entrée de gamme, et si possible un iPhone ;
- l'appli Wave et le compte de Yacouba.

**Commandes :**
```routeros
/ip hotspot host print detail where mac-address=MAC_TELEPHONE
/ip dns cache print where name~"wave"
/tool sniffer set filter-mac-address=MAC_TELEPHONE file-name=LABO-10-wave.pcap file-limit=20000KiB   # (syntaxe à confirmer sur CHR)
/tool sniffer start
#   ... manipulations sur le téléphone (2 min) ...
/tool sniffer stop
```

**Phase A** (sans paiement) :
- ouvrir l'appli, noter l'écran ou l'erreur ;
- extraire domaines et SNI :
  ```bash
  tshark -r LABO-10-wave.pcap -Y 'dns || tls.handshake.extensions_server_name' -T fields -e dns.qry.name -e tls.handshake.extensions_server_name | sort -u
  ```
- noter les protocoles utilisés : TCP 443, QUIC, autres.

**Phase B :** ajouter uniquement les noms observés, puis rejouer la phase A. Voir aussi LABO-14 : l'entrée HTTP `walled-garden` ne couvrirait pas HTTPS.
```routeros
/ip hotspot walled-garden add dst-host=NOM_OBSERVE action=allow comment="wakatnet-labo wave"
/ip hotspot walled-garden ip add dst-host=NOM_OBSERVE action=accept comment="wakatnet-labo wave"   # (dst-host ici : syntaxe à confirmer sur CHR)
```
Noter si la liste est stable, ou si elle varie (CDN, IP tournantes, épinglage de certificat).

**Phase C** (paiement réel) : **seulement sur décision explicite de Yacouba**, avec le montant minimal. La spec interdit tout franc réel via la plateforme avant G-ARGENT. Sans compte marchand, s'arrêter à la phase B.

**Phase D** (piste `trial`) :
```routeros
/ip hotspot profile set [find name=hsprof-labo] login-by=http-chap,http-pap,trial trial-uptime-limit=3m trial-user-profile=up-labo-trial   # (syntaxe à confirmer sur CHR)
```
- utiliser un profil avec un rate-limit très bas ;
- mesurer si 3 min suffisent pour payer ;
- refaire l'essai avec une nouvelle MAC aléatoire, pour mesurer l'abus possible.

**Attendu :**
- **H1 :** liste courte et stable. Un walled garden ciblé est envisageable.
- **H2 :** liste large, CDN ou QUIC. Pas de walled garden (§7.1). Wave est réservé aux clients qui ont de la data, ou passe par `trial`.
- **H3 :** `trial` fonctionne, mais se contourne par MAC aléatoire.
- **Android :** sur un Wi-Fi « non validé » et sans données mobiles, l'appli passe-t-elle bien par le Wi-Fi ?

**Preuves :** `LABO-10_<ver>_wave.pcap`, `LABO-10_domaines.txt`, `LABO-10_android_<phase>.png`, `LABO-10_ios_<phase>.png`.

**Résultat :** OUVERT.

### 4.14 LABO-11 — Lien `tel:` Orange Money dans le mini-navigateur (S-08)

**Réf. :** §7.2, étape 2.

**Questions :**
1. Le lien `<a href="tel:*144*4*6*100%23">` ouvre-t-il le composeur avec le code complet, `#` compris, dans chacun de ces contextes ?
   - **(a)** CaptivePortalLogin Android ;
   - **(b)** Chrome Android ;
   - **(c)** le CNA iOS ;
   - **(d)** Safari iOS.
2. Le bouton « Copier » (`navigator.clipboard.writeText`, qui exige HTTPS) fonctionne-t-il ?
3. Après la composition, le client retrouve-t-il le portail ?

**Commandes :**
- **Page `tel.html`** sur nginx (RAD1, moins de 5 Ko, de préférence en HTTPS valide ; noter HTTP ou HTTPS), avec quatre variantes :
  - `tel:*144*4*6*100%23` ;
  - `tel:*144*4*6*100#` ;
  - `tel:%2A144%2A4%2A6%2A100%23` ;
  - un bouton Copier avec un champ sélectionnable.
- **Sur le CHR :**
  ```routeros
  /ip hotspot walled-garden ip add action=accept dst-address=10.99.0.10 protocol=tcp dst-port=443 comment="wakatnet-labo portail"
  ```
- **Déroulé :**
  - rediriger `login.html` vers la page de test pour qu'elle s'ouvre **dans** le mini-navigateur ;
  - puis ouvrir la même URL dans le navigateur complet ;
  - **ne jamais envoyer l'USSD** : observer seulement le pré-remplissage.

**Attendu (indices, non vérifiés) :**
- Android pré-remplit le composeur.
- Certains mini-navigateurs bloquent les schémas qui ne sont pas HTTP.
- iOS est réputé refuser les `tel:` qui contiennent `*` ou `#`. C'est un souvenir d'agent, **non vérifié**.
- Résultat sous forme de matrice variante × contexte × appareil.

**Preuves :** `LABO-11_matrice.csv`, `LABO-11_<appareil>_<contexte>_<variante>.png`, `LABO-11_tel.html`.

**Résultat :** OUVERT.

### 4.15 LABO-12 — Auto-connexion après paiement : GET ou POST (S-09)

**Réf. :** §7.2, étape 5 ; phase 3.

**Variantes, depuis une page HTTPS :**

| Variante | Méthode |
|---|---|
| V1 | Redirection 302 vers `http://HOTSPOT/login?username=T&password=T&dst=…` |
| V2 | `<meta http-equiv="refresh">` vers la même URL |
| V3 | `location.href` en JavaScript |
| V4 | Formulaire POST auto-soumis vers HTTP |
| V5 | POST vers HTTPS avec `login-by=https` (facultatif) |

Questions annexes : le mini-navigateur se ferme-t-il après le succès ? Le paramètre `dst` est-il respecté ?

**Commandes :**
- **Sur le CHR :**
  ```routeros
  /ip hotspot profile set [find name=hsprof-labo] login-by=http-chap,http-pap
  # V5 : /ip hotspot profile set [find name=hsprof-labo] login-by=http-chap,http-pap,https ssl-certificate=NOM   (syntaxe à confirmer sur CHR)
  ```
- **Sur RAD1 :**
  - tickets T-AUTO1 à T-AUTO5 ;
  - nginx en HTTPS : `v1` (`return 302 http://10.5.60.1/login?username=T-AUTO1&password=T-AUTO1&dst=http%3A%2F%2Fexample.com%2F;`), puis `v2.html`, `v3.html` et `v4.html`.
- **Sur ALP1 :**
  ```bash
  chromium --headless=new --disable-gpu --dump-dom "https://10.99.0.10/v1" > LABO-12_v1.html 2>LABO-12_v1.err
  ```
- **Après chaque variante, sur le CHR :**
  ```routeros
  /ip hotspot active print where user~"T-AUTO"
  /ip hotspot active remove [find user~"T-AUTO"]
  ```
- **Sur les téléphones :** oublier puis reconnecter le SSID, pour forcer l'ouverture du mini-navigateur.
- **À noter dans l'ADR :** `http-pap` fait circuler le code du ticket en clair. C'est déjà le cas sur un Wi-Fi ouvert.

**Attendu :**
- **H1 :** V1 à V3 passent sans avertissement ; V4 déclenche l'avertissement de Chrome.
- **H2 :** le mini-navigateur bloque le passage de HTTPS à HTTP, ou perd le cookie.
- **H3 :** l'OS ferme le mini-navigateur dès la connexion. Il faut alors afficher le code **avant** la redirection.
- Résultat sous forme de matrice variante × navigateur × contexte.

**Preuves :** `LABO-12_matrice.csv`, `LABO-12_headless_v*.html` et `.png`, `LABO-12_<appareil>_<contexte>_v*.png`, `LABO-12_<ver>_active.txt`.

**Résultat :** OUVERT.

### 4.16 LABO-13 — Annonce du portail captif : RFC 8910 (option 114) et API RFC 8908 (S-10, LABO-15)

**Réf. :** §1.1, ligne Hotspot ; §7.2, « Piste ».

**Ce que disent les extraits de la doc :**
- l'annonce n'est envoyée que si le hotspot a un **nom DNS et un certificat valide** ;
- elle pointe vers `https://<dns-name>/api` ;
- le modèle `api.json` contient `captive`, `user-portal-url`, et en option `seconds-remaining`, `bytes-remaining` et `can-extend-session`.

Le code d'option réellement envoyé (160 ou 114) n'est pas documenté dans ce qui a été lu.

**Commandes :**
- **Sur le CHR :**
  ```routeros
  /ip hotspot profile export verbose
  /ip dhcp-server export verbose
  /ip dhcp-server option print
  # Si aucun réglage dédié n'existe (format de value : syntaxe à confirmer sur CHR) :
  /ip dhcp-server option add name=labo-capport code=114 value="'https://hotspot.labo/api.json'" comment="wakatnet-labo"
  /ip dhcp-server network set [find comment="wakatnet-labo"] dhcp-option=labo-capport
  ```
- **Sur ALP1 :**
  ```bash
  tcpdump -ni eth0 -vvv -s0 'udp port 67 or udp port 68' -w LABO-13_dhcp.pcap &
  udhcpc -i eth0 -O 114 -O 160 -v
  curl -sSv http://10.5.50.1/api.json ; curl -sSvk https://hotspot.labo/api.json   # URL réelle à relever dans l'offre DHCP
  ```
- **Comparaison :** jouer l'essai avec et sans certificat valide, sur la stable puis sur 7.15.

**Attendu :**
- **H1 :** l'option 114 est envoyée, le JSON est cohérent avec `Session-Timeout`, et Android affiche le temps restant.
- **H2 :** seule l'option 160 est envoyée, ou rien. La piste est abandonnée pour la v1.
- **H3 :** le JSON n'est servi qu'en HTTP, ou avec un certificat invalide. Les OS l'ignorent.

**Preuves :** `LABO-13_<ver>_dhcp.pcap`, `LABO-13_<ver>_api.json`, `LABO-13_<ver>_export.txt`, captures des téléphones.

**Résultat :** OUVERT.

### 4.17 LABO-14 — Walled garden HTTPS par nom d'hôte (nouveau, critique pour le portail)

**Réf. :** §1.1 Hotspot (« Walled garden HTTP/HTTPS par `dst-host` ») ; §7.1.

**Constat de départ.** Des indices (forum, miroirs non officiels de la doc) disent que `/ip hotspot walled-garden` (HTTP) ne reconnaît pas un nom d'hôte en HTTPS, puisque TLS est chiffré. Il faudrait passer par `walled-garden ip` avec `dst-host` (résolu par DNS en règles dynamiques), `protocol=tcp` et `dst-port=443`. La référence CLI officielle est injoignable.

**Commandes :**
```routeros
/ip hotspot walled-garden add dst-host=raw.githubusercontent.com action=allow comment="wakatnet-labo wg-http"
# depuis ALP1 non authentifié : curl -sSv https://raw.githubusercontent.com/ -o /dev/null  → bloqué ou non ?
/ip hotspot walled-garden remove [find comment="wakatnet-labo wg-http"]
/ip hotspot walled-garden ip add dst-host=raw.githubusercontent.com protocol=tcp dst-port=443 action=accept comment="wakatnet-labo wg-ip"   # (syntaxe à confirmer sur CHR)
/ip hotspot walled-garden ip print detail
/ip firewall filter print dynamic where comment~"hotspot"    # règles dynamiques créées ? (à confirmer)
# rejouer le curl ; puis tester un sous-domaine non listé et un SNI forgé :
# curl -sSv --resolve raw.githubusercontent.com:443:IP_NON_LISTEE https://raw.githubusercontent.com/
```

**Attendu :**
- **H1 :** HTTP `walled-garden` sans effet sur HTTPS, et `walled-garden ip` + `dst-host` efficace. Corriger le §1.1.
- **H2 :** les deux fonctionnent (inspection du SNI).
- **Dans tous les cas :** noter si l'autorisation suit l'IP résolue, ce qui ouvre aussi les autres sites hébergés sur la même IP de CDN.

**Preuves :** `LABO-14_<ver>_walled-garden.txt`, `LABO-14_<ver>_curl.txt`.

**Résultat :** OUVERT.

### 4.18 LABO-16 — Bascule A → B sur Reject ou sur timeout (T13)

**Réf. :** T13 ; §10.2 ; L6 et L6e (§3.7).

**Commandes :**
- Deux entrées `/radius` (A, puis B), comme dans LABO-09.
- Sur l'instance A : arrêter PostgreSQL, avec deux configurations successives :
  - **(1)** la configuration par défaut : Reject après `reject_delay` (preuve serveur : `radiusd-A-L6.log`) ;
  - **(2)** `if (fail) { do_not_respond }` (preuve serveur : `radiusd-A-L6e-do-not-respond.log`).
- Login depuis ALP2, avec tcpdump sur A et sur B.

**Attendu :**
- **H1 :** en (1), RouterOS garde le Reject de A et le client est refusé. En (2), il bascule vers B après `timeout`.
- Conséquence si H1 : `do_not_respond` sur échec SQL devient obligatoire dans la configuration de production.

**Preuves :** `LABO-16_<ver>_A.pcap`, `LABO-16_<ver>_B.pcap`, `LABO-16_<ver>_routeros.txt`.

**Résultat :** OUVERT.

### 4.19 L7 à L9 — Compléments côté serveur (possibles sans CHR)

- **L7 — Rejeu sur 3.2.10.** Rejouer `infra/lab/freeradius/run-lab.sh` sur FreeRADIUS 3.2.10 : compilé (procédure dans le README), ou à partir de l'image `freeradius/freeradius-server:3.2.10` déjà épinglée (§6).
  - **Attendu (lecture du code) :** variante B toujours **acceptée** en 3.2.10, malgré l'« héritage » annoncé en 3.2.6.
  - Le prouver : c'est ce qui tranche l'écart E-FR-2.
- **L8 — `rate_limit` des clients dynamiques.** Envoyer depuis 3 netns inconnus dans la même seconde, avec puis sans `rate_limit = yes` dans le bloc réseau.
  - **Attendu (code) :** en 3.2.5, un seul client créé par seconde ; en 3.2.10, tous créés, sauf avec `rate_limit = yes`.
- **L9 — Lecteur `detail`.** Mettre en place un serveur virtuel `listen { type = detail }` qui rejoue vers les fonctions `radius.acct_*`, après un arrêt de PostgreSQL.
  - Tester sur 3.2.10. **Ne jamais utiliser 3.2.9** : son lecteur `detail` ne lit plus les fichiers (#5870).

### 4.20 Ordre d'exécution conseillé et nettoyage

1. Socle (§4.2), puis LABO-00 et LABO-01.
2. LABO-03, 04, 05, 06, 07, puis LABO-02 et LABO-14.
3. LABO-08 (le CHR a besoin d'Internet).
4. LABO-09 et LABO-16, seulement si `/dev/kvm` est disponible.
5. LABO-10 à 13, sur matériel réel.
6. L7 à L9, à tout moment : ils ne dépendent pas du CHR.

Chaque essai se joue sur 7.15 **et** sur la stable. Tout écart entre les deux versions s'ajoute au §5.

```routeros
/ip hotspot walled-garden remove [find comment~"wakatnet-labo"]
/ip hotspot walled-garden ip remove [find comment~"wakatnet-labo"]
/ip hotspot user remove [find comment~"wakatnet-labo"]
/radius remove [find comment~"wakatnet-labo"]
/system logging remove [find comment~"wakatnet-labo"]
/file remove [find name~"labo-"]
```
```bash
tc qdisc del dev eth0 root; tc qdisc del dev eth0 ingress; tc qdisc del dev ifb0 root
shred -u /root/labo.secret
```

---

## 5. Écarts avec le §1 de la spec

### 5.1 Méthode et niveau de preuve

- **Deux passes.** Les faits ont d'abord été recherchés par un agent. Un second agent les a ensuite contre-vérifiés et a rouvert les sources. **Quand une citation n'a pas été retrouvée dans la source, c'est la contre-vérification qui l'emporte.**
- **RouterOS.** Aucune page officielle MikroTik n'a pu être lue directement. « partiel » veut dire « concordant d'après des extraits de recherche, à relire sur la page 7.25 ou à observer sur CHR ».
- **FreeRADIUS.** Les sources ont été lues directement : tags Git, fichiers `raw.githubusercontent.com` aux tags `release_3_2_5` à `release_3_2_10`, archive Ubuntu. S'y ajoute le labo 3.2.5.

Statuts : **contredit** (la source dit autre chose), **partiel** (en partie vrai, ou à compléter, ou appuyé seulement sur des extraits), **non vérifiable** (aucune source lisible).

### 5.2 FreeRADIUS (§1.2)

| ID | Affirmation du §1 | Ce que dit la source | Source | Statut | Impact sur la conception | Action proposée |
|---|---|---|---|---|---|---|
| E-FR-1 | « 3.2.8 vue comme dernière version » | Les tags `release_3_2_9` (01/06/2026) et `release_3_2_10` (03/06/2026, `urgency=high`) existent. 3.2.11 est en cours, sans tag. Docker Hub publie aussi 3.2.9 et 3.2.10. | `git ls-remote --tags` ; `doc/ChangeLog` (v3.2.x) ; `VERSION` = 3.2.11 ; Docker Hub | **contredit** | Choix de la version de production. La 3.2.9 casse le lecteur `detail` (#5870), qui est au cœur de l'accounting découplé. | Corriger le §1.2 : viser **3.2.10**, interdire 3.2.9, recontrôler le jour de l'installation. Rejouer le labo sur 3.2.10 (L7). |
| E-FR-2 | « Depuis la 3.2.6, les clients dynamiques héritent de ces réglages depuis leur bloc `client` … écrire `yes` explicitement » | Pour `require_message_authenticator`, l'héritage existe bien. Mais il est écrasé plus loin, sans condition, par `c->require_ma = (fr_bool_auto_t) c->dynamic_require_ma;` (client.c : ligne 1594 en 3.2.10, 1646 sur v3.2.x), et cette valeur vaut `no` sans `&FreeRADIUS-Client-Require-MA`. En 3.2.5, le labo observe que le bloc `yes` seul laisse passer un paquet sans Message-Authenticator. `limit_proxy_state` est bien hérité. | `src/main/client.c` (release_3_2_8, release_3_2_10, v3.2.x) ; `sites-available/dynamic-clients` ; labo L3 (`radiusd-L3-B.log`) | **contredit** pour `require_ma` (lecture du code ≥ 3.2.6, observé seulement en 3.2.5) ; confirmé pour `limit_proxy_state` | Sans correction, T10 échouerait : le routeur resterait exposé à BlastRADIUS alors que la configuration semble correcte. | §1.2 et §5.1 : ajouter `&FreeRADIUS-Client-Require-MA = yes` dans `dynamic_clients`, **en plus** du `yes` dans le bloc. Prouver sur 3.2.10 (L7). |
| E-FR-3 | « `auto` ne s'applique pas aux clients wildcard » | Confirmé par le ChangeLog 3.2.6 (« Configuration changes ») et par `radiusd.conf` 3.2.10 (« no effect for a client which uses a network IP/mask »). En 3.2.5, le labo montre aussi que `auto` reste sans effet, sans bascule même après un paquet signé (variante C). | ChangeLog v3.2.x ; `raddb/radiusd.conf.in` (release_3_2_10) ; `radiusd-L3-C.log` | **partiel** (exact, à compléter : la conclusion « écrire `yes` » ne suffit pas, voir E-FR-2) | Voir E-FR-2. | Fusionner avec la correction E-FR-2. |
| E-FR-4 | Mécanisme des clients dynamiques (§1.2) | Exact. Éléments que la spec ne mentionne pas : un masque est obligatoire (/32 refusé) ; un paquet sans définition est rejeté en silence ; aucun cache négatif (labo L1) ; expiration paresseuse (labo L4). **Correction de la contre-vérification :** la limite « 1 nouveau client par seconde, non configurable » du commentaire de l'exemple ne vaut que pour 3.2.5. À partir de 3.2.6, `listen.c` ne l'applique que si `rate_limit = yes` est posé sur le client réseau : option non documentée, désactivée par défaut d'après le code. | `sites-available/dynamic-clients` (3.2.10) ; `src/main/listen.c` et `client.c` (release_3_2_10) ; labo L1 et L4 | **partiel** | Temps de reprise après un redémarrage du nœud. Déni de service par des IP inconnues de l'overlay, qui relancent chacune une requête SQL. | Prouver avec L8. Décider de `rate_limit` dans un ADR. Pare-feu nftables : n'accepter le 1812 que depuis l'overlay. |
| E-FR-5 | Réglages BlastRADIUS « depuis la 3.2.5 » | Confirmé (ChangeLog 3.2.5 du 09/07/2024). Les défauts changent ensuite : `auto`/`auto` de 3.2.5 à 3.2.8, puis `require_message_authenticator = yes` à partir de 3.2.9 (constaté par diff de `radiusd.conf.in`, absent du ChangeLog). La phrase sur le défaut RouterOS (7.15+, `yes-for-request-resp`) n'a **aucune source MikroTik** dans la recherche FreeRADIUS. | ChangeLog ; `radiusd.conf.in` (release_3_2_5, 3_2_8, 3_2_9, 3_2_10) ; `src/lib/radius.c` (3.2.5) | **partiel** (FreeRADIUS confirmé ; défaut RouterOS à confirmer) | Le paquet Ubuntu 24.04 (3.2.5) tourne en `auto`/`auto` par défaut. | Toujours écrire les valeurs explicitement. Défaut RouterOS : LABO-00. |
| E-FR-6 | §16 : « FreeRADIUS 3.2.6, notes de version — newreleases.io » | newreleases.io est un agrégateur tiers, donc un simple indice (règle 2). | ChangeLog officiel au tag `release_3_2_6` | **contredit** (niveau de source) | Aucun sur le fond. | Remplacer la source du §16 par `https://raw.githubusercontent.com/FreeRADIUS/freeradius-server/release_3_2_6/doc/ChangeLog`. |

**Confirmés, en bref :**
- **Pas de v4 stable :** aucun tag `release_4_*`.
- **La table `nas` n'est lue qu'au démarrage** (`mods-available/sql` 3.2.10). En plus, d'après le code, les clients lus par `read_clients` ont `require_ma = false` jusqu'à 3.2.11 : **ne pas utiliser `read_clients`**.
- **Ubuntu 24.04 livre 3.2.5** (`noble-updates` : `3.2.5+dfsg-3~ubuntu24.04.3`). C'est avant le correctif 3.2.6.
- **Le serveur ajoute toujours Message-Authenticator** aux Access-Accept, Reject et Challenge : vu dans `radius.c` 3.2.5 et observé en L5.
- **Changements de 3.2.6 à 3.2.10 qui nous concernent :**
  - 3.2.9 : `suppress_secrets = true` par défaut et option `protocol_error` ;
  - 3.2.10 : correctif #5870 (lecteur `detail`).
- **Aucun changement SQL ou PostgreSQL** gênant trouvé entre 3.2.5 et 3.2.10.
- **Appel de fonctions SQL** (§5, hors §1) : prouvé en 3.2.5 par L1 et L5, avec `SELECT ... FROM radius.client_lookup(...)` dans un xlat `%{sql:...}`.

### 5.3 RouterOS (§1.1)

| ID | Affirmation du §1 | Ce que dit la source | Source | Statut | Impact sur la conception | Action proposée |
|---|---|---|---|---|---|---|
| E-ROS-0 | En-tête du §1.1 : « doc officielle `manual.mikrotik.com`, version 7.25 » | Aucune page officielle lisible depuis cette session. Tout repose sur des extraits de recherche, souvent sur l'URL non versionnée. | WebFetch : ENOTFOUND ; curl : 403 | **non vérifiable** | Tout le §1.1 reste au niveau « extrait », sous la doc officielle. | Ouvrir l'accès aux hôtes MikroTik, ou trancher sur CHR. |
| E-ROS-1 | Stable courante (§12 : « 7.15 et stable courante » ; doc 7.25) | 7.25.1 [stable] existerait. D'après les extraits, elle date du 02-03/11/2026, et non du 07/11 comme l'écrivait la première recherche. 7.26beta5 et la long-term 7.24.6 ne sont pas confirmées. | `forum.mikrotik.com/t/7-25-1-stable-is-released/274226` et `mikrotik.com/download/changelogs` (extraits) | **partiel** | Version du CHR stable du labo. | Relever la version à la création du CHR (`/system resource print`). |
| E-ROS-2 | `/radius incoming` : port par défaut 1700 « d'après la doc officielle (des docs tierces annoncent 3799) » | La page RADIUS actuelle donne 1700. La valeur 3799 vient de l'**ancien wiki officiel** (RouterOS plus ancien) et de tiers. `coa-port=3799` du User Manager est un autre réglage (le port vers lequel User Manager envoie). Après contre-vérification, la doc actuelle ne se contredit pas. | `manual.mikrotik.com/.../radius/` (extrait) ; `wiki.mikrotik.com/RADIUS_Client` (extrait) | **partiel** | Un mauvais port ferait perdre les CoA en silence sur tout le parc. | Corriger « docs tierces » en « ancien wiki officiel et tiers ». Garder `port=3799` fixé des deux côtés. LABO-01. |
| E-ROS-3 | Un CoA peut changer `Session-Timeout`, `Idle-Timeout`, `Port-Limit` (et d'autres) | `Mikrotik-Group`, Recv/Xmit-Limit et `Mikrotik-Rate-Limit` figurent dans toutes les versions de la liste. Session-Timeout, Idle-Timeout et Port-Limit ne figurent que dans certaines versions de la page. La spec omet `Mikrotik-Mark-Id`, `Filter-Id` et `Ascend-Data-Rate` / `Ascend-XMit-Rate`. | `help.mikrotik.com/docs/exportword?pageId=328097` et page RADIUS (extraits divergents) | **partiel** | Prolonger ou raccourcir une session par CoA (§5.4) n'est pas acquis. | LABO-02 (c). En attendant, prévoir le repli Disconnect + reconnexion. |
| E-ROS-4 | CoA : « pas l'adresse IP ni le pool » | Exact, et les **routes** sont aussi concernées. L'utilisateur doit d'abord être déconnecté. | page RADIUS (extrait) | **partiel** (à compléter) | Aucun. | Ajouter « ni les routes ». |
| E-ROS-5 | « Disconnect-Message pris en charge » | Exact, avec deux précisions : RouterOS ne prend pas en charge le POD ; un Disconnect-Request supprime le cookie MAC. | page RADIUS ; page HotSpot (extraits) | **partiel** (à compléter) | Après une suspension, le client doit ressaisir son ticket. C'est souhaitable. | Ajouter ces précisions ; à observer en LABO-02 (e). |
| E-ROS-6 | Message-Authenticator « depuis la 7.15 » ; `require-message-auth=yes-for-request-resp` par défaut | Le contenu du changelog 7.15 n'est connu que par le forum et des tiers. Le changelog 6.49.18 contiendrait les mêmes entrées (extrait). L'attribut est aussi exigé dans **Access-Challenge**. Valeurs : `no` et `yes-for-request-resp`. Le « none » du forum est très probablement une erreur. | forum (tiers) ; `download.mikrotik.com/routeros/6.49.18/CHANGELOG` (extrait) ; `help.mikrotik.com/.../RADIUS` (extrait) | **partiel** | Aucun pour la v1 (≥ 7.15). Le serveur renvoie toujours l'attribut. | Écrire « Access-Accept / Reject / Challenge » et la valeur `no`. LABO-00. |
| E-ROS-7 | Ordre des entrées `/radius` : « serveur 1, puis 2 » | Aucun extrait officiel sur la priorité ou la bascule. | — | **non vérifiable** | Haute disponibilité (§6.2, T13). La bascule sur Reject est inconnue (LABO-16). | LABO-09 et LABO-16. |
| E-ROS-8 | Client `/radius` : `timeout` 1100 ms, `protocol` `udp`/`radsec`, `src-address` | Concordant. La spec ne mentionne pas `radsec-timeout` (3300 ms) ni `src-address` = 0.0.0.0 par défaut. | page RADIUS (extrait) | **partiel** | `src-address` doit être forcé (déjà prévu au §6.2). | Aucune, sauf relecture 7.25. |
| E-ROS-9 | `WISPr-Session-Terminate-Time` dans les attributs Access-Accept | Présent dans le tableau numérique, mais peut-être absent de la liste Access-Accept actuelle (un seul extrait). | page RADIUS (extrait) | **partiel** | Fin de validité absolue (§5.3) : aujourd'hui calculée via `Session-Timeout`, donc faible impact. | Ne pas s'appuyer dessus avant un test (ajouter un cas à LABO-04). |
| E-ROS-10 | « CHAP impose au serveur de connaître le mot de passe en clair » | C'est une propriété du protocole CHAP (RFC 1994), pas une affirmation de MikroTik. L5 montre que ça fonctionne avec un mot de passe en clair renvoyé par SQL. | page RADIUS (extrait) ; labo L5 | **partiel** (formulation) | Les codes de ticket sont stockés en clair ou chiffrés de façon réversible (déjà implicite). | Attribuer la phrase au protocole, pas à la doc. |
| E-ROS-11 | Contenu de l'Access-Request | `NAS-Identifier`, `Calling-Station-Id` (MAC en majuscules, format réglé par `radius-mac-format`), `Called-Station-Id`, `Mikrotik-Host-IP`, `WISPr-Location-ID` et `Framed-IP-Address` sont concordants. **`NAS-IP-Address` et `WISPr-Location-Name` n'apparaissent pas** dans les extraits. | page RADIUS (extrait) | **partiel** | Contrat de `radius.authorize` (§5.2) et normalisation de la MAC. | LABO-00. Ne pas faire dépendre `authorize` de `NAS-IP-Address` (l'IP source suffit, §5.1). |
| E-ROS-12 | Hotspot : « Walled garden HTTP/HTTPS par `dst-host` » | **Contredit par des indices** (forum, miroirs non officiels) : le walled garden HTTP ne reconnaît pas un nom d'hôte en HTTPS. Il faut `walled-garden ip` avec `dst-host`, `dst-port=443` et `protocol=tcp`. La référence CLI officielle est injoignable. | `forum.mikrotik.com/t/https-urls-not-working-in-hotspot-walled-garden/86985` (indice) | **non vérifiable** (probable contradiction) | **Critique** pour les pages de paiement d'agrégateurs (§7.1) et pour Wave (LABO-10). Une autorisation par IP résolue ouvre aussi les autres sites sur la même IP de CDN. | LABO-14. Réécrire le §1.1 après le test. Garder la préférence pour une IP fixe dédiée au portail. |
| E-ROS-13 | Annonce du portail captif « RFC 7710 : `user-portal-url`, `seconds-remaining`, `can-extend-session`… » | La fonction existe, mais **la RFC 7710 est rendue obsolète par la RFC 8910** (option DHCPv4 114 au lieu de 160). Le JSON relève de la RFC 8908. Conditions : un nom DNS et un certificat valide. Le code envoyé par RouterOS est inconnu. La RFC n'est connue que par un extrait (rfc-editor injoignable). | `help.mikrotik.com/.../HotSpot+-+Captive+portal` (extrait) ; RFC 8910 (extrait) | **partiel** | La piste §7.2 exige un certificat valide sur le routeur. | Citer RFC 8910 et 8908 ; ajouter les conditions. LABO-13. |
| E-ROS-14 | `login-by` : liste des valeurs | Liste exacte. Défaut non mentionné : `http-chap,cookie`. `cookie` ne s'utilise qu'avec une autre méthode HTTP. | `cli-reference/ip/hotspot/...` (extrait) | **partiel** (à compléter) | Le profil d'enrôlement (§6.2) remplace `login-by`. Vérifier que l'existant n'est pas cassé. | Mentionner le défaut. |
| E-ROS-15 | Utilisateurs locaux avant RADIUS | La doc ne décrit l'ordre « local, puis RADIUS » que pour `/user` et PPP. Rien pour le HotSpot. `use-radius` vaut `no` par défaut. | pages `user` et `PPP AAA` (extraits) | **non vérifiable** | Migration Mikhmon (§6.3). | LABO-05. |
| E-ROS-16 | `mac-cookie` avec RADIUS | Mécanisme documenté (identifiants gardés par MAC ; `mac-cookie-timeout` 3d par défaut ; cas de suppression). Rien n'indique si un Access-Request repart. | page HotSpot (extrait) | **non vérifiable** | Risque de fuite de chiffre d'affaires (ticket épuisé encore actif). | LABO-06. |

**Concordants d'après les extraits, sans écart de fond :**
- **`/radius incoming` :** `accept=no` par défaut.
- **Attributs Access-Accept :** `Port-Limit` remplace `shared-users` ; `Mikrotik-Rate-Limit` est prioritaire (puis Ascend, puis WISPr) ; Recv/Xmit-Limit + Gigawords ; `Mikrotik-Group` = profil utilisateur ; `Acct-Interim-Interval` n'est respecté que si `radius-interim-update=received`.
- **`Mikrotik-Total-Limit` :** seulement dans le tableau vendeur (14988/17, Gigawords en 18). Le [LABO] est justifié.
- **Méthode d'auth :** CHAP par défaut, PAP possible, pas de MS-CHAP.
- **Accounting :** Start, Interim, Stop ; `Acct-Terminate-Cause` seulement au Stop. Le sens des compteurs reste [LABO].
- **Profil hotspot :** `radius-interim-update` vaut `received` par défaut ; `radius-accounting=yes`.
- **IPv4 :** hotspot fiable en IPv4 seulement, car il repose sur des règles NAT non prises en charge en IPv6.
- **RadSec :** TCP 2083, secret forcé à `radsec`. Une régression en 7.15+ est rapportée sur le forum (indice) : la décision « pas en v1 » reste cohérente.

Tous ces points restent à relire sur la page 7.25 ou à observer sur CHR : aucun n'est « confirmé » au sens de la règle 2.

### 5.x Concurrence (§1.5) — non vérifié

Aucune des affirmations du §1.5 (Mana Zone, Mon-Mikrotik, MonWifiZone, MaZoneWifi, Ticket WiFi Zone : positionnement et commissions) n'a été vérifiée dans cette session. Statut : **non vérifiable**. Action : Yacouba relit les cinq sites cités au §16 depuis son poste et note la date de lecture.

### 5.y Constat annexe du labo

FreeRADIUS ne compare pas `NAS-IP-Address` à l'IP source (même paquet accepté depuis r1 et r2, voir `infra/lab/freeradius/README.md`). Conséquence : l'identification du routeur repose exclusivement sur l'IP source dans le tunnel (§5.1).

### 5.z Test Message-Authenticator de la pile de dev

radclient ≥ 3.2.9 sait retirer l'attribut (`Message-Authenticator !* ANY` dans le fichier de paquet, d'après le ChangeLog 3.2.9) ; la pile de dev (3.2.10) ne l'a pas encore utilisé. Le test T10 reste prouvé par `tools/radreq.py` sur 3.2.5 uniquement.

---

## 6. Environnement de développement (`infra/docker-compose.yml`)

**Prouvé dans ce conteneur le 10/11/2026** (Docker 29.9.2, Compose v5.6.1). Preuve archivée : `infra/dev/evidence/compose-2026-11-10.log` (rejeu après correction de la critique, `.env` temporaire aléatoire supprimé ensuite) :

- **Démarrage.**
  - `postgres` et `redis` passent à « healthy ».
  - `freeradius` affiche `Ready to process requests`. Il écoute sur auth 1812 et acct 1813.
  - Tous les ports sont liés à `127.0.0.1`, ce que confirme `ss`.
- **Versions épinglées par tag + digest** dans `infra/docker-compose.yml` (`image: …@sha256:…`, digests relevés par `docker images --digests` après pull depuis Docker Hub) :
  - `freeradius/freeradius-server:3.2.10` : `radiusd -v` affiche « 3.2.10 (git #9071ea041) », base Ubuntu 26.04.1 ;
  - `postgres:16.15` : `select version()` donne 16.15 ;
  - `redis:7.4.12` : `INFO` le confirme.
- **Secrets.**
  - Ils sont lus par `env_file: ./dev/.env` avec `required: true` : sans `.env`, `config` échoue avec le code 1, comme voulu.
  - `infra/dev/.env.example` ne contient que des `CHANGE_ME`.
  - Le secret FreeRADIUS apparaît masqué dans `-X` (`<<< secret >>>`).
  - Le garde-fou de `infra/dev/tools/radclient.sh` refuse un secret absent ou resté à `CHANGE_ME` (code 2). Le script passe le secret par `-S <fichier temporaire>`, jamais en argument.
  - Redis exige un mot de passe (`NOAUTH` sans), qui n'apparaît dans aucune ligne de commande (`/proc/*/cmdline`). `redis-server` tourne avec l'UID 999.
- **Tests `radclient`.**

| Test | Résultat |
|---|---|
| Bon secret | Access-Reject (`No Auth-Type found`) : c'est attendu, aucun utilisateur n'est déclaré |
| Mauvais secret | Paquet abandonné (`invalid Message-Authenticator! (Shared secret is incorrect.)`) |
| Accounting-Start | Accounting-Response et fichier `detail` créé |
| Depuis l'hôte vers `127.0.0.1:1812` | Access-Reject reçu |

- **PostgreSQL :** schémas `app`, `radius` et `ledger` créés (`infra/dev/postgres/init/00-schemas.sql`), sans table.
- **Écart avec l'image.** Le site par défaut de l'image écoute aussi en IPv6 et ne démarre pas sur un hôte sans IPv6 (`Failed opening auth address :: port 1812 ... Address family not supported by protocol`). Un site IPv4 seul, `infra/dev/freeradius/site-default.conf`, le remplace. Il faudra décider s'il reste, car il recoupe la future configuration `infra/freeradius/`.
- **Nettoyage :** `down -v` exécuté ; le `.env` temporaire est supprimé.

**Non prouvé par la pile de dev :**
- **L'exigence de Message-Authenticator :** radclient 3.2.10 ajoute toujours l'attribut, donc le test n'était pas valable. Voir L7, avec `tools/radreq.py`.
- **Aucun Access-Accept :** la décision d'accès relève de la phase 1.
- **Le poste de Yacouba** (Windows, Docker Desktop / WSL2) : droits des fichiers montés, fins de ligne, IPv6.
- **Le chemin CHR → FreeRADIUS :** pas de CHR, et les ports sont liés à 127.0.0.1.
- **L'isolation des secrets en dev :** `env_file` donne tout `.env` à chaque conteneur, et `docker inspect` en montre les valeurs. C'est une limite de dev documentée dans `infra/README.md`.

Rappel (D7) : la pile docker-compose est réservée au développement et au labo. En production, FreeRADIUS, PostgreSQL et WireGuard sont natifs (systemd).

---

*Prochaine mise à jour de ce document : après l'exécution du socle (§4.2), de LABO-00 et de LABO-01 sur CHR, et après le rejeu L7 sur 3.2.10. Chaque ligne passée à TRANCHÉ doit citer son fichier sous `docs/labo/` ou `infra/lab/freeradius/evidence/`.*
