# ADR 0015 — Contrats de la phase 5 : second nœud, réplication, bascule, sauvegardes, supervision

- **Statut** : **accepté le 12/11/2026, par délégation de Yacouba** (« continue avec la phase 5 »). Restent **[À CONFIRMER]** : le stockage hors site des sauvegardes (§5) et le canal e-mail des alertes (§6).
- **Références** : `docs/SPEC.md` §4 (règles 1, 2 et 5), §5.6 (T13), §10.2, §10.3, §12 (phase 5, G-PILOTE) ; ADR 0004, 0006 §12, 0009, 0010, 0013 (M7) ; `docs/LABO.md` LABO-09, LABO-16 ; ticket `.scratch/phase-5-haute-disponibilite/issues/01-contrats.md`.
- **Code lu** : FreeRADIUS `release_3_2_10`, `src/modules/rlm_sql/drivers/rlm_sql_postgresql/rlm_sql_postgresql.c` (l. 133 à 192). Si `radius_db` contient un `=`, la chaîne est transmise **telle quelle** à `PQconnectdb`, et `server` ou `port` ne lui sont pas ajoutés quand elle contient déjà `host=` ou `port=`.

## 1. Réplication A → B

Trois formes comparées :

| Forme | Pour | Contre |
|---|---|---|
| A. **Réplication physique en flux, asynchrone**, avec un slot | Copie exacte (rôles, fonctions, grand livre) ; lecture sur B (T13) ; `pg_rewind` pour faire revenir A | B est en retard de quelques secondes ; une transaction validée sur A peut manquer sur B si A est perdu |
| B. Réplication physique **synchrone** | Aucune perte à la bascule | **Toute écriture de A attend B.** B coupé ou lent ⇒ `post_auth`, l'accounting et les paiements de A bloquent. Contraire à l'exigence 1 du §0 |
| C. Réplication logique | Sélection de tables | Ni les rôles ni les séquences ne suivent ; promotion bien plus délicate ; aucune lecture cohérente du schéma `radius` |

**Retenu : A.**
- PostgreSQL 16 (même version mineure sur les deux nœuds), `wal_level = replica`, `hot_standby = on`, un **slot physique** `noeud_b`, `max_slot_wal_keep_size = 20GB` (un B coupé longtemps ne remplit pas le disque de A : au-delà, le slot est invalidé et B se reconstruit).
- L'objectif « perte maximale 5 min » (§10.2) est tenu par la réplication **et** par l'archive des WAL (§5, `archive_timeout = 60s`).
- **Transport** : une interface WireGuard **dédiée** aux nœuds, `wk-noeuds`, statique, `10.213.255.1` (A) et `10.213.255.2` (B) en /32. Elle est **distincte** de `wg0`, que `wg-agent` aligne sur la base et pourrait vider. PostgreSQL n'écoute que sur `127.0.0.1` et sur l'adresse de `wk-noeuds`. `pg_hba.conf` : `hostssl` n'est pas exigé dans ce tunnel. On utilise `host replication wk_replication 10.213.255.2/32 scram-sha-256`. nftables n'ouvre le port UDP de `wk-noeuds` qu'à l'IP publique de l'autre nœud.
- Rôle `wk_replication` : `REPLICATION`, `LOGIN`, aucun autre droit. Son mot de passe est posé à la main par Yacouba sur A, et rangé dans `~postgres/.pgpass` de B, en mode 0600.

## 2. Nœud B en lecture seule (T13)

- **Chemin d'authentification de B : sa base locale seulement** (règle 1). `client_lookup` et `authorize` sont en lecture seule, prouvé par la matrice (`test_authorize_en_lecture_seule`).
- **`post_auth` sur une réplique** : sans changement, chaque appel lèverait `25006` (transaction en lecture seule). FreeRADIUS l'ignore déjà (`fail = 1`, ADR 0006 §10), mais PostgreSQL journaliserait une erreur par authentification, soit 200 lignes par seconde en pleine charge. **Décision** : `radius.post_auth` commence par `IF pg_is_in_recovery() THEN RETURN …` et sort sans rien écrire. **Assumé** : pendant le mode dégradé, le journal des tentatives et les compteurs anti-devinette ne sont pas tenus sur B. La limite de débit par MAC de FreeRADIUS reste active (ADR 0011).
- **Accounting reçu par B** : il est écrit dans le spool `detail` de B (règle 2, inchangée). Le lecteur de rejeu se connecte avec :
  `radius_db = "dbname=wakatnet host=127.0.0.1,10.213.255.X target_session_attrs=read-write connect_timeout=1"` (X : l'autre nœud).
  libpq essaie les hôtes dans l'ordre et ne garde que celui qui accepte l'écriture :
  - **A primaire, PostgreSQL de A arrêté, B non promu** : aucun hôte n'accepte l'écriture. Le spool attend, et rien n'est perdu ;
  - **PostgreSQL de A revenu** : le spool de B se vide **dans A**, à travers `wk-noeuds` ;
  - **B promu** : le spool de B se vide dans B ; celui de A sera rejoué dans B quand A reviendra en réplique.
  - Les fonctions `radius.acct_*` reçoivent l'heure de réception d'origine (`p_received_epoch`), donc un rejeu tardif reste juste dans le temps (règle 5). L'ordre entre deux spools est déjà traité par l'ADR 0006 §12.
- **Conséquences assumées du mode dégradé** :
  - un ticket neuf est accepté sur B, mais **son activation n'est écrite qu'au rejeu** ;
  - la limite d'appareils (T5) s'appuie sur des sessions que B ne voit pas encore ;
  - un ticket peut donc être utilisé un peu au-delà de sa limite pendant la panne. C'est le compromis du §10.2 : « mode dégradé assumé ».
- Les tâches qui écrivent ne tournent **que sur le primaire** : coupure (ADR 0010), tâches de l'API, fantômes, purge. Chacune sort sans erreur si `pg_is_in_recovery()`. C'est prouvé sur une vraie réplique (ticket 02).

## 3. Bascule (promotion de B) — manuelle

- **Pas de bascule automatique** (§10.2). La décision est humaine, et le script `infra/noeud/promouvoir-b.sh` l'exécute avec des gardes :
  1. il refuse si le PostgreSQL de A **répond** sur `wk-noeuds` (A n'est pas mort : un double primaire est le pire cas, puisque deux grands livres divergeraient) ;
  2. il exige une confirmation tapée (`PROMOUVOIR`) et une raison, inscrites au journal du nœud ;
  3. il exécute `pg_promote()`, attend `pg_is_in_recovery() = false`, puis vérifie que la fumée passe.
- **Retour de A** : jamais en primaire. `infra/noeud/rejoindre-en-replique.sh` exécute `pg_rewind` vers B, puis démarre A en réplique de B. Si `pg_rewind` échoue, A est reconstruit par `pg_basebackup`. L'unité systemd de PostgreSQL sur A reste **désactivée** tant que ce script n'a pas réussi : c'est la clôture (« fencing ») par la procédure.
- **Applications** (API, portail, tâches) : elles tournent sur le primaire. Le runbook fixe l'ordre : démarrer les conteneurs sur B, puis basculer le DNS de l'API et du portail. Le webhook de l'agrégateur vise le nom DNS, pas l'IP.
- Durée visée : reprise en 30 min (§10.2), **chronométrée** dans la pile de test (ticket 03).

## 4. Pourquoi la réplique et la sauvegarde sont deux choses

La réplique copie aussi les erreurs : un `DELETE` malheureux, ou un déclencheur d'ajout seul retiré par un administrateur (ADR 0013, M7). Seule une sauvegarde à un instant donné, gardée ailleurs, protège contre ces cas.

## 5. Sauvegardes chiffrées et restauration

- **pgBackRest**, version épinglée (paquet Debian du nœud). Il est maintenu : l'abandon annoncé le 27/04/2026 a été annulé le 18/05/2026.
  - Sauvegarde complète chaque semaine, différentielle chaque jour.
  - Archive continue des WAL, `archive_timeout = 60s`.
  - Rétention : 4 complètes.
  - Sauvegarde prise **sur le primaire**, la nuit, avec un seul processus (`process-max = 1`).
    - *Corrigé à l'implémentation (ticket 04)* : la première rédaction la prenait sur B (`backup-standby`). Or pgBackRest exige alors un canal SSH ou TLS de B vers le primaire, et l'archive des WAL se fait de toute façon sur le primaire. À cette échelle, le gain de charge ne justifie pas ce canal de plus.
    - Le script tourne sur les deux nœuds et sort sans rien faire sur une réplique : la sauvegarde suit le primaire après une bascule.
- **Chiffrement** côté client : `repo1-cipher-type = aes-256-cbc`. La phrase de passe est dans `/etc/pgbackrest/secret.conf` (root, 0600), créée par Yacouba. **Une copie hors des nœuds est obligatoire** : sans elle, la sauvegarde est perdue avec les nœuds.
- **Stockage hors site** : dépôt compatible S3, **chez un troisième fournisseur**, distinct des deux hébergeurs des nœuds. Le choix du fournisseur est **[À CONFIRMER]** par Yacouba (coût, région).
  - En labo, le dépôt est un répertoire (`repo1-type = posix`), avec le même chiffrement.
  - Le transport S3 n'est **pas prouvé ici** : il le sera sur le nœud.
- **Essai de restauration mensuel, automatisé** (`infra/noeud/essai-restauration.sh`, minuterie systemd) :
  - restaure la dernière sauvegarde dans un répertoire temporaire, sur un port local ;
  - démarre l'instance et contrôle quatre points :
    - les empreintes des migrations (`schema_migrations`) ;
    - l'équilibre du grand livre (chaque transaction équilibrée, solde global nul) ;
    - **la comparaison avec la base vivante** : toute transaction et toute écriture du grand livre présentes dans la sauvegarde doivent exister à l'identique dans la base vivante. Une disparition ou une modification signale une atteinte à l'ajout seul (M7) ;
    - le nombre de lignes des tables principales ;
  - mesure la durée, alerte en cas d'échec, puis efface l'instance.
- La **restauration chronométrée** du §12 se mesure sur le jeu de données de charge (100 000 tickets, 1,35 million de lignes d'`auth_log`).

## 6. Supervision et alertes (§10.3)

Trois formes comparées :

| Forme | Pour | Contre |
|---|---|---|
| A. Prometheus, Alertmanager et Grafana sur chaque nœud | Standard, graphes | Trois services de plus à tenir, à durcir et à sauvegarder, pour deux nœuds |
| B. Service externe de supervision | Rien à héberger | Données d'exploitation chez un tiers ; dépendance d'un service payant |
| C. **Collecteur maison, minuterie d'une minute**, sortie au format texte de Prometheus, règles d'alerte dans le code | Une seule unité systemd, testable ; le format reste ouvert à un Prometheus plus tard | Pas de graphes |

**Retenu : C.**
- `apps/api/src/sante.ts`, lancé par la minuterie `wakatnet-sante` sur **chaque** nœud. Il lit :
  - la base, par des fonctions `SECURITY DEFINER` exécutables par un rôle `wk_sante`, en lecture seule ;
  - les compteurs de silence (ADR 0009 §4) ;
  - la taille du spool `detail` ;
  - `wg show wg0 latest-handshakes` (capacité `CAP_NET_ADMIN` sur l'unité, rien de plus) ;
  - l'état de la réplication (`pg_stat_replication` sur A, `pg_last_xact_replay_timestamp()` sur B).
- **Sondes de bout en bout** :
  - `Status-Server` vers radiusd ;
  - un appel d'`authorize` en tant que `wk_radius` sur un routeur inconnu, chronométré. C'est le même chemin que la fumée (ADR 0009 §3).
- **Métriques** (§10.3) :
  - authentifications par minute et rejets par cause (`auth_log`) ;
  - latence de la sonde ;
  - silences ;
  - routeurs sans échange WireGuard depuis plus de 3 min ;
  - taille et âge du spool ;
  - paiements `PENDING` de plus de 15 min ;
  - écart de rapprochement ;
  - retard de réplication ;
  - âge de la dernière sauvegarde réussie.
- **Alertes** :
  - Telegram, par un appel HTTPS. Le jeton et l'identifiant du salon sont dans un fichier 0600 créé par Yacouba ;
  - e-mail par SMTP si un relais est configuré, **[À CONFIRMER]**.
  - Une alerte ne part qu'**au changement d'état** (déclenchée, puis résolue), pour éviter les rafales. Une alerte n'emporte jamais de donnée personnelle ni de code de ticket.
- **Page d'état des propriétaires** : `GET /etat`, publique, en HTML et JSON. Elle donne l'état de l'authentification par nœud et l'heure de la dernière vérification. Aucune donnée d'un propriétaire n'y figure.
- **Rotation** des compteurs de silence par `logrotate` (ADR 0009 §4, reste à faire).

## 7. Déploiement d'un nœud

- **Ansible** (ansible-core épinglé, nœud de contrôle sous Linux ou WSL), rôles dans `infra/ansible/` :
  - `socle` : utilisateurs, SSH, nftables, mises à jour automatiques de sécurité ;
  - `wireguard` : `wg0` et `wk-noeuds` ;
  - `postgresql` (primaire ou réplique) ;
  - `freeradius` ;
  - `pgbackrest` ;
  - `noeud_wakatnet` : unités systemd, `wg-agent`, Node 22 officiel, API en conteneur.
- **Les secrets ne passent jamais par Ansible** : les fichiers de secrets sont créés à la main sur le nœud (§13, règle 5). Les rôles vérifient leur **présence**, jamais leur contenu.
- Preuve : `ansible-playbook --syntax-check`, `ansible-lint`, puis une exécution réelle sur des conteneurs avec systemd, deux fois (idempotence : aucun changement au second passage).
  - *Précisé à l'implémentation (ticket 06)* : les conteneurs sont des **Ubuntu 24.04**, faute d'accès aux dépôts Debian depuis l'environnement de développement. Le rejeu sur Debian 13 revient à la VM de Yacouba (§8).
  - Garde ajoutée : un nœud déclaré réplique qui n'en est pas une n'est effacé que sur demande explicite (`postgresql_reconstruire_replique=true`).
- Mises à jour un nœud à la fois, B d'abord (§10.3) ; la procédure est dans `docs/RUNBOOK.md`.

## 8. Ce que la phase 5 ne prouve pas ici

- **LABO-16 et LABO-09**, c'est-à-dire la bascule réelle d'un routeur de A vers B et le réglage de `timeout` : il faut un CHR (piste B, Yacouba).
- Le module WireGuard du noyau et FreeRADIUS installé par les paquets officiels sur une **VM** Debian 13 (ADR 0004 point 5) : les rôles Ansible sont prouvés sur conteneur, le rejeu sur VM revient à Yacouba.
- Le transport S3 des sauvegardes (§5) et l'envoi réel vers Telegram (le test vise un faux serveur HTTPS).
- B chez un **autre hébergeur** (ADR 0004 point 3) : condition de G-PILOTE.
