# infra/dev/freeradius/ — configuration FreeRADIUS de DÉVELOPPEMENT (phase 0)

Ce dossier ne contient que le strict nécessaire pour faire démarrer l'image
officielle `freeradius/freeradius-server:3.2.10` dans le `docker-compose` de
développement et lui envoyer des paquets avec `radclient`.

| Fichier | Monté sur | Rôle |
|---|---|---|
| `clients.conf` | `/etc/freeradius/clients.conf` (lecture seule) | Un seul client : le réseau Docker `wakatnet-dev`. Secret lu dans `$ENV{RADIUS_DEV_SECRET}` (fichier `infra/dev/.env`, non versionné). `require_message_authenticator = yes` et `limit_proxy_state = yes` écrits explicitement (SPEC §1.2). |
| `site-default.conf` | `/etc/freeradius/sites-available/default` (lecture seule) | Site réduit, IPv4 seul (PAP, CHAP, accounting vers `detail`). Le site de l'image écoute aussi sur `::` et refuse de démarrer sur un hôte sans IPv6. |

Tout le reste (modules, dictionnaires, dont `dictionary.mikrotik`) est celui
de l'image, sans modification.

**Aucune décision d'accès ici.** Sans utilisateur déclaré, toute requête
reçoit un Access-Reject : c'est attendu.

## Où va la vraie configuration

La configuration de phase 1 (clients dynamiques, module SQL vers le schéma
`radius`, accounting découplé par fichier `detail`, Disconnect / CoA) sera
écrite dans **`infra/freeradius/`**, et les fonctions SQL dans
**`infra/sql/radius/`**, par les tickets de phase 1. Ces dossiers ont un seul
auteur à la fois (SPEC §13, règle 9) ; ce dossier-ci ne doit pas devenir une
seconde configuration concurrente.

En production, FreeRADIUS est installé nativement (systemd), pas en
conteneur (décision D7).
