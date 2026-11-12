# ADR 0009 — Comportement quand PostgreSQL est indisponible

- **Statut** : **proposé** (ticket 08), à valider par Yacouba. **Provisoire jusqu'à LABO-16** (piste B).
- **Références** : `docs/SPEC.md` §4 (règles 1 et 2), §10.2, §10.3 ; ADR 0006 §1, §12 (amendement du ticket 04), §13 ; `docs/LABO.md` L6, L6d, L6e, LABO-09, LABO-16 ; ticket `.scratch/phase-1-coeur-radius/issues/08-base-indisponible.md`.
- **Code lu** (FreeRADIUS `release_3_2_10`) : `rlm_sql_map.c` (`mod_map`), `sql.c` (`rlm_sql_select_query`), `drivers/rlm_sql_postgresql/rlm_sql_postgresql.c` et `sql_postgresql.h`, `main/connection.c`, `rlm_linelog.c`. libpq de l'image : 18.6 (`fe-connect.c`, `REL_18_STABLE`).

## Contexte

Base arrêtée, FreeRADIUS renvoyait Access-Reject à un client en cache (L6). Or un Reject empêche peut-être RouterOS de basculer vers le nœud B (LABO-16, ouvert). Le silence (`do_not_respond`, L6e) est déjà en place depuis le ticket 02 (ADR 0006 §13). Le ticket 08 le borne, le compte, et le protège d'un défaut de déploiement.

## 1. Silence sur tout échec SQL du chemin critique — écart avec le ticket

Le ticket demandait le silence **seulement** pour une cause de connexion ou de délai, et un refus codé pour une erreur de donnée. **C'est impossible en 3.2.10 sans code supplémentaire** :
- `rlm_sql_map` rend `RLM_MODULE_FAIL` pour **toute** erreur de `rlm_sql_select_query`, qu'elle soit classée `RECONNECT` (connexion, délai du pilote) ou `ERROR` (droit 42501, exception P0001, délai de requête 57014…). Aucun attribut ne porte la classe de l'erreur jusqu'à `unlang`.
- Distinguer exigerait un module `exec`/`perl` (refusé par C1) ou un correctif de FreeRADIUS (hors périmètre).

**Décision** : `map_auth` et `map_clients` en échec ⇒ silence, quelle qu'en soit la cause. Ce n'est pas une régression par rapport au besoin, pour trois raisons :
1. **Une donnée ne fait jamais échouer ces fonctions.** Tickets 03 à 07 : toute entrée donne un refus codé (`ticket_inconnu`, `expire`, `epuise`…), prouvé par des propriétés Hypothesis. Il ne reste que l'indisponibilité, le délai et le **défaut de déploiement**.
2. **Un défaut de déploiement coupe tout le parc dans les deux variantes.** Reject partout ou silence partout : aucune connexion ne passe. Le silence n'est pas pire, et B, s'il a la même base répliquée, a le même défaut.
3. **Le défaut de déploiement est arrêté avant d'arriver** (§3), et compté s'il arrive quand même (§4).

## 2. Délais — mesurés

| Borne | Valeur | Source | Effet |
|---|---|---|---|
| `statement_timeout` de `wk_radius` | 500 ms | migration 0002 | **borne principale** : 57014, classé **sans** reconnexion ; silence en ~0,5 s, la connexion reste utilisable (mesuré, `test_t08.py`) |
| `query_timeout` du pilote | 1 s | `sql_wakatnet` | base qui ne répond plus du tout : `select()` expire, classé `RECONNECT`, une reconnexion |
| délai de connexion libpq | 1 s | `query_timeout` passé en `connect_timeout` (`rlm_sql_postgresql.c` l. 152) ; libpq 18 **n'arrondit plus** à 2 s | reconnexion vers une base figée |
| reconnexions par requête | ≤ 1 | `max_retries = 1`, borné par le nombre de connexions (`connection.c` l. 1273) | |
| `retry_delay` | 5 s | pool | après un échec d'ouverture, aucune nouvelle connexion pendant 5 s : échec immédiat |

- **Correction** : le pool avait une ligne `connect_timeout = 2.0`. **Cette option n'existe pas en 3.2.10** (`connection_config` de `connection.c`) ; elle était ignorée sans avertissement. Elle est retirée ; l'ADR 0006 §13 (« libpq arrondit à 2 s, non vérifié ») est corrigé ici : la valeur réelle est 1 s.
- **Mesures** (pile de test, `run.sh`) :
  - table verrouillée (requête lente) : silence en **506 ms** ;
  - base arrêtée : silence en **~3,0 s** dans la pile de test. Cause : le conteneur arrêté n'a plus d'adresse, la connexion TCP attend l'échec ARP (`EHOSTUNREACH`). **En production**, la base est locale (`127.0.0.1`) : connexion refusée immédiatement. La valeur de test est donc un majorant ;
  - base figée, 50 Access-Request en attente : les 50 silences sont comptés en **4,0 s**, Accounting-Response en **1,2 ms** au plus (8 mesures étalées sur 2 s d'attente) ;
  - retour de la base : Accept **2,4 à 2,7 s** après « base prête » (après redémarrage de radiusd, base arrêtée) et **2,3 s** (après un gel), le routeur insistant toutes les 250 ms : sous `retry_delay` + 1 s.
- **Comparaison au `timeout` de RouterOS** : inconnue tant que LABO-09 n'a pas donné le `timeout` retenu et le nombre de renvois. Pour un **silence**, la durée côté serveur ne change rien au routeur : il attend son propre `timeout`. Elle compte pour l'occupation des fils (§6).

## 3. Test de fumée après chaque migration

`infra/sql/fumee.sh`, appelé à la fin de `migrer.sh` (le déploiement échoue avec lui) :
- exécute `client_lookup` et `authorize` **en tant que `wk_radius`** (`SET LOCAL ROLE`), dans une transaction `READ ONLY` annulée : aucun effet de bord ;
- vérifie `EXECUTE` sur `post_auth` (`wk_radius`) et `acct_*` (`wk_acct`), sans les exécuter (elles écrivent) ;
- vérifie `statement_timeout = 500ms` sur `wk_radius`.

Prouvé : droit retiré et fonction qui lève ⇒ silence compté **et** `fumee.sh` en échec, avec le message de PostgreSQL (`test_t08.py`).

Limite : la fumée prouve la base, pas le fichier de configuration FreeRADIUS. Celui-ci est couvert par `radiusd -C` et la matrice T.

## 4. Compteur des silences (§10.3)

- `linelog` `silence_auth` (`/var/log/freeradius/wakatnet/silence-auth.log`) et `silence_client` (`silence-client.log`) : une ligne `AAAA-MM-JJ HH:MM:SS <IP du routeur>` par paquet laissé sans réponse. **Jamais le code**.
- Deux fichiers, deux instances : `rlm_linelog` sérialise les écritures d'une instance, pas celles de deux instances sur un même fichier.
- Un routeur inconnu ou inactif n'est **pas** compté (ce n'est pas un silence de la base).
- `fail = 1` sur le compteur : un disque plein ne doit pas transformer le silence en Reject.
- **À faire (phase 5, exploitation)** : rotation (`logrotate`) et lecture par la supervision. Volume borné par le trafic : à 200 auth/s, environ 30 Mo par heure de panne.

## 5. Démarrage sans base, et clients dynamiques pendant une panne

- `pool { start = 0 }` : radiusd démarre base arrêtée et traite les paquets (L6d, rejoué : `run.sh`, étape h).
- **Limite de l'ADR 0006 (amendement du ticket 04), tranchée ici** : pendant une panne, un routeur dont le client dynamique a expiré, ou tout routeur après un redémarrage de radiusd, n'obtient **aucune** réponse, accounting compris.
  - **Décision : on l'accepte.** C'est cohérent avec le silence : le routeur bascule vers B (T13), qui reçoit authentification et accounting.
  - Écartés : une liste statique des clients régénérée depuis la base (une seconde copie des secrets sur disque, et une désactivation qui n'agit qu'à la régénération) ; un `lifetime` plus long (la désactivation d'un routeur, L4, met plus de temps à prendre effet).
  - **À revoir avec LABO-16** et en phase 5, si la bascule de l'accounting vers B pose problème (deux spools, ADR 0006 §12).

## 6. Risque mesuré : fils de traitement et fil de réception

- Base figée : chaque Access-Request occupe un fil au plus le temps du §2. Le pool `sql_auth` est borné à 16 connexions ; au-delà, `fr_connection_get` échoue aussitôt (silence immédiat). L'accounting n'utilise pas la base : avec 50 requêtes en attente, il a répondu en 1,2 ms au plus.
- `client_lookup` s'exécute dans le fil de **réception** (ADR 0006 §13) : base figée, chaque création de client bloque la réception de tout le nœud pendant ~1 à 2 s. Limité par `rate_limit` (une création par seconde). Mesure à grande échelle : ticket 10.

## Conséquences

- Base indisponible ⇒ le nœud se tait, compte, et répond toujours à l'accounting des clients en cache.
- Avant la phase 5, il n'y a **pas de nœud B** : un silence donne au client « serveur RADIUS sans réponse » plutôt que « ticket refusé ». C'est une différence de message, pas d'accès.
- **LABO-16 clôt l'ADR** :
  - si RouterOS bascule aussi sur un Reject, on pourra revenir au Reject, qui bascule plus vite que l'attente du `timeout` ;
  - sinon, le silence est confirmé.
  Dans les deux cas, le silence est **correct** ; seule la vitesse de bascule est en jeu.
