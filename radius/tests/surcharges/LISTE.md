# Surcharges de test — liste fermée (ADR 0008 §5)

La pile de test monte la configuration FreeRADIUS de **production** (`infra/freeradius/`) sans aucune modification. Seules les variables d'environnement ci-dessous diffèrent. Toute variable ajoutée à `test.env` sans être listée ici fait échouer `test_surcharges.py`.

| Variable | Production (nœud) | Test | Raison |
|---|---|---|---|
| `WAKATNET_RADIUS_LISTEN` | `10.213.0.1` (nœud A), `10.213.0.2` (nœud B) | `*` | Le test envoie aussi depuis une IP hors overlay, pour prouver qu'elle est ignorée. |
| `WAKATNET_CLIENT_LIFETIME` | `300` | `20` | Observer l'effet d'une désactivation en base sans attendre 5 min (L4). |
| `WAKATNET_PG_HOST` | `127.0.0.1` | `172.29.215.5` | PostgreSQL est dans un autre conteneur. |

**Option de lancement** (hors variables) : `-x` (debug niveau 1) en test, aucune option en production. C'est le seul moyen de journaliser le rejet d'un paquet sans Message-Authenticator (`radius.c` l. 2891, `listen.c` : `if (DEBUG_ENABLED)`), preuve exigée par T10. Le serveur reste multi-fil, contrairement à `-X`, et la recherche de secrets couvre ce journal.

Variables **secrètes**, hors surcharges, générées à chaque passage dans `jeu.secrets` (non versionné) : `POSTGRES_PASSWORD`, `WAKATNET_PG_RADIUS_PASSWORD`, `WAKATNET_PG_TEST_PASSWORD`, `WAKATNET_SECRET_R1`, `WAKATNET_SECRET_R2`, `WAKATNET_SECRET_R3`.
