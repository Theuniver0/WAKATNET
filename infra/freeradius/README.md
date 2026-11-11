# Configuration FreeRADIUS de production — WAKATNET

Phase 1, ticket 02. Contrats : `docs/adr/0006-contrats-radius.md`. Cette configuration est **la même** en production et en test : les seules différences sont des variables d'environnement, listées dans `radius/tests/surcharges/LISTE.md`.

## Fichiers

| Fichier | Rôle |
|---|---|
| `radiusd.conf` | Copie du fichier de l'image 3.2.10. Deux lignes marquées « WAKATNET » diffèrent : `reject_delay = 0`, et l'inclusion de `mods-enabled/` de ce dépôt (liste fermée des modules). |
| `clients.conf` | Un seul bloc : tout l'overlay `10.213.0.0/16`, avec des clients **dynamiques** (`rate_limit = yes`, Message-Authenticator exigé). |
| `sites-enabled/dynamic_clients` | Création d'un client au premier paquet d'une IP inconnue : une requête (`map_clients` → `radius.client_lookup`). |
| `sites-enabled/wakatnet` | Authentification : une requête (`map_auth` → `radius.authorize`), CHAP et PAP, silence si la base est indisponible, `ticket_inconnu` pour tout refus sans cause. |
| `sites-enabled/rejeu_accounting` | Lecteur du spool d'accounting (ticket 04) : `radius.acct_start / acct_interim / acct_stop`, rôle `wk_acct`. Sans réponse (base indisponible), l'enregistrement est réessayé. |
| `mods-enabled/sql_wakatnet` | Pools PostgreSQL : `sql_clients` et `sql_auth` (rôle `wk_radius`), `sql_acct` (rôle `wk_acct`, lecteur `detail`). |
| `mods-enabled/sql_map_wakatnet` | Les requêtes et l'association colonnes → attributs (`rlm_sql_map`). |
| `mods-enabled/detail_wakatnet` | Spool de l'accounting : la section accounting n'écrit que ce fichier, puis répond (règle 2). |
| `mods-enabled/{always,attr_filter,chap,pap,expr}` | Modules de la distribution, inclus tels quels. |

## Variables d'environnement (EnvironmentFile systemd sur le nœud)

| Variable | Production | Secrète |
|---|---|---|
| `WAKATNET_RADIUS_LISTEN` | `10.213.0.1` (A) / `10.213.0.2` (B) | non |
| `WAKATNET_CLIENT_LIFETIME` | `300` | non |
| `WAKATNET_PG_HOST` | `127.0.0.1` | non |
| `WAKATNET_PG_RADIUS_PASSWORD` | mot de passe de `wk_radius` | **oui** (fichier réservé à root, jamais versionné) |
| `WAKATNET_PG_ACCT_PASSWORD` | mot de passe de `wk_acct` (lecteur `detail`) | **oui** (même fichier) |

## Points d'attention

- **Aucune option de debug en production**, ni `-X` ni `-x` :
  - `-X` affiche le mot de passe PostgreSQL et les secrets des clients (observé), et passe le serveur en mono-fil ;
  - `-x` affiche les codes de ticket (`User-Name`, observé).

  La pile de test utilise `-x` (ADR 0008, amendement), avec des codes jetables.
- **Démarrage** : `ExecStartPre=/etc/freeradius/verifier-env.sh`. Sans cette garde, un `WAKATNET_CLIENT_LIFETIME` absent donnerait un cache des clients sans fin.
- **Le spool d'accounting** (`/var/log/freeradius/radacct/wakatnet/`) contient les codes de ticket, nécessaires au rapprochement. Les fichiers sont en 0600, propriété de `freerad`, et supprimés une fois rejoués. Leur accumulation signale une base indisponible : à superviser (§10.3).
- `proxy.conf` est celui de la distribution (exemples inactifs, aucun royaume) ; à réduire en phase 5.
- Sur Debian, avec les paquets officiels de l'éditeur, les chemins sont `/etc/freeradius/3.0/` : l'adaptation est faite en phase 5 (ADR 0004).
- Version exigée : ≥ 3.2.10, jamais 3.2.9 (E-FR-1). `radius/tests/run.sh` le vérifie.
