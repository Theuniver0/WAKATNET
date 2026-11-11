# ADR 0008 — Migrations, schéma et cadre de test de la phase 1

- **Statut** : proposé le 11/11/2026 (ticket 01) ; à accepter par Yacouba.
- **Références** : `docs/SPEC.md` §9, §12, §13 (règles 1, 3, 5, 6) ; D10 ; `CONTRIBUTING.md` ; ADR 0006 et 0007 ; `infra/lab/freeradius/` (méthodes du labo).

## 1. Migrations

- **SQL pur, fichiers numérotés**, appliqués par un petit script idempotent (`infra/sql/migrer.sh`, bash + psql) sous le rôle propriétaire `wakatnet_owner`, avec une table de suivi `public.schema_migrations`. Chaque fichier s'exécute dans une transaction et n'est jamais modifié une fois appliqué.
  - Alternatives écartées : dbmate (binaire tiers à télécharger et à épingler, pour un gain faible) ; Prisma pour tout (la spec réserve `radius` et `ledger` au SQL pur).
- **Arborescence** :
  - `infra/sql/app/` : tables métier de la phase 1 (`tenant`, `site`, `router`, `plan`, `voucher`, `parametre`) ;
  - `infra/sql/radius/` : `session`, `acct_cle`, `acct_quarantaine`, `auth_log`, fonctions, rôles et droits.
- **Passage à Prisma (phase 2)** : le schéma `app` est repris par `prisma db pull`, puis marqué « déjà appliqué » par une migration de base (`prisma migrate resolve --applied`). Ensuite, **seul Prisma** modifie `app` ; `infra/sql/app/` est gelé. Le risque de double propriété ne dure donc que jusqu'à la phase 2.
- **Test de fumée après chaque migration** (ADR 0006 §13) : en tant que `wk_radius`, `client_lookup` et `authorize` répondent sans erreur sur une donnée de référence.

## 2. Schéma compatible avec le partitionnement

- `radius.session` (`id bigint` généré, `started_at`, …) n'est **pas** partitionnée en phase 1 (moins de 50 routeurs). Son partitionnement mensuel futur (§9) ne doit rien casser.
- **L'idempotence ne repose pas sur `session`** : `radius.acct_cle (router_id, router_epoch, acct_session_id) PRIMARY KEY → session_id`. Cette table **non partitionnée** est purgée avec les sessions.
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

## 4. Plusieurs routeurs dans un conteneur

- Réseau Docker de test `wakatnet-overlay` en `10.213.0.0/16` (comme la production, D8). FreeRADIUS y est en `10.213.0.1`.
- Chaque routeur simulé est un conteneur éphémère lancé avec une IP fixe (`docker run --network wakatnet-overlay --ip 10.213.1.N`). Ces conteneurs servent à radclient, à `radreq.py`, et au **faux NAS** du ticket 09, qui reçoit les CoA sur l'IP du routeur.
- Faisable sous Docker Desktop / WSL2 : ni netns ni droits `NET_ADMIN`. À confirmer par Yacouba lors du premier rejeu sur son poste.

## 5. Écart entre test et production

- `infra/freeradius/` est la configuration de **production**. Les seules différences en test sont listées dans **`radius/tests/surcharges/LISTE.md`**, liste fermée :
  - `lifetime` des clients dynamiques réduit (20 s) ;
  - adresse de la base ;
  - niveau de journalisation (`-X`) ;
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
