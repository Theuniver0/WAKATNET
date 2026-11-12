# ADR 0008 — Migrations, schéma et cadre de test de la phase 1

- **Statut** : **accepté par Yacouba le 11/11/2026** (ticket 01).
- **Références** : `docs/SPEC.md` §9, §12, §13 (règles 1, 3, 5, 6) ; D10 ; `CONTRIBUTING.md` ; ADR 0006 et 0007 ; `infra/lab/freeradius/` (méthodes du labo).

## 1. Migrations

- **SQL pur, fichiers numérotés**, appliqués par un petit script idempotent (`infra/sql/migrer.sh`, bash + psql) sous le rôle propriétaire `wakatnet_owner`, avec une table de suivi `public.schema_migrations`. Chaque fichier s'exécute dans une transaction et n'est jamais modifié une fois appliqué.
  - Alternatives écartées : dbmate (binaire tiers à télécharger et à épingler, pour un gain faible) ; Prisma pour tout (la spec réserve `radius` et `ledger` au SQL pur).
- **[accepté le 11/11/2026] Écart avec le §9**, qui confie le schéma `app` à Prisma : en phase 1, ses tables sont créées en SQL, puis reprises par Prisma en phase 2 (voir plus bas). Motif : la phase 1 n'a pas encore de projet Node.
- **Arborescence** :
  - `infra/sql/app/` : tables métier de la phase 1 :
    - `tenant` (avec la suspension administrative) ;
    - `site` ;
    - `router` (IP overlay, `epoch`, `require_ma_exception`, port CoA) ;
    - `plan` ;
    - `voucher` ;
    - `audit_log` (minimal).
  - `infra/sql/radius/` :
    - `router_secret`, lisible seulement par `wakatnet_owner` ;
    - `session`, `acct_cle`, `acct_quarantaine`, `auth_log` ;
    - `parametre` (`radius.parametre`) ;
    - `lecteur_battement` (retard du lecteur `detail`) ;
    - fonctions, rôles et droits.
- **[amendé le 12/11/2026 par l'ADR 0012 §5]** Le passage décrit ci-dessous n'a pas lieu : `infra/sql/` reste le seul historique de migrations, et Prisma n'est que le client de l'API (schéma tiré par `prisma db pull`, test de divergence).
- ~~**Passage à Prisma (phase 2)**~~ : le schéma `app` est repris par `prisma db pull`, puis marqué « déjà appliqué » par une migration de base (`prisma migrate resolve --applied`). Ensuite, **seul Prisma** modifie `app` ; `infra/sql/app/` est gelé. Le risque de double propriété ne dure donc que jusqu'à la phase 2.
- **Test de fumée après chaque migration** (ADR 0006 §13) : en tant que `wk_radius`, `client_lookup` et `authorize` répondent sans erreur sur une donnée de référence.

## 2. Schéma compatible avec le partitionnement

- `radius.session` n'est **pas** partitionnée en phase 1 (moins de 50 routeurs). Elle a pourtant dès maintenant une clé primaire **`(id, started_at)`**, et toute référence vers elle (`acct_cle`, `mark_cut`, `coa_target`) porte ces deux colonnes. Ainsi le partitionnement mensuel futur (§9), qui impose la colonne de partition dans la clé, ne casse rien.
- **L'idempotence ne repose pas sur `session`** : `radius.acct_cle (router_id, router_epoch, acct_session_id, username) PRIMARY KEY → (session_id, session_started_at)`. Cette table **non partitionnée** est purgée avec les sessions.
- `voucher` : `UNIQUE (tenant_id, code)`. Copie figée du forfait dans des colonnes typées, pas en JSON, pour garder des index et des contrôles.
- Montants éventuels en `BIGINT` XOF (A1). En phase 1, il n'y a pas d'argent ; le prix figé sert seulement plus tard, au frais papier.

## 3. Cadre de test

- **Python 3 + pytest + Hypothesis** (tests de propriétés), versions épinglées dans `radius/tests/requirements.txt`, lancés dans un conteneur `python:3.12-slim` épinglé par digest.
- Émetteurs RADIUS : `radclient` (image FreeRADIUS 3.2.10) et `radreq.py` (repris de `infra/lab/freeradius/tools/`, sans dépendance) pour les paquets sans Message-Authenticator.
- `radius/tests/run.sh` :
  1. `docker compose down -v`, puis une pile neuve ;
  2. garde de version (≥ 3.2.10, jamais 3.2.9) ;
  3. `radiusd -C` sur la configuration de production seule ;
  4. migrations et test de fumée ;
  5. fixtures déterministes ;
  6. tests, puis **en dernier** les tests « base indisponible » (marqueur pytest `base_indisponible`) ;
  7. recherche de secrets (§6).

  Code de sortie non nul au premier échec.
- **Primitive « detail vidé »** : on attend qu'il n'y ait plus de fichier `detail-*` ni `.work` en attente, **et** que la ligne attendue soit en base. Délai maximal explicite ; jamais de `sleep` fixe.

## 3 bis. Droits par défaut

- PostgreSQL accorde EXECUTE à PUBLIC sur toute nouvelle fonction. La première migration fait donc `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`, et chaque fonction reçoit en plus `REVOKE ALL … FROM PUBLIC`.
- Un test vérifie, pour chaque fonction de `radius`, que la liste des rôles autorisés correspond **exactement** à celle de l'ADR 0006 §1.

## 4. Plusieurs routeurs dans un conteneur

- Réseau Docker de test `wakatnet-overlay` en `10.213.0.0/16` (comme la production, D8). FreeRADIUS y est en `10.213.0.1`.
- Chaque routeur simulé est un conteneur éphémère lancé avec une IP fixe (`docker run --network wakatnet-overlay --ip 10.213.1.N`). Ces conteneurs servent à radclient, à `radreq.py`, et au **faux NAS** du ticket 09, qui reçoit les CoA sur l'IP du routeur.
- Faisable sous Docker Desktop / WSL2 : ni netns ni droits `NET_ADMIN`. À confirmer par Yacouba lors du premier rejeu sur son poste.

## 5. Écart entre test et production

- `infra/freeradius/` est la configuration de **production**. Les seules différences en test sont listées dans **`radius/tests/surcharges/LISTE.md`**, liste fermée :
  - `lifetime` des clients dynamiques réduit (20 s) ;
  - adresse de la base ;
  - mode de lancement : `radiusd -f -l stdout`, **sans `-X`**. `-X` affiche les mots de passe et les secrets, active `auth_goodpass` et `auth_badpass`, et passe le serveur en **mono-fil**, ce qui fausserait les tests de concurrence et de délais. Un passage de diagnostic en `-X` reste possible à la main : il est exclu de la recherche de secrets et n'est jamais publié ;
  - chemins des fichiers `detail`.
- Un test compare cette liste aux fichiers réellement surchargés. Toute différence le fait échouer.

## 6. Recherche de secrets

- Les secrets de test sont **connus et jetables** : secrets des routeurs, mots de passe des rôles.
- `run.sh` les cherche dans :
  - la sortie de `radiusd -X` ;
  - `docker logs` de chaque service ;
  - les journaux PostgreSQL ;
  - la sortie de l'émetteur de CoA ;
  - `/proc/*/cmdline` des conteneurs.
- Une seule trouvaille fait échouer le passage.

---

## Amendement du 11/11/2026 — écarts constatés au ticket 02 (relecture en deux axes)

Ces écarts sont des choix techniques, motivés par des faits observés en exécution. Ils ne touchent aucun des points acceptés par Yacouba.

| § | Prévu | Réalisé | Motif |
|---|---|---|---|
| §1 | Migrations « sous le rôle propriétaire » | Lancées par le **superutilisateur**. Chaque fichier passe en `SET ROLE wakatnet_owner` pour créer ses objets. | Seul le superutilisateur peut créer les rôles. `migrer.sh` contrôle l'empreinte SHA-256 de chaque fichier appliqué, prend un verrou consultatif, et coupe la journalisation avant de poser le mot de passe. |
| §3 | Conteneur de test `python:3.12-slim` | Image **FreeRADIUS 3.2.10** épinglée, plus Python de la distribution (Ubuntu 26.04), avec pytest, Hypothesis et psycopg épinglés. | `radclient` dans la **même version** que le serveur, avec le même dictionnaire, pour la contre-vérification. La version de Python dépend de l'image de base, épinglée par digest, et de l'état du dépôt `apt` au moment de la construction. |
| §3 | `radreq.py` | `radlib.py`, qui en dérive : PAP en plus, IP source au choix, défi CHAP distinct, réponse vérifiée (authentificateur et Message-Authenticator). | Les tests ont besoin de choisir l'IP source et d'omettre le Message-Authenticator. |
| §3 | Ordre des étapes de `run.sh` | Migrations, puis garde-fou ADR 0007 sur le catalogue, garde de version, `radiusd -C`, garde `verifier-env.sh`, tests, preuve T10 dans le journal, recherche de secrets **dans toute la sortie**. Le test de fumée tourne en premier dans pytest. | La garde de version et `radiusd -C` exigent un serveur démarré, donc des migrations faites. |
| §4 | Un conteneur éphémère par routeur, « ni netns ni `NET_ADMIN` » | **Un** conteneur `testeur` avec `NET_ADMIN`, qui porte une IP de l'overlay par routeur simulé. | Plus simple et plus rapide, et l'IP source est choisie par `radlib.py`. Le fonctionnement sous Docker Desktop / WSL2 reste à confirmer par Yacouba au premier rejeu. |
| §5 | Lancement `radiusd -f -l stdout`, sans debug | **`-x`** (debug niveau 1) en test seulement. | Le rejet d'un paquet sans Message-Authenticator n'est journalisé qu'en debug (`radius.c` l. 2891, `listen.c` `if (DEBUG_ENABLED)`). Or T10 exige cette preuve. Le serveur reste multi-fil, et la recherche de secrets couvre ce journal. **Conséquence observée** : en `-x`, le journal affiche le `User-Name`, donc le code du ticket (codes jetables du test). En **production**, aucune option de debug (`-x` ou `-X`) n'est permise ; l'ADR 0006 §10 (aucun code en clair dans le journal) y reste respectée. |
| §5 | Surcharges : lifetime, base, mode, chemins `detail` | Plus **`WAKATNET_RADIUS_LISTEN=*`**. | Pour envoyer depuis une IP hors overlay et prouver qu'elle est ignorée. En production, l'écoute se fait sur l'IP du nœud dans l'overlay. |
| — | — | **Garde de démarrage `infra/freeradius/verifier-env.sh`** (`ExecStartPre` en production, et commande du conteneur en test). | FreeRADIUS accepte un `lifetime` vide, qui vaut alors un cache sans fin (constaté). `run.sh` vérifie que la garde refuse une variable absente ou un lifetime nul. |

**Hors périmètre de la phase 1, confirmé** : la RLS (I1) arrive en phase 2 (PRD §3, « cloisonnement applicatif complet »). En phase 1, le cloisonnement repose sur la clé `(propriétaire, code)` et sur les clés étrangères composites (`tenant_id`, …), testées par T6 au ticket 03.

## Amendement du 11/11/2026 — ticket 04 (accounting découplé)

| § | Prévu | Réalisé | Motif |
|---|---|---|---|
| §3 | Tests « base indisponible » en dernier, sous un marqueur pytest | **Orchestrés par `run.sh`**, en cinq étapes de `test_t04_indispo.py`, entre lesquelles `run.sh` arrête, relance, fige (`docker compose pause`) puis libère PostgreSQL. Chaque étape doit compter exactement « 1 passed ». Hors de cette orchestration, ces tests sont ignorés. | Le conteneur de test ne pilote pas Docker, et une base arrêtée empêche la fixture de données. `WAKATNET_SANS_FIXTURES=1` garde les données du passage principal. |
| §3 | Primitive « detail vidé » | Volume `radacct` partagé : en écriture pour FreeRADIUS, en **lecture seule** pour le testeur (`conftest.attendre_rejeu`). | Observer le spool sans pouvoir le modifier. |
| §5 | Aucune différence de lancement hors `-x` | `install -d -o freerad … /var/log/freeradius/radacct` avant le démarrage, en test seulement. | Le volume partagé est créé vide par Docker. En production, le paquet crée ce répertoire pour `freerad`. |
| §6 | Secrets générés | `WAKATNET_PG_ACCT_PASSWORD` en plus (rôle `wk_acct`). `migrer.sh` pose les deux mots de passe par une même fonction, avec la journalisation coupée. `verifier-env.sh` exige la variable. | Le lecteur `detail` a son propre rôle (ADR 0006 §12). |

## Amendement du 11/11/2026 — ticket 07

- **Une MAC d'appareil simulé propre à chaque test** (`conftest.mac_du_test`). L'anti-devinette bloque une MAC après 10 échecs en 60 s sur un routeur. Sans cela, les refus volontaires de tests différents s'additionneraient et bloqueraient les tests suivants. Dans un même test, la MAC reste la même : le compte d'appareils du ticket 06 en dépend.

## Amendement du 12/11/2026 — ticket 09 (Disconnect / CoA)

| § | Prévu | Réalisé | Motif |
|---|---|---|---|
| §3 | Conteneur de test | Binaire **Node 22.23.0 officiel** recopié depuis l'image `node`, épinglée par empreinte. | Le Node d'Ubuntu 26.04 ne retire pas les types TypeScript (ADR 0010 §1). |
| §4 | « Faux NAS du ticket 09, qui reçoit les CoA sur l'IP du routeur » | Faux NAS FreeRADIUS lancé **dans le conteneur de test** sur l'IP de r13, et compteur Python sur celle de r14. Le déclencheur tourne aussi dans le testeur, et ses paquets partent de l'adresse de nœud `10.213.0.3` (routes locales). | Le routeur doit être à la fois la source de l'accounting et la destination du Disconnect, c'est-à-dire la même IP : seul le testeur peut porter les deux. |
| §6 | Secrets générés | `WAKATNET_PG_COA_PASSWORD` en plus (rôle `wk_coa`). | Rôle propre au déclencheur (ADR 0006 §1). |

## Amendement du 12/11/2026 — application des migrations sous charge (revue de fin de phase 1)

| § | Avant | Maintenant | Motif |
|---|---|---|---|
| §1 | Chaque fichier dans une transaction, sans limite d'attente des verrous | `lock_timeout` de 200 ms pour **toute** migration (`WAKATNET_MIGRATION_ATTENTE_VERROU`), puis jusqu'à 30 nouveaux essais espacés d'une seconde | Une migration en attente d'un verrou fait attendre derrière elle toutes les lectures d'`authorize`, au-delà de leur `statement_timeout` : le nœud devient muet. |
| §1 | Toujours en transaction | Un fichier `NNNN_*.sans_transaction.sql` est appliqué **hors transaction**, avec un verrou consultatif de session. Il doit être idempotent, et il n'est enregistré qu'après succès. | `CREATE INDEX CONCURRENTLY` et `DROP INDEX CONCURRENTLY` (migration 0012) sont interdits dans une transaction, et ce sont les seuls moyens de changer un index d'`auth_log` sans bloquer `authorize` ni `post_auth`. |
| §1 | « Un fichier appliqué ne change jamais » | Règle inchangée. La version transactionnelle de 0012, fusionnée, a été remplacée par un fichier de **nom différent**, après vérification qu'elle n'avait été appliquée qu'à des piles de test jetables (ADR 0011). | — |
