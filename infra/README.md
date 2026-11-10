# infra/ — environnement de développement WAKATNET (phase 0)

> **Développement et labo uniquement.** En production, **FreeRADIUS,
> PostgreSQL et WireGuard sont installés nativement (systemd)** sur chaque
> nœud, sans conteneur sur le chemin d'authentification (décision D7,
> SPEC §3 et §4). Seuls l'API, le worker, le portail et les tableaux de bord
> seront conteneurisés en production. `infra/docker-compose.yml` ne sert
> jamais à déployer un nœud.

## Contenu

| Chemin | Rôle |
|---|---|
| `docker-compose.yml` | Pile de développement : `postgres`, `redis`, `freeradius`, et l'outil `radclient` (profil `tools`). |
| `dev/.env.example` | Modèle des secrets de dev (`CHANGE_ME`). Le vrai fichier `dev/.env` est ignoré par Git. |
| `dev/postgres/init/00-schemas.sql` | Crée les schémas `app`, `radius`, `ledger` (SPEC §4). Aucune table métier. |
| `dev/freeradius/` | Configuration FreeRADIUS minimale de phase 0 (voir son `README.md`). |
| `dev/tools/radclient.sh` | Lance `radclient` avec le secret lu dans l'environnement et passé par fichier (`-S`), jamais en argument. |

Hors de ce ticket : `infra/freeradius/` et `infra/sql/radius/` (phase 1).

## Services et versions

Tags vérifiés sur Docker Hub le 10/11/2026 et épinglés exactement :

| Service | Image | Port publié | Santé |
|---|---|---|---|
| `postgres` | `postgres:16.15` | `127.0.0.1:5432/tcp` | `pg_isready` |
| `redis` | `redis:7.4.12` (BullMQ, plus tard) | `127.0.0.1:6379/tcp` | `redis-cli ping` |
| `freeradius` | `freeradius/freeradius-server:3.2.10` | `127.0.0.1:1812/udp`, `127.0.0.1:1813/udp` | — (lancé en `-X`) |
| `radclient` (profil `tools`) | même image que `freeradius` | aucun | — |

**Écart avec le SPEC §1.2** : le SPEC cite 3.2.8 comme dernière 3.2.x ;
Docker Hub publie `3.2.9` et `3.2.10` (mis à jour le 26/10/2026), et
`radiusd -v` dans l'image affiche `FreeRADIUS Version 3.2.10`. Le paquet
Debian à installer en production reste **[À CONFIRMER]** le jour de
l'installation.

Tous les ports sont liés à `127.0.0.1`. Un CHR (GNS3) ne pourra pas joindre
ce FreeRADIUS tant que ce lien n'est pas élargi : ce sera un choix explicite
du ticket de labo, pas un défaut.

Variables non secrètes modifiables par l'environnement du shell :
`WAKATNET_PG_PORT`, `WAKATNET_REDIS_PORT`, `WAKATNET_RADIUS_AUTH_PORT`,
`WAKATNET_RADIUS_ACCT_PORT`, `WAKATNET_DEV_SUBNET` (défaut
`172.29.213.0/24`, réseau autorisé dans `clients.conf`).

## Mise en route (Yacouba, à la main)

1. Copier `infra/dev/.env.example` en `infra/dev/.env`, puis remplacer chaque
   `CHANGE_ME` par une valeur aléatoire (`openssl rand -hex 24`, ou
   l'équivalent PowerShell). Ce fichier n'est jamais versionné ni collé dans
   une conversation.
2. Depuis la racine du dépôt :

   ```sh
   docker compose -f infra/docker-compose.yml config --quiet   # validation
   docker compose -f infra/docker-compose.yml up -d
   docker compose -f infra/docker-compose.yml ps                # postgres et redis « healthy »
   docker compose -f infra/docker-compose.yml logs -f freeradius
   ```

   Attention : `docker compose config` **sans** `--quiet` affiche les
   valeurs de `dev/.env` en clair.

3. Envoyer une requête avec `radclient` :

   ```sh
   printf 'User-Name = "test-dev"\nUser-Password = "x"\n' | \
     docker compose -f infra/docker-compose.yml --profile tools run --rm -T \
       radclient -x freeradius:1812 auth
   ```

   Résultat attendu à ce stade : `Access-Reject` (aucun utilisateur déclaré).

4. Tout arrêter et effacer les données : `docker compose -f infra/docker-compose.yml --profile tools down -v`.

## Secrets

- Les trois secrets (`POSTGRES_PASSWORD`, `REDIS_PASSWORD`,
  `RADIUS_DEV_SECRET`) ne vivent que dans `infra/dev/.env`.
- Redis reçoit son mot de passe par l'entrée standard (`redis-server -`) et
  le contrôle de santé l'utilise via `REDISCLI_AUTH` : rien en argument de
  commande.
- FreeRADIUS lit son secret par `$ENV{RADIUS_DEV_SECRET}` ; `radclient` le
  reçoit par fichier temporaire (`-S`). Le mode `-X` masque les secrets
  (`<<< secret >>>` observé : défaut `suppress_secrets` de l'image 3.2.10,
  non posé explicitement dans `dev/freeradius/`) mais journalise les attributs des requêtes :
  aucun vrai mot de passe en dev.
- Limite assumée en dev : `env_file` donne tout `dev/.env` à chaque
  conteneur, et les valeurs sont lisibles par `docker inspect`. En
  production, chaque service systemd n'aura que ses propres secrets.

## Poste de travail

Cible du labo : poste Windows de Yacouba (Docker Desktop / WSL2) ou VPS Linux
de test (SPEC §13, règle 11). Garder le dépôt en fins de ligne LF
(`.gitattributes`) : `radclient.sh` est exécuté par `sh` dans le conteneur.
