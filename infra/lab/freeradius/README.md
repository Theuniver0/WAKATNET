# Labo FreeRADIUS côté serveur (L1 à L6)

**Statut : laboratoire.** Ce dossier ne fait pas partie de la conception de la phase 1. La fonction `radius.authorize` et le schéma SQL sont des **jouets**. Ils servent seulement à prouver des comportements de FreeRADIUS sur lesquels la spec s'appuie (§1.2, §4 règle 1, §5.1, §5.6 T10). Toutes les valeurs (`secret-labo-01`, `radius-labo-mdp`, …) sont des valeurs de labo, sans aucun secret réel.

## Objet

| # | Ce qu'on prouve | Spec |
|---|---|---|
| L1 | Un seul bloc de clients dynamiques couvre `10.213.0.0/16`. La recherche du client passe par `radius.client_lookup(src_ip)` (`SECURITY DEFINER`). Une IP inconnue, inactive ou hors overlay ne crée pas de client et le paquet est ignoré. | §1.2, §5.1 |
| L2 | Le rôle `wk_radius` ne peut qu'exécuter les fonctions `radius.*`. Toute lecture ou écriture directe des tables est refusée. | §5.1 |
| L3 | Message-Authenticator obligatoire sur le client dynamique : un paquet sans lui est ignoré (T10), un paquet avec lui est accepté. Les valeurs `yes`, `auto` et `no` sont observées. | §1.2, T10 |
| L4 | Durée de vie du cache client : un changement de secret ou la désactivation du routeur ne prend effet qu'à l'expiration de `lifetime`. | §5.1 |
| L5 | CHAP avec un mot de passe en clair lu par une fonction SQL. La réponse porte `Session-Timeout` et `Mikrotik-Rate-Limit` (dictionnaire `dictionary.mikrotik`). | §1.1, §5.2 |
| L6 | L'accounting va uniquement dans un fichier `detail` et reste répondu quand PostgreSQL est arrêté. On note ce que devient l'autorisation quand la base est arrêtée. | règle 2, T13 |

## Versions observées (10/11/2026, conteneur Ubuntu 24.04.5)

- FreeRADIUS **3.2.5** (`3.2.5+dfsg-3~ubuntu24.04.3`, paquet Ubuntu). La spec vise 3.2.8.
  - Les tags `release_3_2_9` et `release_3_2_10` existent sur GitHub (archives de release : HTTP 200). Le ChangeLog date la 3.2.10 du 03/06/2026 (`urgency=high`) ; la 3.2.11 est en cours, sans tag. **3.2.8 n'est donc pas la dernière version.**
  - Je n'ai pas compilé la 3.2.8 dans ce labo : le classificateur de permissions de la session a refusé la compilation de code externe. Pour la rejouer : télécharger l'archive `freeradius-server-3.2.8.tar.gz` depuis les releases GitHub, installer `libtalloc-dev libssl-dev libpq-dev`, lancer `./configure --prefix=/opt/freeradius-3.2.8 && make && make install`, puis remplacer `freeradius` par `/opt/freeradius-3.2.8/sbin/radiusd` et `/etc/freeradius/3.0` par `/opt/freeradius-3.2.8/etc/raddb` dans `run-lab.sh`.
- radclient 3.2.5, PostgreSQL 16.15, noyau 6.18.

## Rejouer

Il faut être root sur Ubuntu 24.04 (VPS de test ou WSL2). Les paquets manquants s'installent tout seuls.

```bash
sudo infra/lab/freeradius/run-lab.sh          # tout recréer et tout tester ; code de sortie ≠ 0 si un test échoue
sudo LAB_KEEP=1 infra/lab/freeradius/run-lab.sh  # garde le réseau et la base à la fin, pour inspecter
```

Le script, idempotent, enchaîne ces étapes :

1. Il crée un cluster PostgreSQL **dédié** `16/wklab` sur le port 55432 (le port 5432 n'est pas touché), puis charge `sql/00-schema.sql` et `sql/10-seed.sql`.
2. Il crée un pont `wkbr0` qui porte l'IP overlay du nœud, `10.213.0.1/16`. Chaque routeur simulé vit dans **son propre espace de noms réseau** : `wk-r1` 10.213.1.10, `wk-r2` .1.20, `wk-r3` .1.30 (inactif), `wk-r9` 10.213.9.99 (inconnu), `wk-out` 10.99.0.5 (hors overlay). radclient 3.2.5 n'a pas d'option d'adresse source, et les alias sur `lo` ne fixent pas l'IP source vers une adresse locale. L'espace de noms (`ip netns exec`) règle les deux problèmes.
3. Il construit un raddb dans `$LAB_WORKDIR` (défaut `/var/tmp/wakatnet-lab-freeradius`) à partir de celui de la distribution. Il n'active que `always chap pap expr sql detail_wk` et nos sites `wakatnet` et `dynamic_clients`, puis lance `freeradius -X` pour chaque variante.
4. Il exécute les tests et écrit tous les journaux dans `evidence/` :
   - `00-summary.log` : PASS, FAIL, OBS ;
   - `01-key-lines.log` : lignes clés des journaux `-X` ;
   - `radiusd-*.log` : sortie complète de `radiusd -X` ;
   - un fichier par échange radclient ou radreq ;
   - `L2-psql.log`.
5. À la fin, il démonte le réseau et supprime le cluster (sauf avec `LAB_KEEP=1`).

### Pourquoi `tools/radreq.py`

**radclient 3.2.5 ajoute toujours un Message-Authenticator** aux Access-Request, même quand le fichier de paquet n'en contient pas. On l'a observé : le serveur reçoit `Message-Authenticator = 0x…` pour un paquet « sans ». Le ChangeLog 3.2.9 confirme que radclient ne sait le supprimer qu'à partir de cette version (`Message-Authenticator !* ANY`). Pour T10, le script utilise donc un petit émetteur CHAP écrit avec la seule bibliothèque standard Python. Il construit un paquet avec ou sans Message-Authenticator et vérifie le Response Authenticator de la réponse.

## Fichiers

| Fichier | Rôle |
|---|---|
| `run-lab.sh` | Script unique : installation, mise en place, tests L1 à L6, preuves |
| `sql/00-schema.sql` | Rôles `wk_owner` (NOLOGIN, propriétaire) et `wk_radius` (EXECUTE seulement), schémas `app`, `ledger`, `radius`, fonctions `radius.client_lookup` et `radius.authorize` (jouet) |
| `sql/10-seed.sql` | 3 routeurs, 1 ticket, 1 écriture de grand livre |
| `sql/20-l2-privileges.sql` | Test L2, exécuté en tant que `wk_radius` |
| `raddb/clients.conf.in` | Le seul bloc `client overlay { ipaddr = 10.213.0.0/16 … }` |
| `raddb/dynamic-clients.in` | Serveur `dynamic_clients` : appelle `radius.client_lookup`, positionne `FreeRADIUS-Client-*` |
| `raddb/wakatnet.in` | Serveur principal : `chap`, `sql`, accounting vers `detail_wk` seulement |
| `raddb/mod-sql.in`, `raddb/mod-detail_wk.in` | Modules `rlm_sql` (PostgreSQL, sans `queries.conf`) et `detail` |
| `packets/*.txt` | Paquets radclient (CHAP, accounting) |
| `tools/radreq.py` | Émetteur Access-Request avec ou sans Message-Authenticator |

## Résultats et conséquences pour la conception

Le détail des résultats et des journaux est dans `evidence/00-summary.log`. Points à retenir :

1. **Sur 3.2.5, `require_message_authenticator` du bloc `client` est sans effet sur les clients dynamiques.** C'est l'attribut `&FreeRADIUS-Client-Require-MA = yes`, positionné dans le serveur `dynamic_clients`, qui décide : bloc `yes` sans l'attribut, tout passe sans Message-Authenticator ; bloc `no` avec l'attribut à `yes`, tout est rejeté. `auto` n'a aucun effet non plus : il n'y a pas de bascule après un paquet portant un Message-Authenticator.
   - Dans le source de 3.2.8 et 3.2.10, `client_afrom_request()` hérite bien de la valeur du bloc (ajout de la 3.2.6), mais la ligne `c->require_ma = (fr_bool_auto_t) c->dynamic_require_ma;` l'écrase plus loin. Je m'attends au même comportement, mais **c'est une lecture du source, pas une observation en labo**.
   - **Règle à appliquer : toujours écrire `&FreeRADIUS-Client-Require-MA = yes` dans `dynamic_clients`, et aussi `require_message_authenticator = yes` dans le bloc.**
2. Avec l'attribut à `yes`, **même le premier paquet** d'une IP inconnue sans Message-Authenticator est ignoré. Le client est créé, puis le paquet est rejeté (« Insecure packet … »).
3. Le paquet qui déclenche la recherche du client est ensuite traité normalement (Accept immédiat, sans retransmission).
4. **L'expiration du cache est paresseuse.** Le premier paquet qui arrive après `lifetime` relance la recherche SQL et il est vérifié avec le **nouveau** secret. Pendant `lifetime`, l'ancien secret marche et le nouveau est ignoré : un changement de secret coupe donc le routeur jusqu'à `lifetime` secondes, ce qu'il faut prévoir dans la procédure de rotation.
5. Une IP inconnue relance la recherche SQL **à chaque paquet**, retransmissions comprises : il n'y a pas de cache négatif. C'est acceptable derrière WireGuard (AllowedIPs), à surveiller sinon.
6. Avec la base arrêtée :
   - l'accounting est répondu en environ 40 ms (0,043 s dans la preuve) ;
   - un client déjà en cache reçoit un **Access-Reject**, après `reject_delay` de 1 s et sans `Reply-Message` (`sql` renvoie `fail`) ;
   - un client pas encore en cache est **ignoré** ;
   - avec `pool { start = 1 }`, **radiusd refuse de démarrer** si la base est absente ; avec `start = 0`, il démarre.
   - La variante `sql { fail = 1 }` suivie de `if (fail) { do_not_respond }` ne répond rien. **Hypothèse à prouver sur CHR** : RouterOS ne bascule sur le second serveur `/radius` qu'en cas de timeout, pas sur un Reject. Si c'est vrai, `do_not_respond` est préférable au Reject pour T13.
7. Avec `radiusd -X`, la version 3.2.5 écrit **en clair** le mot de passe PostgreSQL et le secret de chaque client. Ne jamais lancer `-X` avec de vrais secrets, ni versionner de journaux qui en contiennent. Les journaux de `evidence/` **sont versionnés** (exception dans `.gitignore`) parce qu'ils ne contiennent que des valeurs de labo jetables (`secret-labo-*`, `radius-labo-mdp`). La 3.2.9 active `suppress_secrets = true` par défaut, d'après le ChangeLog, non vérifié en labo.
8. Le ChangeLog de la 3.2.10 corrige un bogue : le lecteur de fichiers `detail` ne lisait pas les fichiers (#5870). Ce lecteur est le cœur de la règle 2 : il faut vérifier la version retenue avant de s'y fier. Le rejeu `detail` vers PostgreSQL n'est pas testé ici.

## Limites de ce labo

- Pas de RouterOS ni de CHR : pas de KVM dans le conteneur. Le comportement du NAS face à un Reject ou à une absence de réponse reste à prouver.
- `radius.authorize` est appelée deux fois par requête (requêtes check puis reply) : c'est un jouet.
- Le lecteur `detail` (rejeu vers PostgreSQL) n'est pas testé.

## Avertissement sur les secrets de labo

`run-lab.sh` passe le mot de passe de labo `radius-labo-mdp` en argument (`psql -v`, `sed`) et par `PGPASSWORD`. C'est acceptable pour des valeurs jetables de labo, **pas ailleurs** : ce motif est interdit hors de `infra/lab/` (SPEC §13, règle 5 ; `CONTRIBUTING.md` S1).

## Constat annexe

Le même fichier de paquet (`packets/auth-chap-ma.txt`, avec `NAS-IP-Address = 10.213.1.10`) est envoyé depuis chaque routeur simulé, y compris r2 (10.213.1.20). Le serveur l'accepte : **FreeRADIUS ne compare pas `NAS-IP-Address` à l'IP source**. L1 reste valable (la recherche se fait par IP source), mais la phase 1 ne doit jamais se fier à `NAS-IP-Address` ni à `NAS-Identifier` pour identifier un routeur (SPEC §5.1 : IP source dans le tunnel uniquement).

## Note de reproductibilité

Les fichiers SQL sont passés à `psql` par l'entrée standard : le script fonctionne même si l'utilisateur `postgres` ne peut pas traverser le dossier du dépôt (`/root`, home en 700, montages WSL).
