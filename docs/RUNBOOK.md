# RUNBOOK — exploitation des nœuds WAKATNET

- **Références** : `docs/SPEC.md` §10.2, §10.3 ; ADR 0004, 0009, 0015.
- **Règle** : chaque procédure se joue **à la main**, par l'exploitant (Yacouba), et chaque étape se vérifie avant de passer à la suivante. Aucune bascule n'est automatique.
- **État** : procédure de bascule **prouvée dans la pile de test** (`radius/tests/run.sh`, étapes T13 et promotion). Elle n'a **pas encore** été jouée sur les nœuds réels : à rejouer avant G-PILOTE (ADR 0004, point 3).

## 0. Repères

| | Nœud A | Nœud B |
|---|---|---|
| Rôle normal | primaire : écritures, API, portail, tâches, sauvegardes | réplique : authentification en secours |
| `wg0` (routeurs) | `10.213.0.1` | `10.213.0.2` |
| `wk-noeuds` (lien entre nœuds) | `10.213.255.1` | `10.213.255.2` |
| `WAKATNET_PG_ACCT_HOSTS` | `127.0.0.1,10.213.255.2` | `127.0.0.1,10.213.255.1` |
| Slot de réplication | `noeud_b`, sur A | `noeud_a`, sur B après un retour |

- Journal des opérations sur chaque nœud : `/var/log/wakatnet/noeud.log`, plus `journalctl -t wakatnet-promotion -t wakatnet-retour`.
- Objectifs (§10.2) : perte de données de 5 min au plus, reprise en 30 min.

## 1. Vérifier la santé de la réplication

Sur A :

```bash
sudo -u postgres psql -X -c "SELECT client_addr, state, sync_state, replay_lag FROM pg_stat_replication"
```

```bash
sudo -u postgres psql -X -c "SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retenu FROM pg_replication_slots"
```

Sur B :

```bash
sudo -u postgres psql -X -c "SELECT pg_is_in_recovery(), now() - pg_last_xact_replay_timestamp() AS retard"
```

- Attendu : `streaming` et `async` sur A ; `true` sur B, avec un retard de quelques secondes quand le trafic est normal.
- Retenu par le slot au-delà de 10 Go : B est coupé depuis longtemps. Au-delà de 20 Go, le slot est invalidé (`max_slot_wal_keep_size`), et B devra être reconstruit (§4).

## 2. Panne du PostgreSQL de A : mode dégradé (T13), sans rien faire

Ce qui se passe seul :
- A se tait (ADR 0009) ; les routeurs basculent vers B (LABO-16) ;
- B authentifie sur sa réplique les tickets déjà vendus. Un ticket neuf est accepté, mais son activation n'est écrite qu'au rejeu ;
- l'accounting reçu par B attend dans son spool ;
- `post_auth` ne journalise rien sur B.

**À décider** : si A revient vite (redémarrage, disque plein corrigé), on ne promeut pas B. Au retour de A, le spool de B se vide dans A tout seul (§2 de l'ADR 0015). Vérifier sur B :

```bash
ls -la /var/log/freeradius/radacct/wakatnet/
```

Le spool doit se vider en quelques minutes.

## 3. Promouvoir B (A perdu ou indisponible longtemps)

1. **Arrêter A** depuis la console de l'hébergeur : extinction de la machine, ou au minimum `systemctl stop postgresql freeradius` si A est joignable. Le constat « A ne répond pas » ne suffit pas : un lien coupé entre les nœuds ressemble à une panne de A.
   - **A injoignable** : demander à l'hébergeur de **couper son réseau** (ou de le laisser éteint) jusqu'à l'étape du §4. Sinon, un redémarrage de A par l'hébergeur le ferait revenir alors que B est primaire.
   - Garde automatique (revue de sécurité E1) : au démarrage, PostgreSQL de A demande à B s'il est primaire et **refuse de démarrer** si oui, ou si B répond sans que son état puisse être lu. La garde ne peut rien si le lien entre nœuds est coupé : d'où la coupure demandée ci-dessus.
2. Sur A, s'il est joignable, empêcher tout redémarrage en primaire :

   ```bash
   sudo systemctl disable --now postgresql
   ```

3. Sur B :

   ```bash
   sudo -u postgres /opt/wakatnet/infra/noeud/promouvoir-b.sh --raison "A perdu : incident hébergeur"
   ```

   Le script refuse si le PostgreSQL de A répond. Il demande de taper `PROMOUVOIR`, promeut, attend la fin de la récupération et lance la fumée.
4. Le spool de B se vide alors dans B (`target_session_attrs=read-write`) : le vérifier comme au §2.
5. Applications sur B : démarrer l'API, le portail et les tâches (unités systemd `wakatnet-*`, conteneurs de l'API).
6. DNS : faire pointer `api.` et le nom du portail vers l'IP de B. Le webhook de l'agrégateur vise le nom, pas l'IP.
7. Certificat TLS de B (ADR 0016, audit du 13/11/2026). Jusqu'ici, B sert un certificat **auto-signé** : les routeurs (`check-certificate=yes`), les navigateurs et l'agrégateur le refusent.
   1. Attendre que le DNS public donne l'IP de B, vérifié depuis l'extérieur des nœuds :

      ```bash
      dig +short api.DOMAINE @1.1.1.1
      ```

      Faire de même pour `portail.DOMAINE`.
   2. Dans l'inventaire, sur `noeud_b` : `frontal_tls: letsencrypt` et `wakatnet_role: primaire`. Sur `noeud_a` : `frontal_tls: autosigne` et `wakatnet_role: replique`.
   3. Repasser Ansible sur B seul : certbot obtient le certificat, puis nginx est rechargé.

      ```bash
      ansible-playbook site.yml --limit noeud_b
      ```

   4. Si B garde un certificat d'une bascule précédente, Ansible ne le redemande pas, et il peut avoir expiré. Le renouveler à la main ; le crochet recharge nginx.

      ```bash
      sudo certbot renew --cert-name wakatnet
      ```

   5. Vérifier depuis l'extérieur l'émetteur et la date d'expiration :

      ```bash
      echo | openssl s_client -connect api.DOMAINE:443 -servername api.DOMAINE 2>/dev/null | openssl x509 -noout -issuer -enddate
      ```

   - Tant que le DNS vise B, les renouvellements de certbot échouent sur A : c'est attendu. Au retour sur A (§4, étape 5), même procédure en sens inverse, y compris le renouvellement manuel : le certificat de A a pu expirer.
8. Vérifier un achat de bout en bout avec un petit montant, puis noter l'heure de chaque étape au journal.

## 4. Faire revenir A, en réplique de B

1. Sur A, PostgreSQL arrêté et unité désactivée (étape 2 ci-dessus).
2. Sur A :

   ```bash
   sudo -u postgres env PGDATA=/var/lib/postgresql/16/main /opt/wakatnet/infra/noeud/rejoindre-en-replique.sh
   ```

   - Le script refuse si PostgreSQL tourne localement, ou si B n'est pas primaire.
   - Il crée le slot `noeud_a` sur B, puis lance `pg_rewind`.
   - Si `pg_rewind` échoue, l'ancien répertoire est **mis de côté** (`main.avant-DATE`) et A est reconstruit par `pg_basebackup`. Effacer ce répertoire à la main, une fois A vérifié.
3. Réactiver et démarrer :

   ```bash
   sudo systemctl enable --now postgresql
   ```

4. Vérifier le §1, avec les rôles inversés. Le spool de A se vide dans B.
5. **Revenir à A primaire** (facultatif, en heure creuse) : même procédure en sens inverse (promouvoir A, B rejoint en réplique). Sinon, échanger les rôles dans l'inventaire Ansible et dans ce document.

## 5. Mise à jour d'un nœud, sans interruption de l'authentification (§10.3)

1. **B d'abord** : `ansible-playbook -i inventaire site.yml --limit noeud_b` (§7 de l'ADR 0015). Vérifier le §1 et une authentification sur B.
2. Puis **A**, en heure creuse. Pendant le redémarrage de FreeRADIUS ou de PostgreSQL sur A, les routeurs basculent sur B (mode dégradé, quelques secondes).
3. Une mise à jour **majeure** de PostgreSQL ne se fait pas ainsi : elle exige un ADR (réplication entre versions impossible).

## 6. Hygiène du compte de l'hébergeur (ADR 0004)

- Double authentification activée, moyen de paiement de secours, contact de facturation à jour.
- Accès à la console de chaque nœud vérifié chaque trimestre : c'est elle qui permet l'étape 1 du §3.

## 7. Sauvegardes et restauration

- Sauvegarde : `wakatnet-sauvegarde.timer`, chaque nuit à 2 h 30, sur le primaire (le script ne fait rien sur une réplique). Complète le dimanche, différentielle sinon. État : `/var/lib/wakatnet/sauvegarde.json`. Alerte au-delà de 26 h sans réussite.
- Contrôle externe du bucket (ADR 0018, audit du 13/11/2026) : `infra/surveillance/controle-b2.sh`, chaque heure, **hors des nœuds**, avec une clé de liste seule. Il alerte sur son propre bot Telegram si la dernière sauvegarde dans le bucket a plus de 26 h, le dernier WAL plus d'une heure, ou si `backup.info`/`archive.info` ont été masqués. Une alerte du contrôle externe **sans** alerte des nœuds est le signe d'un nœud qui ment : la traiter comme le cas « effacement du dépôt » ci-dessous.
- Essai de restauration : `wakatnet-essai-restauration.timer`, le 3 de chaque mois. La base restaurée tourne sous l'utilisateur sans droits `wakatnet-essai` (scan de sécurité F4). Elle tourne sans réseau, et la base vivante comme les secrets y sont masqués (espaces de noms). L'essai refuse de tourner dans quatre cas :
  - le pg_hba vivant accepte cet utilisateur ;
  - il lit `/etc/pgbackrest` ou `/etc/wakatnet` ;
  - les espaces de noms ne marchent pas ;
  - la place disque ne suffit pas pour la sauvegarde plus 20 %, en gardant 10 % du disque ou 2 Gio.

  Dans ce dernier cas, libérer de la place, ou donner un disque dédié à `/var/lib/wakatnet-essai`.
- Anti-devinette : un routeur peut être **restreint** (alerte, ou plus de 30 échecs de forme faible en une heure). Ses tickets importés de Mikhmon sont alors refusés jusqu'à une heure. Les codes de la plateforme restent servis. Une plainte « mon ticket Mikhmon ne marche plus » sur un seul routeur est donc probablement une attaque en cours : lire `radius.auth_log` de ce routeur. Remède durable : réémettre ces tickets. Résultat : `/var/lib/wakatnet/essai-restauration.json`. En cas d'échec, lire `journalctl -u wakatnet-essai-restauration` : un **écart du grand livre** (`ecriture:ID`) signale une ligne disparue ou modifiée depuis la sauvegarde. Le traiter comme un incident de sécurité, pas comme une panne.
- Phrase de passe du dépôt : dans `/etc/pgbackrest/conf.d/secret.conf` **et** hors des nœuds. Sans elle, aucune restauration n'est possible. La copie hors site ne garde **que la phrase de passe** : les clés B2 se recréent dans la console, et une clé hors site serait une clé de plus à voler.
- `secret.conf` appartient à root, groupe postgres, `0640` ; `/etc/pgbackrest` et `conf.d` à `root:postgres`, `0750`. pgBackRest, lancé en postgres, ne fait que les lire. Ansible échoue si `conf.d` contient autre chose que `secret.conf` : un fichier inconnu y est un **incident de sécurité** (redirection possible du dépôt), pas une erreur de déploiement. Pour (re)créer le fichier, sans secret sur la ligne de commande :

  ```bash
  sudo install -d -o root -g postgres -m 0750 /etc/pgbackrest /etc/pgbackrest/conf.d
  sudo install -o root -g postgres -m 0640 /dev/null /etc/pgbackrest/conf.d/secret.conf
  sudoedit /etc/pgbackrest/conf.d/secret.conf
  ```

  Contenu : `[global]`, puis `repo1-cipher-pass=`, `repo1-s3-key=` (keyID B2) et `repo1-s3-key-secret=` (applicationKey). `sudoedit` garde le propriétaire et le mode. Vérifier : `sudo stat -c '%U:%G %a' /etc/pgbackrest/conf.d/secret.conf` donne `root:postgres 640`.

### Rotation (clé B2 des nœuds, clé de contrôle, phrase de passe)

1. Créer la nouvelle clé dans la console B2 ou par `b2 key create` (capacités : `docs/MISE_EN_PRODUCTION.md` §1), la poser sur **les deux** nœuds par `sudoedit` (ci-dessus), puis `sudo -u postgres pgbackrest --stanza=wakatnet check` sur le primaire.
2. Révoquer l'ancienne (`b2 key delete KEYID`), puis contrôler par `b2 key list --long`.
3. **Mettre à jour la copie hors site** : la phrase de passe si elle change, et la date de la rotation avec l'identifiant (keyID, non secret) de la clé en service. Jamais la clé elle-même.
4. La phrase de passe d'un dépôt existant ne se change pas en place : une nouvelle phrase veut dire un nouveau dépôt (`repo1-path` neuf, à reporter dans `CONTROLE_B2_CHEMIN`), suivi d'une sauvegarde complète. L'ancienne phrase reste dans la copie hors site tant que des sauvegardes chiffrées avec elle sont gardées (30 jours de verrou au moins).

### Restaurer la base après une perte des deux nœuds

1. Nouveau nœud installé par Ansible (§5), PostgreSQL arrêté, répertoire de données vide.
2. Remettre `/etc/pgbackrest/conf.d/secret.conf` comme ci-dessus : phrase de passe tirée de la copie hors site ; clé B2 **neuve**, créée dans la console (lecture seule `listBuckets,listFiles,readFiles` le temps de la restauration, puis la clé d'écriture des nœuds avant `stanza-create` ou la première sauvegarde).
3. Restaurer jusqu'à la fin des WAL archivés (perte bornée par `archive_timeout`, 60 s) :

   ```bash
   sudo -u postgres pgbackrest --stanza=wakatnet --type=default restore
   ```

4. Démarrer PostgreSQL, puis passer la fumée, puis le §1.
5. Rejouer les spools des nœuds perdus s'ils sont récupérables (`/var/log/freeradius/radacct/wakatnet/`), puis reconstruire B (§4).

### Restaurer après l'effacement du dépôt (nœud compromis, ADR 0018)

Le bucket B2 est verrouillé en mode conformité pendant 30 jours : un effacement ne fait que **masquer** les objets, et leurs versions restent lisibles. Symptômes : alerte du contrôle externe (`backup.info` masqué, sauvegarde ou WAL trop vieux), alerte `sauvegarde` des nœuds (la stanza n'existe plus), ou `pgbackrest info` vide.

1. **Contenir d'abord** :
   - révoquer la clé d'application B2 des nœuds (console B2) ;
   - traiter le nœud compromis (RUNBOOK §3 : couper son réseau) ;
   - créer une **clé de restauration en lecture seule**, limitée au bucket, depuis le poste de Yacouba (la clé maîtresse **ne va jamais sur un nœud**, même pour une restauration) :

     ```bash
     b2 key create --bucket NOM_DU_BUCKET wakatnet-restauration listBuckets,listFiles,readFiles
     ```

   - la poser sur le **nœud sain** dans `secret.conf` (`repo1-s3-key`, `repo1-s3-key-secret`), par `sudoedit`, comme plus haut. Avec elle, `info` et `restore` lisent le dépôt ; rien ne peut y être écrit ni masqué.
2. Retrouver l'heure de l'effacement : console B2, versions de `wakatnet/backup/wakatnet/backup.info` (heure du masquage). Choisir une heure **juste avant**, en UTC.
3. Vérifier ce que le dépôt contenait à cette heure :

   ```bash
   sudo -u postgres pgbackrest --stanza=wakatnet --repo=1 --repo-target-time="2026-11-20 03:00:00+00" info
   ```

4. Sur un nœud sain, PostgreSQL arrêté, répertoire de données vide, restaurer jusqu'à la fin des WAL de cette heure :

   ```bash
   sudo -u postgres pgbackrest --stanza=wakatnet --repo=1 --repo-target-time="2026-11-20 03:00:00+00" restore
   ```

5. Démarrer PostgreSQL, fumée, §1. Puis seulement, créer la **nouvelle clé d'écriture** des nœuds (capacités de `docs/MISE_EN_PRODUCTION.md` §1), la poser à la place de la clé de restauration dans `secret.conf`, **révoquer la clé de restauration**, contrôler par `b2 key list --long`, recréer la stanza (`stanza-create`) et lancer une sauvegarde complète. Mettre à jour la copie hors site (« Rotation », point 3). D'ici là, la clé de lecture seule refuse `archive-push` : les WAL attendent dans `pg_wal`, donc ne pas laisser traîner cette étape.
6. Le contrôle externe continue de signaler les marques d'effacement de l'incident : une fois la nouvelle sauvegarde vue par lui, régler `CONTROLE_B2_IGNORER_AVANT` à l'heure de la fin de l'incident (UTC) sur la machine de contrôle.

Prouvé au banc `infra/noeud/essais/sauvegarde-s3.sh` (S3 de test, verrou de conformité) ; à rejouer une fois sur B2 à la mise en service (`docs/MISE_EN_PRODUCTION.md`).

**Mesuré** le 12/11/2026 sur le banc d'essai (`infra/noeud/essais/sauvegarde.sh`, base de 349 Mo : 100 000 tickets, 1,35 million de lignes d'`auth_log`) :
- sauvegarde complète en 7,1 s ;
- restauration jusqu'au point cohérent de la sauvegarde, instance ouverte, en 3,9 s.

C'est un conteneur local avec un dépôt sur disque. Sur le nœud, le transfert depuis le stockage S3 dominera : à remesurer au premier essai mensuel.
