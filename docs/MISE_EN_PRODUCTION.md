# Mise en production des nœuds

- **Références** : ADR 0004, 0015, 0016 ; `infra/ansible/README.md` ; `docs/RUNBOOK.md`.
- **Qui** : Yacouba, à la main, étape par étape. Chaque étape se vérifie avant la suivante. L'agent ne se connecte à aucune machine de production.
- **État** : procédure **prouvée sur des conteneurs Debian 13** (13/11/2026 : `WAKATNET_ESSAI_OS=debian13 infra/ansible/essais/essai.sh`, dix étapes, PostgreSQL 16 et pgBackRest 2.60 du dépôt PGDG, seuils de production) et sur Ubuntu 24.04. Elle n'a **pas** été jouée sur une VM ni sur un vrai VPS : le module WireGuard du noyau, FreeRADIUS de l'éditeur et le rôle `noeud_wakatnet` (Node depuis nodejs.org) ne s'exercent pas en conteneur.

## 0. Avant de commencer

| Prérequis | Référence |
|---|---|
| Deux VPS Debian 13, IP fixes, B chez un **autre** hébergeur avant G-PILOTE | ADR 0004 |
| Nom de domaine : `api.` et `portail.` (le portail sur une IP dédiée, si l'hébergeur le permet) | ADR 0013 §10, ADR 0016 §2 |
| Accès console de chaque VPS (en cas de coupure SSH) | RUNBOOK §6 |
| Compte **Backblaze B2** (double authentification, distinct du compte Hetzner) ; bucket privé, région EU Central, **Object Lock activé à la création**, rétention par défaut **conformité 30 jours**, cycle de vie « versions masquées effacées après 31 jours » ; clés d'application créées comme au §1 (« Clés B2 »), jamais la clé maîtresse sur un nœud | ADR 0018, REVUE_SECURITE M8 |
| Clé PGDG et clé de l'éditeur de FreeRADIUS téléchargées **et vérifiées** (empreinte) dans `infra/ansible/cles/`. PGDG : `B97B 0AFC AA1A 47F0 44F2 44A0 7FCC 7D46 ACCC 4CF8`, la même que celle que Debian 13 livre dans `postgresql-common` (`/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc`), second canal de vérification | ADR 0004 point 5 |
| Bot Telegram et salon d'alertes | ADR 0015 §6 |
| Compte **Brevo** (double authentification) ; sous-domaine expéditeur `notif.DOMAINE` authentifié (SPF, DKIM selon la console Brevo, DMARC `p=quarantine`) ; clé API dans `/etc/wakatnet/api.env` : `WAKATNET_COURRIEL=brevo`, `WAKATNET_BREVO_CLE`, `WAKATNET_COURRIEL_DE=ne-pas-repondre@notif.DOMAINE` ; si Brevo le permet, clé limitée aux IP de A et B ; **suivi des ouvertures et des clics désactivé** | ADR 0019 |

## 1. Secrets, posés à la main sur chaque nœud

Liste et droits : `infra/ansible/README.md`. Un fichier par service, jamais dans le dépôt, jamais sur une ligne de commande. Générer chaque mot de passe ainsi :

```bash
head -c 24 /dev/urandom | base64
```

Garder hors des nœuds, dans un coffre :
- la phrase de passe de pgBackRest, **et elle seule** pour les sauvegardes : les clés B2 ne vont pas dans la copie hors site, elles se recréent dans la console (RUNBOOK §7). À chaque rotation, mettre à jour cette copie (RUNBOOK §7, « Rotation ») ;
- les clés `WAKATNET_CLE_MARCHANDS` et `WAKATNET_CLE_HMAC`. Sans elles, les comptes marchands sont illisibles après une restauration.

Les deux clés vont dans `/etc/wakatnet/api.env` (lu par `wakatnet-api` et `wakatnet-taches`), sur les deux nœuds, avec les **mêmes** valeurs (32 octets en base64, générés par `head -c 32 /dev/urandom | base64`, jamais recopiés dans un ticket ni dans une conversation). En production (`NODE_ENV=production`), l'API **refuse de démarrer** sans `WAKATNET_CLE_HMAC` : sans elle, les IP sources des échecs de connexion et des demandes de paiement seraient gardées en clair (T10 de `docs/CONFORMITE.md`, ADR 0016 §2).

**IP dédiée du portail** (SPEC §7.1, walled garden) : `WAKATNET_PORTAIL_IPS=<IPv4 publique du portail>` dans `/etc/wakatnet/api.env`, sur les deux nœuds ; plusieurs IP se séparent par des virgules (celle de A et celle de B si chacune sert le portail). Elle est inscrite dans le walled garden de chaque routeur à l'enrôlement (HTTPS par IP). Sans elle, un client non connecté n'atteint pas le portail et ne peut rien acheter : en production, l'API **refuse de démarrer** sans elle. Un changement d'IP impose de réenrôler les routeurs, ou d'attendre l'étape 3 d'entretien.

**Racines TLS de l'API** (ADR 0003, `infra/tls/README.md`) : `WAKATNET_RACINES_TLS=/opt/wakatnet/infra/tls/racines-api.pem` dans `/etc/wakatnet/api.env`. Le fichier est public et livré avec le code ; l'API le lit avec son utilisateur dynamique, ce qu'elle ne pourrait pas faire sous `/etc/wakatnet` (0750, root). La commande d'enrôlement importe ces racines sur les routeurs RouterOS 7.15 à 7.18, qui n'ont pas de magasin intégré. En production, l'API **refuse de démarrer** sans elles. Avant le premier enrôlement réel :
- comparer les empreintes à celles de letsencrypt.org (`infra/tls/README.md`) ;
- vérifier que la chaîne **réellement servie** par nginx remonte à l'une de ces racines, contre-signature comprise. Sinon, un routeur 7.15 à 7.18 ne peut pas construire le chemin, et tous les enrôlements échouent :

  ```bash
  openssl s_client -connect api.DOMAINE:443 -servername api.DOMAINE -showcerts </dev/null 2>/dev/null | awk '/BEGIN CERT/,/END CERT/' > /tmp/chaine.pem
  ```

  ```bash
  openssl verify -no-CApath -no-CAstore -CAfile /opt/wakatnet/infra/tls/racines-api.pem -untrusted /tmp/chaine.pem /tmp/chaine.pem
  ```

  Attendu : `OK`. Si la vérification échoue, la `fullchain` de certbot ne contient pas le certificat de contre-signature : choisir la chaîne avec `--preferred-chain`, ou ajouter la racine de la chaîne servie à `racines-api.pem`.

### Clés B2

Depuis le poste de Yacouba seulement, avec l'outil `b2` (v4) autorisé par la clé maîtresse (`b2 account authorize`, qui la lit au clavier). La clé maîtresse ne va **jamais** sur un nœud ni sur la machine de contrôle. `NOM_DU_BUCKET` est le nom réel du bucket (`pgbackrest_s3_bucket`).

1. Clé des nœuds, limitée au bucket, capacités minimales :

   ```bash
   b2 key create --bucket NOM_DU_BUCKET wakatnet-noeuds listBuckets,listFiles,readFiles,writeFiles
   ```

   - `deleteFiles` ne s'ajoute **que si** l'exercice B2 (§2, étape 7) montre que pgBackRest en a besoin pour masquer un objet (`expire`). **À vérifier** pendant l'exercice ; noter le résultat ici et dans l'ADR 0018.
   - Jamais `writeBuckets`, `writeBucketRetentions`, `writeFileRetentions`, `writeFileLegalHolds`, `bypassGovernance`, `deleteBuckets`, `writeKeys`, `deleteKeys`.
2. Clé du contrôle externe (ADR 0018, audit du 13/11/2026), liste seule :

   ```bash
   b2 key create --bucket NOM_DU_BUCKET wakatnet-controle listBuckets,listFiles
   ```

3. L'outil affiche une seule fois `keyID` et `applicationKey` : les recopier aussitôt dans le fichier de destination (par `sudoedit` pour `secret.conf`), sans les garder ailleurs.
4. Contrôle, après chaque création ou rotation :

   ```bash
   b2 key list --long
   ```

   Attendu : `wakatnet-noeuds` et `wakatnet-controle` limitées à `NOM_DU_BUCKET`, avec exactement les capacités ci-dessus ; aucune autre clé que celles qu'on connaît.

### `secret.conf` de pgBackRest, sur chaque nœud

`root:postgres`, `0640` : pgBackRest, lancé en postgres, le lit sans pouvoir le modifier. Ansible refuse tout autre propriétaire ou mode, et tout autre fichier dans `conf.d`.

```bash
sudo install -d -o root -g postgres -m 0750 /etc/pgbackrest /etc/pgbackrest/conf.d
sudo install -o root -g postgres -m 0640 /dev/null /etc/pgbackrest/conf.d/secret.conf
sudoedit /etc/pgbackrest/conf.d/secret.conf
```

Contenu : `[global]`, `repo1-cipher-pass=` (phrase de passe), `repo1-s3-key=` (keyID de `wakatnet-noeuds`), `repo1-s3-key-secret=` (son applicationKey). Vérifier : `sudo stat -c '%U:%G %a' /etc/pgbackrest/conf.d/secret.conf` donne `root:postgres 640`.

## 2. Premier déploiement

1. Inventaire : copier `infra/ansible/inventaire.exemple.yml` en `inventaire.yml`, puis renseigner les IP, les clés publiques WireGuard et les variables `frontal_*` (noms, `frontal_courriel_acme`).
   - `frontal_tls` se règle **par nœud** : `letsencrypt` sur A seul, le nœud vers lequel pointe le DNS ; `autosigne` sur B.
   - Le mode `autosigne` est aussi la valeur par défaut. B sert alors un certificat auto-signé local, sans certbot, jusqu'à une bascule (RUNBOOK §3).
   - Un nœud en `letsencrypt` que le DNS ne vise pas échoue au défi ACME, et son passage s'arrête dans le rôle `frontal`. Le pare-feu public est déjà posé à ce moment : il passe juste après `socle`.
2. Les DNS de `api.` et `portail.` pointent vers A **avant** le premier passage : c'est la condition du défi Let's Encrypt. Le certificat est renouvelé par la minuterie du paquet certbot. Le crochet `/etc/letsencrypt/renewal-hooks/deploy/wakatnet-nginx.sh` recharge nginx après chaque renouvellement. Vérifier une fois :

   ```bash
   sudo certbot renew --dry-run
   ```
3. A, en primaire :

   ```bash
   ansible-playbook site.yml --limit noeud_a
   ```

4. B, en réplique. Sur une installation neuve, le répertoire de données de B est **effacé** :

   ```bash
   ansible-playbook site.yml --limit noeud_b -e postgresql_reconstruire_replique=true
   ```

5. Vérifier la réplication (RUNBOOK §1), puis la page `https://api.DOMAINE/etat`.
6. Super-admin, sur A. Le mot de passe est lu au clavier, sans écho ni historique. La clé de chiffrement est lue dans `/etc/wakatnet/api.env` par le shell de root, jamais passée en argument (visible dans `ps`) :

   ```bash
   read -r ADRESSE && read -rs MDP && printf '%s\n%s\n' "$ADRESSE" "$MDP" | sudo bash -c 'set -a; . /etc/wakatnet/api.env; set +a; export WAKATNET_ADMIN_DATABASE_URL=postgresql:///wakatnet; cd /opt/wakatnet/apps/api && exec runuser -u postgres -- node src/admin-creer.ts'; unset MDP
   ```

   Scanner une seule fois l'URI `otpauth://` affichée.

   **E-mail** (ADR 0019) : avec Brevo réglé, chaque propriétaire confirme son adresse par le lien reçu, puis se connecte (quota de 2 routeurs). Le super-admin le valide (Administration, **Valider l'adresse**) pour porter son quota à 10 et le sortir des plafonds des comptes non validés. Sans `WAKATNET_COURRIEL`, aucun e-mail ne part. **Depuis la migration 0043 (scan de sécurité F2)**, « Valider l'adresse » ne confirme plus l'adresse d'office : il affiche un **lien de confirmation** (7 jours, usage unique). Le super-admin le remet au propriétaire **après avoir vérifié son identité** par un autre moyen (téléphone, en personne). Le propriétaire y choisit son mot de passe ; sans cela, le mot de passe d'un tiers inscrit avant lui serait activé.

   Premier essai d'envoi : créer un compte d'essai avec une adresse à soi, vérifier la réception (et le dossier indésirables), le lien, puis la connexion.
7. Sauvegarde, sur A :

   ```bash
   sudo -u postgres pgbackrest --stanza=wakatnet stanza-create
   ```

   ```bash
   sudo -u postgres pgbackrest --stanza=wakatnet check
   ```

   ```bash
   sudo systemctl start wakatnet-sauvegarde.service
   ```

   ```bash
   sudo systemctl start wakatnet-essai-restauration.service
   ```

   L'alerte « essai de restauration » reste levée tant qu'aucun essai n'a réussi : on le lance donc dès le déploiement.

   **Exercice d'effacement, une fois, avant G-PILOTE** (ADR 0018).
   - **Interdit sur A et sur B** : `stanza-delete` lancé sur un nœud, avec sa configuration, efface la stanza de production. L'exercice se joue sur une **machine ou un conteneur jetable** (PostgreSQL 16 et pgBackRest ≥ 2.59.2), qui n'a ni la configuration ni les clés des nœuds.
   - Bucket B2 **d'essai**, réglé comme celui de production (verrou de conformité 30 jours, cycle de vie 31 jours) ; clé créée comme au §1 mais **limitée au bucket d'essai** ; **phrase de passe d'essai**, jamais celle de production.
   - Configuration dédiée, passée à chaque commande, pour qu'aucun fichier de `/etc/pgbackrest` n'entre en jeu : `pgbackrest --config=/srv/essai-b2/pgbackrest.conf --config-include-path=/srv/essai-b2/conf.d …`, avec `repo1-s3-bucket` = le bucket d'essai.
   - Déroulé, comme `infra/noeud/essais/sauvegarde-s3.sh` : `stanza-create`, sauvegarde complète, ligne témoin, `expire` (si `expire` échoue faute de `deleteFiles`, ajouter cette capacité, le noter, et refaire), puis `stanza-delete --force` ; une tentative d'effacement définitif d'une version (`aws s3api delete-object --version-id`), qui doit être refusée ; restauration avec `--repo-target-time` (RUNBOOK §7) et ligne témoin retrouvée.
   - **Ce que la clé du nœud ne doit pas pouvoir faire**, avec elle seule, sur le bucket d'essai : raccourcir ou retirer la rétention d'une version (`aws s3api put-object-retention`, avec et sans `--bypass-governance-retention`), changer la rétention par défaut ou le verrou du bucket (`aws s3api put-object-lock-configuration`), changer le versionnement ou le cycle de vie (`put-bucket-versioning`, `put-bucket-lifecycle-configuration`), ou tout réglage par `b2 bucket update`. Chaque tentative doit être refusée.
   - **Contrôle externe** contre le bucket d'essai (`CONTROLE_B2_BUCKET` = bucket d'essai, clé de liste seule de l'essai) : « en ordre » après la sauvegarde et `expire` (aucune marque sur `backup.info` en fonctionnement normal) ; **code 1 et alerte `backup.info` masqué** après `stanza-delete`. La clé de liste seule doit se voir refuser `aws s3api get-object`.
   - Noter chaque résultat au journal du pilote, puis détruire la machine jetable. Le bucket d'essai reste facturé pendant ses 30 jours de verrou : quelques centimes.

   **Contrôle externe, à planifier avant G-PILOTE** (ADR 0018, audit du 13/11/2026). Sur une machine qui n'est **ni A ni B** et n'y a aucun accès (petit VPS chez un troisième fournisseur, ou poste de contrôle allumé en permanence), avec AWS CLI v2, `curl` et GNU `date` :
   - utilisateur dédié sans sudo, `controle-b2` ; script copié en `/usr/local/bin/controle-b2.sh` (root, `0755`) depuis `infra/surveillance/controle-b2.sh` ;
   - `/etc/controle-b2/identifiants` (`controle-b2`, `0600`) : `AWS_ACCESS_KEY_ID=` et `AWS_SECRET_ACCESS_KEY=` de la clé `wakatnet-controle` (§1). Les deux fichiers de secrets se créent vides puis se remplissent sans rien sur la ligne de commande : `sudo install -d -o controle-b2 -g controle-b2 -m 0700 /etc/controle-b2`, `sudo install -o controle-b2 -g controle-b2 -m 0600 /dev/null /etc/controle-b2/identifiants`, puis `sudoedit /etc/controle-b2/identifiants` (le script refuse un fichier d'un autre propriétaire ou lisible par d'autres) ;
   - `/etc/controle-b2/telegram` (`controle-b2`, `0600`) : `TELEGRAM_JETON=` et `TELEGRAM_SALON=` d'un **bot distinct** de celui des nœuds (un nœud compromis détient le jeton de leur bot) ;
   - service `controle-b2.service` (`Type=oneshot`, `User=controle-b2`, `Environment=CONTROLE_B2_BUCKET=NOM_DU_BUCKET CONTROLE_B2_IDENTIFIANTS=/etc/controle-b2/identifiants CONTROLE_B2_TELEGRAM=/etc/controle-b2/telegram`, `ExecStart=/usr/local/bin/controle-b2.sh`) et `controle-b2.timer` (`OnCalendar=hourly`, `RandomizedDelaySec=5min`, `Persistent=true`) ;
   - signe de vie : un second service identique avec `CONTROLE_B2_SIGNALER_OK=1`, et son timer à `OnCalendar=*-*-* 09:00:00`. **L'absence du message quotidien « en ordre » est une alerte** : la machine de contrôle est tombée ;
   - premier essai à la main : `sudo systemctl start controle-b2.service`, puis `journalctl -u controle-b2` ; attendu : « en ordre » (après la première sauvegarde de l'étape 7) et code 0. Une base sans aucune écriture n'archive aucun WAL : sans trafic (avant le pilote, ou une nuit vide), l'alerte WAL peut se lever à tort. Ne relever `CONTROLE_B2_MAX_WAL_MIN` qu'après avoir constaté ce cas, et le noter au journal.
8. Alertes : arrêter `wakatnet-wg-agent` une minute sur B, vérifier que l'alerte puis sa résolution arrivent sur Telegram, et le redémarrer.

## 3. Avant d'ouvrir la vente en ligne (G-ARGENT)

- Adaptateur réel en production, avec clés de production : seulement après G-ARGENT (`docs/PILOTE.md` §2).
- Compte marchand du propriétaire enregistré, webhook déclaré chez l'agrégateur (`https://api.DOMAINE/webhooks/...`).
- Un achat réel de 100 F, puis un rapprochement du jour (`docs/PILOTE.md` §4).

## 4. Mise à jour

Un nœud à la fois, B d'abord (RUNBOOK §5) :

```bash
ansible-playbook site.yml --limit noeud_b
```

```bash
ansible-playbook site.yml --limit noeud_a
```

Le pare-feu public programme son retour arrière avant d'être appliqué : une erreur de port SSH se corrige seule en 5 minutes. Le retour arrière remet en place la table précédente, **en mémoire et sur disque**, ou la retire s'il n'y en avait pas. Le passage suivant voit donc l'écart et réapplique la table. Une table absente de la mémoire est rechargée à chaque passage, même si son fichier n'a pas changé. Trace du retour arrière :

```bash
journalctl -t wakatnet-parefeu
```

Ordre quand une mise à jour touche le schéma : **migrations, puis API, puis `wg-agent`**. Ansible enchaîne les deux premières (l'API redémarre après les migrations) ; le binaire de `wg-agent` se remplace ensuite, à la main. Un `wg-agent` plus récent que le schéma ne fait que journaliser une erreur à chaque tour ; plus ancien, il ne note pas l'IP des routeurs (alerte `ip_routeurs`), et les hotspots retombent sur la garde de la migration 0031.

## 5. Retour arrière d'une mise à jour

- **Code** : repasser Ansible depuis l'étiquette Git précédente, dans le dépôt de contrôle.
- **Migration SQL** : on ne revient pas en arrière, puisque les migrations sont immuables. On écrit une migration corrective, et le schéma ne fait qu'avancer.
- **Base abîmée** : restauration (RUNBOOK §7).
