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
7. Vérifier un achat de bout en bout avec un petit montant, puis noter l'heure de chaque étape au journal.

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
- Essai de restauration : `wakatnet-essai-restauration.timer`, le 3 de chaque mois. Résultat : `/var/lib/wakatnet/essai-restauration.json`. En cas d'échec, lire `journalctl -u wakatnet-essai-restauration` : un **écart du grand livre** (`ecriture:ID`) signale une ligne disparue ou modifiée depuis la sauvegarde. Le traiter comme un incident de sécurité, pas comme une panne.
- Phrase de passe du dépôt : dans `/etc/pgbackrest/conf.d/secret.conf` **et** hors des nœuds. Sans elle, aucune restauration n'est possible.

### Restaurer la base après une perte des deux nœuds

1. Nouveau nœud installé par Ansible (§5), PostgreSQL arrêté, répertoire de données vide.
2. Remettre `/etc/pgbackrest/conf.d/secret.conf` (copie hors site).
3. Restaurer jusqu'à la fin des WAL archivés (perte bornée par `archive_timeout`, 60 s) :

   ```bash
   sudo -u postgres pgbackrest --stanza=wakatnet --type=default restore
   ```

4. Démarrer PostgreSQL, puis passer la fumée, puis le §1.
5. Rejouer les spools des nœuds perdus s'ils sont récupérables (`/var/log/freeradius/radacct/wakatnet/`), puis reconstruire B (§4).

### Restaurer après l'effacement du dépôt (nœud compromis, ADR 0018)

Le bucket B2 est verrouillé en mode conformité pendant 30 jours : un effacement ne fait que **masquer** les objets, et leurs versions restent lisibles. Symptômes : alerte `sauvegarde` (la stanza n'existe plus), ou `pgbackrest info` vide.

1. **Contenir d'abord** :
   - révoquer la clé d'application B2 des nœuds (console B2) ;
   - traiter le nœud compromis (RUNBOOK §3 : couper son réseau).
2. Retrouver l'heure de l'effacement : console B2, versions de `wakatnet/backup/wakatnet/backup.info` (heure du masquage). Choisir une heure **juste avant**, en UTC.
3. Vérifier ce que le dépôt contenait à cette heure :

   ```bash
   sudo -u postgres pgbackrest --stanza=wakatnet --repo=1 --repo-target-time="2026-11-20 03:00:00+00" info
   ```

4. Sur un nœud sain, PostgreSQL arrêté, répertoire de données vide, restaurer jusqu'à la fin des WAL de cette heure :

   ```bash
   sudo -u postgres pgbackrest --stanza=wakatnet --repo=1 --repo-target-time="2026-11-20 03:00:00+00" restore
   ```

5. Démarrer PostgreSQL, fumée, §1. Créer une **nouvelle clé** B2 pour les nœuds, puis recréer la stanza (`stanza-create`) et lancer une sauvegarde complète.

Prouvé au banc `infra/noeud/essais/sauvegarde-s3.sh` (S3 de test, verrou de conformité) ; à rejouer une fois sur B2 à la mise en service (`docs/MISE_EN_PRODUCTION.md`).

**Mesuré** le 12/11/2026 sur le banc d'essai (`infra/noeud/essais/sauvegarde.sh`, base de 349 Mo : 100 000 tickets, 1,35 million de lignes d'`auth_log`) :
- sauvegarde complète en 7,1 s ;
- restauration jusqu'au point cohérent de la sauvegarde, instance ouverte, en 3,9 s.

C'est un conteneur local avec un dépôt sur disque. Sur le nœud, le transfert depuis le stockage S3 dominera : à remesurer au premier essai mensuel.
