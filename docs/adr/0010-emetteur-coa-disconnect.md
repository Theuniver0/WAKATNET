# ADR 0010 — Émetteur de Disconnect / CoA et déclencheur de coupure

- **Statut** : **proposé le 12/11/2026** (ticket 09), à valider par Yacouba. Il précise l'ADR 0006 §1, §6 et §17, acceptés, sans les contredire. Les points marqués **[à valider]** sont des choix que ces sections laissaient ouverts.
- **Références** : `docs/SPEC.md` §4 (règle 1), §5.6 (T9, T12), §10.1 ; ADR 0006 §1, §6, §14, §17 ; ADR 0008 ; ticket `.scratch/phase-1-coeur-radius/issues/09-coa-disconnect.md`.

## 1. Émetteur (`infra/coupure/emetteur.ts`)

- Module TypeScript, réutilisable par le futur worker (ADR 0006 §17). Il est exécuté tel quel par **Node 22 officiel**, qui retire les types au chargement : le code n'emploie que de la syntaxe TypeScript effaçable.
  - **Constaté le 12/11/2026** : le paquet `nodejs` d'Ubuntu 26.04 (22.22.1) est compilé **sans** cette fonction (`process.features.typescript = false`). Il faut donc le binaire officiel (image `node:22.23.0`, épinglée par empreinte, en test). Sur le nœud, la phase 5 installera Node 22 officiel.
- Il appelle `radclient` 3.2.10 : signature de la requête, calcul du Message-Authenticator (attribut à zéro dans l'entrée), et **vérification de l'authentificateur de la réponse**. Une réponse à l'authentificateur faux est rejetée par `radclient` ; l'émetteur la compte et ne la prend jamais pour un ACK (prouvé, §5).
- **Secret** (S1) : écrit dans un fichier 0600, dans un répertoire 0700 créé sous `TMPDIR`, passé par `-S`, puis supprimé. L'unité systemd place `TMPDIR` dans `/run/wakatnet-coupure`, un tmpfs (`RuntimeDirectory`). Jamais en ligne de commande, jamais journalisé (prouvé, §5).
- **Valeurs recopiées dans l'entrée de `radclient`** (`User-Name`, `Acct-Session-Id`, débit) : listes blanches de caractères, sans guillemet, antislash ni fin de ligne. Sinon, une valeur pourrait injecter un attribut. Une valeur hors liste lève `DemandeInvalide`, et rien n'est envoyé.
- Attributs : `User-Name` (code du ticket), `Acct-Session-Id`, `Message-Authenticator`, et `Mikrotik-Rate-Limit` pour un CoA de débit.

## 2. Retentatives

- **Mesuré le 12/11/2026** sur `radclient` 3.2.10 face à un compteur de paquets :

  | Option | Envois réels |
  |---|---|
  | `-r 0` | 0 |
  | `-r 1` | 1 |
  | `-r 2` | 2 |
  | `-r 3` | 2 |
  | `-r 5` | 2 |

  Les retentatives internes de `radclient` ne sont donc pas fiables.
- **Décision** : un appel `radclient -r 1` par envoi, au plus `WAKATNET_COUPURE_ENVOIS` envois (3 par défaut), avec une attente de `WAKATNET_COUPURE_DELAI_S` (1 s par défaut) chacun. Chaque envoi porte un nouvel identifiant RADIUS. Pour un Disconnect, c'est sans effet : le routeur coupe une session une fois, puis répond NAK.

## 3. Déclencheur (`infra/coupure/coupure.ts`) et suivi en base

- Un tour : `radius.sessions_to_cut()`, puis pour chaque session `radius.coa_target()`, l'envoi du Disconnect et `radius.mark_cut()`. Rôle `wk_coa`, seul lecteur du secret par session (ADR 0006 §1, §14).
- **[à valider] Accès à la base par `psql`**, sans dépendance npm. Le socle Node (Fastify, Prisma) n'arrive qu'en phase 2 (ticket 2.1). Le futur worker gardera l'émetteur et remplacera cet accès. Les paramètres passent par des variables `psql`, jamais par concaténation.
- **Sessions à couper** :
  - inscrites par l'accounting (volume ou temps épuisé, tickets 05 et 06) ;
  - ou dont le propriétaire est suspendu (motif `proprietaire_suspendu`).

  La session doit être vivante, au sens de `_vivante` (ticket 06). Le remboursement (ADR 0006 §6) n'existe pas avant la phase 3.
- **Résultats** (`radius.session.coupure_resultat`, `coupure_tentatives`, `coupure_le`) :
  - `ack` : terminé ; le Stop du routeur fermera la session ;
  - `nak` : terminé, **avec une alerte** `coupure_refusee`. Le routeur ne connaît pas (plus) la session, ou il refuse la requête pour une autre raison : la session peut alors continuer de consommer (revue du ticket 09) ;
  - `sans_reponse` : la session est reprise au tour suivant ;
  - `abandon` : après `coupure_tentatives_max` tours sans réponse (5, dans `radius.parametre`), avec **une** alerte `coupure_abandonnee`.
  - Les alertes portent l'identifiant de session.
  - `mark_cut` ne change plus un état final (`ack`, `nak`, `abandon`), par exemple après un tour tué entre l'envoi et l'enregistrement, ou un appel concurrent.
  - **[à valider] États finaux définitifs** : une session en `nak` ou en `abandon` n'est plus reprise, même pour un nouveau motif. Par exemple, une session abandonnée pendant une suspension, dont le volume s'épuise ensuite. Les alertes la signalent à l'exploitant.
- **Écarts de signature avec l'ADR 0006 §1** : `coa_target` rend `nas_ip` en `text` et non en `inet`, parce que c'est ce que lit le déclencheur. `sessions_to_cut` prend un paramètre `p_limite` (100 par défaut, au plus 1 000).
- Un tour traite au plus 100 sessions, **l'une après l'autre**, dans un **budget de temps** (`WAKATNET_COUPURE_BUDGET_S`, 20 s, sous le `TimeoutStartSec=25s` de l'unité). Les sessions restantes passent au tour suivant.
- **Ordre** : d'abord les sessions jamais tentées, puis la tentative la plus ancienne (`coupure_le NULLS FIRST`). Avant la revue, le tri par date d'inscription remettait les mêmes sessions muettes en tête à chaque tour : un routeur éteint avec une dizaine de clients **affamait** toutes les autres coupures (revue du ticket 09). Prouvé : une session vivante inscrite après une muette est coupée au tour suivant.
- **Robustesse** (revue du ticket 09) :
  - configuration illisible (`ENVOIS`, `DELAI_S`, `BUDGET_S`) : sortie 1 **avant** tout envoi, rien n'est enregistré. Sinon, toutes les sessions passaient à `abandon` sans qu'un paquet parte ;
  - `radclient` qui échoue sans rien envoyer (dictionnaire, binaire, fichier du secret) : `ErreurRadclient`, la session n'est **pas** marquée, et le tour continue. Sortie 1, donc échec visible dans systemd ;
  - erreur de base sur une session : journalisée, et le tour continue avec les suivantes ;
  - session sans cible (secret ou ticket absent) : comptée comme muette, donc abandonnée avec une alerte ;
  - **nœud en lecture seule** (`pg_is_in_recovery()`, réplique T13) : aucun envoi. **Non testé** : il n'y a pas de réplique avant la phase 5 ;
  - `radclient` reçoit un environnement minimal (`PATH`) : il n'hérite pas du mot de passe de la base.
- Le parallélisme est à reprendre dans le worker (phase 2). La phase 1 compte moins de 50 routeurs.
- **Index** : `sessions_to_cut` ne peut pas utiliser l'index partiel `session_a_couper`, à cause de `OR t.suspendu` et de `_vivante`. Toutes les 30 s, elle lit donc `radius.session`. À mesurer au ticket 10.
- **CoA de débit** : `coupure.ts debit <session> <débit>`, à la demande (le futur worker l'appellera). Il ne touche pas au suivi des coupures.
- **Journal** : une ligne par session, avec l'identifiant de session, l'IP du routeur, le motif, le nombre d'envois et le résultat. **Jamais** le code du ticket ni le secret (prouvé). Le rôle `wk_coa` ne journalise jamais ses instructions (`log_min_error_statement = panic`, comme au ticket 08).
- **Production** : `wakatnet-coupure.service` (oneshot, `DynamicUser`, `EnvironmentFile=/etc/wakatnet/coa.env`, durcissement : `CapabilityBoundingSet=` vide, `PrivateDevices`, `ProtectKernel*`, `RestrictAddressFamilies`, `RestrictNamespaces`…, sans `MemoryDenyWriteExecute`, que le JIT de Node empêche) et `wakatnet-coupure.timer`, toutes les 30 s (ADR 0006 §17). La coupure intervient donc en moins d'un intervalle d'Interim (120 s), au retard du lecteur `detail` près.

## 4. Faux NAS de test

- **FreeRADIUS 3.2.10** (`radius/tests/fauxnas/`), lancé dans le conteneur de test sur l'IP du routeur r13, ports 1700 et 3799. Il vérifie :
  - l'IP source (seul le client « nœud » est connu) ;
  - le secret (authentificateur de requête et Message-Authenticator vérifiés par radiusd) ;
  - la **présence** du Message-Authenticator (`require_message_authenticator`, et revérification en unlang).

  Il acquitte, et journalise le type, la source, `User-Name`, `Acct-Session-Id`, le débit et le Message-Authenticator.
- **Compteur Python** (`fauxnas/compteur.py`) sur l'IP de r14. **Constaté** : FreeRADIUS ne journalise que le **premier** paquet rejeté pour mauvais secret, et traite les renvois comme des doublons. Il ne peut donc pas compter les envois exacts. Le compteur compte chaque paquet et vérifie l'authentificateur avec **son** secret. Il peut aussi répondre un ACK à l'authentificateur faux.
- **Adresse de nœud du test** : `10.213.0.3`, portée par le conteneur de test. Les routes locales vers r13 et r14 la prennent pour source. En production, le nœud émet depuis `10.213.0.1` ou `10.213.0.2`.

## 5. Preuves (`test_t09.py`, `test_t09_sql.py`)

- **T12 de bout en bout** : Accept, Start, puis un Interim qui épuise le volume ; la session est inscrite, et le Disconnect est reçu par le faux NAS **en moins d'un intervalle d'Interim**. Le Disconnect porte `User-Name`, `Acct-Session-Id`, le Message-Authenticator, et part de l'adresse de nœud. Une fois acquitté, il n'est plus renvoyé.
- **Mauvais secret côté NAS** : aucune réponse, **exactement 3 envois** comptés, tous depuis l'adresse de nœud. Au cinquième tour sans réponse : `abandon` et une seule alerte.
- **Réponse à l'authentificateur faux** : rejetée (3 sur 3), le résultat reste `sans_reponse`. Le compteur, qui connaît le bon secret, confirme au passage que les 3 requêtes de `radclient` sont correctement signées.
- **CoA de débit** : `Mikrotik-Rate-Limit = 1M/2M` reçu. Une valeur qui injecterait un attribut est refusée par la liste blanche (« débit invalide »), et rien n'est envoyé.
- **Port lu en base** : routeur passé à `coa_port = 3799`, CoA reçu sur 3799. Le faux NAS écoute sur 1700 et sur 3799.
- **NAK** : `nak`, avec une alerte `coupure_refusee` qui porte la session.
- **Revue** : session muette qui n'affame pas les autres ; configuration illisible ⇒ aucun envoi ni enregistrement ; panne de `radclient` visible, session non marquée ; `mark_cut` sans effet sur un état final ; retentatives internes de `radclient` mesurées par un test (`-r 0` : 0 envoi, `-r 1` : 1, `-r 3` : 2).
- **Faux NAS** : une requête construite à la main est acquittée (témoin). Elle est ignorée depuis une IP hors nœud, sans Message-Authenticator, ou avec un mauvais secret.
- **Secret** : jamais dans `/proc/*/cmdline` pendant l'envoi ; fichier 0600 dans un répertoire 0700, supprimé après.
- SQL : droits exacts (seul `wk_coa`), motifs, `ack`, `nak`, abandon, suspension, session arrêtée, résultat ou session inconnus refusés.

## 6. Hors de ce ticket

- **T9 sur CHR** (piste B, Yacouba) : session réellement coupée, puis Stop reçu ; port réel de `/radius incoming` (1700 d'après la doc MikroTik, 3799 ailleurs : la valeur vient de `app.router.coa_port`).
- Le nœud B : en lecture seule (T13), `mark_cut` y échoue. La coupure ne tourne que sur le primaire (phase 5).
