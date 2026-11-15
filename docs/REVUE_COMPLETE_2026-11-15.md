# Revue complète du 15/11/2026

- **Demandée par** : Yacouba (« total review », option « revue complète ciblée »).
- **Base relue** : `main` au commit `b45864e`.
- **Méthode** :
  - six relecteurs indépendants, un par zone : argent, authentification, SQL et RLS, RADIUS, RouterOS, production. Tous en lecture seule, sans exécution ;
  - chacun a d'abord lu `docs/REVUE_SECURITE.md` et les risques acceptés des ADR, pour ne pas les rapporter de nouveau ;
  - j'ai ensuite relu dans le code chaque constat marqué ✔ ci-dessous.
- **Ce que la revue ne prouve pas** : aucun test n'a été lancé. Les constats « probables » portent sur un ordre de démarrage, un volume ou une charge, et demandent un essai pour être confirmés.

**Bilan** :
- **Argent** : aucun chemin ne délivre un ticket sans paiement confirmé, ni deux tickets ou deux crédits pour un même paiement.
- **Production** : trois défauts empêchent l'exploitation, dont deux touchent la bascule entre les nœuds A et B (P1, P2). Les bancs ne les voyaient pas, car ils posaient d'eux-mêmes ce qui manque en production.

Légende : ✔ = relu dans le code ; **sûr** = mécanisme établi par la lecture ; **probable** = mécanisme lu, effet à confirmer par un essai.

---

## Bloquants avant G-PILOTE (production)

### P1 ✔ sûr — Les scripts de bascule s'arrêtent avant d'agir
- `promouvoir-b.sh` et `rejoindre-en-replique.sh` écrivent leur journal dans `/var/log/wakatnet`, que le rôle Ansible crée en `root 0750` (`infra/ansible/roles/noeud_wakatnet/tasks/main.yml:52`).
- La RUNBOOK lance ces scripts en `postgres` (`docs/RUNBOOK.md:71`, `:114`).
- L'écriture est refusée, et `set -e` arrête le script juste avant `pg_promote` (`infra/noeud/promouvoir-b.sh:36-40`). B n'est donc jamais promu au moment où A est perdu.
- Les bancs ne le voyaient pas : ils passent `WAKATNET_JOURNAL_NOEUD=/tmp/…`.

### P2 ✔ probable — La garde contre deux primaires peut passer avant que le lien entre nœuds existe
- Le complément d'unité PostgreSQL ajoute `ExecStartPre=` sans `After=` ni `Requires=wg-quick@wk-noeuds.service` (`infra/ansible/roles/postgresql/tasks/main.yml:62-71`).
- Au redémarrage de l'ancien primaire, le pair est injoignable faute de tunnel. La garde laisse alors démarrer un second primaire, et deux grands livres divergent.
- `listen_addresses` contient l'adresse de `wk-noeuds`, encore absente à ce moment : PostgreSQL n'écoute alors que sur 127.0.0.1.
- **À confirmer** par un vrai redémarrage sous Debian 13.

### P3 ✔ sûr — Le déclencheur de coupure ne tourne jamais
- `infra/systemd/wakatnet-coupure.service:19` lance `/opt/wakatnet/coupure/coupure.ts`, alors que l'archive dépose ce fichier à `/opt/wakatnet/infra/coupure/coupure.ts`.
- Aucun Disconnect ne part : une session révoquée ou épuisée reste ouverte jusqu'à son `Session-Timeout`.
- La santé ne surveille pas cette unité, et le test tolère le chemin absent (`radius/tests/test_t09.py:382`).

### P4 ✔ sûr — L'essai mensuel de restauration ne peut pas démarrer
- `infra/noeud/essai-restauration.sh` est en mode `100644` dans Git, et l'unité l'exécute directement : échec 203/EXEC.
- Le banc posait `chmod 0755` avant de lancer l'unité, ce qui cachait le défaut.

---

## Importants

### A1 ✔ sûr — Couper l'argent réel bloque aussi la vérification des paiements en cours
- `lienApiValide` (`apps/api/src/fournisseurs.ts:37`) est appelé à chaque création du fournisseur (`:62`), `verify()` compris.
- Si on retire `WAKATNET_ARGENT_REEL` pour arrêter la vente, les paiements PENDING ne sont plus vérifiés et les webhooks répondent 500.
- Après 24 h, ces paiements sortent de la file de vérification : le client a été débité et ne reçoit aucun ticket.
- La lecture du statut ne se sert pas du lien API, donc la garde ne protège rien à cet endroit. Elle ne devrait porter que sur `charge()`.

### R1 ✔ sûr — Sans accounting, les tickets sont illimités et les frais papier disparaissent
- `activated_at` n'est posé que par l'accounting, que le routeur du propriétaire envoie ou non (`infra/sql/radius/0008_radius_sessions.sql:481`).
- Sans activation, chaque Accept redonne la validité entière (`0046_radius_devinette_budget.sql:173-177`), et `frais_papier_prelever` ignore le ticket (`0020_app_taches.sql:61-67`).
- Il suffit au propriétaire de poser `radius-accounting=no` ou de bloquer l'UDP 1813 pour ne plus payer la commission papier.
- Cela contredit l'ADR 0002 : l'activation y est un « fait observé par le serveur », alors que l'Accounting-Start n'est qu'une déclaration du routeur.
- **Piste** : activer ou facturer dès le premier Accept, ou au moins alerter quand un routeur reçoit des Accept sans accounting.

### U1 ✔ sûr — Réservation et énumération des adresses e-mail par la création d'un vendeur (trouvé par deux relecteurs)
- `POST /v1/utilisateurs` (`apps/api/src/exploitation.ts:168-196`) répond 409 si l'adresse existe déjà, 201 sinon. L'unicité est globale sur la table (`0023_app_comptes.sql:23`).
- N'importe quel propriétaire confirmé peut ainsi :
  - savoir si une adresse est inscrite, super-admin compris, ce qui annule la correction F9 ;
  - prendre pour toujours l'adresse d'une personne pas encore inscrite. Un vendeur n'a pas à confirmer son adresse et n'est jamais purgé.

### O1 ✔ sûr — La page de connexion du propriétaire n'est jamais rétablie
- La procédure fait remplacer `hotspot/login.html` sans demander de copie de l'original (`docs/ONBOARDING_ROUTEUR.md:43`).
- Le guide affirme que la désinstallation retire « la page de connexion de WAKATNET », alors que le script ne touche à aucun fichier du hotspot (`apps/api/src/routeros.ts:365-369`).
- Après la désinstallation, la page redirige vers un portail devenu injoignable : les utilisateurs locaux n'ont plus de formulaire de connexion.
- L'ADR 0012 §9 prévoyait l'inverse : un `html-directory` distinct.

### A2 ✔ sûr — Un lien d'arrivée long rend l'achat impossible
- Le paramètre `o` (jusqu'à 512 caractères, `apps/api/src/portail.ts:55`) est recopié, encodé une seconde fois, dans la page de retour, elle-même limitée à 512 caractères (`packages/payments/src/moneyfusion.ts:94`).
- Exemple : un lien Facebook avec `fbclid` ou une recherche Google suffit à franchir la limite.
- Le client lit « le service ne répond pas » et chaque essai échoue de la même façon. Aucun argent ne bouge.
- Le paramètre `o` ne sert à rien dans la page de retour.

### S2 ✔ probable — La recherche des sessions à couper lit toute la table
- Le filtre `(s.a_couper_le IS NOT NULL OR t.suspendu)` porte sur deux tables, et la requête ne reprend pas la condition `arrete_le IS NULL` de l'index partiel (`0011_radius_coupure.sql:46-55`). L'index `session_a_couper` ne sert donc jamais.
- `radius.session` n'est jamais purgée. Avec le volume, l'appel dépassera le délai de 5 s, et les forfaits au volume ne seront plus coupés.

### S3 ✔ probable — Les tâches lancées en tête du tour finiront par bloquer la vérification des paiements
- `frais_papier_prelever` relit tous les tickets à chaque tour, sans marqueur des tickets déjà traités. `numeros_purger` et `paiements_expirer` n'ont pas d'index.
- Ces fonctions s'exécutent avant `paiements_a_verifier`, sans try/catch (`apps/api/src/taches.ts:19-21`).
- Dès que l'une dépasse 5 s, le tour échoue. Un paiement dont le webhook est perdu ne reçoit alors plus jamais son ticket.

### R2 probable — Aucune limite de débit par routeur
- 1812 et 1813 sont ouverts sans plafond par source (`infra/nftables/wakatnet.nft:19`).
- Un routeur enrôlé hostile peut :
  - gonfler sans borne le spool d'accounting, dont le lecteur est unique et commun à tous ;
  - épuiser les 16 connexions `sql_auth`.
- Tous les propriétaires sont touchés : retard des activations et des coupures, puis disque de `/var/log` plein.
- **Piste** : un `meter` nftables par source sur `wg0`, et une alerte sur l'âge et la taille du spool.

### P5 ✔ probable — Après une bascule, un slot de réplication reste orphelin
- Ansible crée toujours le slot `noeud_b` sur le nœud déclaré primaire (`postgresql/tasks/main.yml:143-151`), alors que l'ancien primaire, revenu en réplique, consomme `noeud_a`.
- Le slot inutilisé retient jusqu'à 20 Go de WAL (`max_slot_wal_keep_size`), et aucune règle de santé ne surveille les slots inactifs.

### U2 ✔ sûr (débit estimé) — `/v1/verification/confirmer` hache avant de vérifier le jeton
- Le hachage scrypt est calculé avant même de lire le jeton (`apps/api/src/auth.ts:358`).
- La route n'est pas dans la zone nginx `wk_connexion` (10 requêtes par minute, `wakatnet.conf.j2:103`).
- Quelques sources suffisent à remplir la file scrypt : connexions et inscriptions répondent alors 503. Le hotspot n'est pas touché.

---

## Mineurs

| Zone | Constat | Où |
|---|---|---|
| Argent | `montantMin` (100 F) n'est lu nulle part. Un forfait sous 100 F échoue avec « refusé par l'opérateur », alors qu'aucun opérateur n'a été appelé ✔ | `moneyfusion.ts:73`, `:89` |
| Argent | Un statut `paid` sans `Montant` ou sans `moyen` passe en MISMATCH définitif, au lieu d'un réessai | `moneyfusion.ts:156` |
| Argent | La vérification périodique tourne sur un seul fil : elle saturera vers environ 400 paiements abandonnés par jour | `taches.ts:27-39` |
| Argent | Les paiements sans jeton comptent comme des erreurs à chaque tour pendant 24 h, ce qui noie une vraie panne | `taches.ts:36-39` |
| RouterOS | Un routeur révoqué sans désinstallation laisse la vente ouverte : le client paie un ticket inutilisable | `enrolement.ts:148-163` |
| RouterOS | Si l'enrôlement échoue après la création de `wg-wakatnet`, la désinstallation répond 404 ; une réponse perdue bloque la reprise (409) | `routeros.ts:152-163` |
| RouterOS | L'entretien ne retire jamais d'anciennes entrées « wakatnet paiement » : au prochain changement d'agrégateur, l'ancien domaine reste ouvert ✔ | `routeros.ts:241-251` |
| RouterOS | L'étape 2 est importée depuis un fichier, avec les droits de l'administrateur : un compte ftp local peut le remplacer avant l'import ✔ | `routeros.ts:162-165` |
| SQL | Aucun index sur `payment.jeton_appareil`, alors qu'il est lu à chaque achat sous le verrou du site | `0037:91`, `0021:28` |
| SQL | Le verrou consultatif de `post_auth` sous forte rafale peut annuler l'écriture de l'échec, qui n'est alors compté nulle part | `0048:119-122` |
| SQL | Les droits de table de `wk_api` sont larges (`enrollment_token`, `audit_log`, `utilisateur.actif`) et aucun test ne les inventorie | `0013:47`, `test_droits.py:145` |
| SQL | Un reversement rejoué n'est pas comparé à l'existant (mode B verrouillé, donc sans effet aujourd'hui) | `0025:70-72` |
| Production | La garde des secrets FreeRADIUS ne vérifie ni le propriétaire ni le groupe | `freeradius/tasks/main.yml:51-54` |
| Production | `CODEOWNERS` ne couvre ni `infra/ansible`, ni `infra/noeud`, ni `infra/systemd`, ni `infra/nftables`, ni `infra/freeradius` | `.github/CODEOWNERS` |

---

## Jugé sain par les relecteurs (preuves lues)

- **Argent** :
  - seul un statut lu chez MoneyFusion crée un ticket ; la ligne du paiement est verrouillée (`FOR UPDATE`) et les états finaux sont intouchables ;
  - le lien API et la page de paiement sont forcés sur des domaines `moneyfusion.net`, en https : ni SSRF ni redirection ouverte ;
  - le SQL est entièrement paramétré.
- **Authentification** :
  - la 2FA est exigée, sans rejeu possible ;
  - chiffrement GCM avec nonce aléatoire ;
  - en-tête CSRF exigé et cookie `SameSite=Strict` ;
  - `X-Forwarded-For` est remplacé par nginx ;
  - aucun HTML brut injecté ; CSV et PDF échappés.
- **SQL** :
  - toutes les fonctions `SECURITY DEFINER` fixent `search_path`, et aucun SQL dynamique n'est dangereux ;
  - la RLS couvre toutes les tables ;
  - le grand livre est en ajout seul, avec des clés d'idempotence.
- **RADIUS** :
  - le routeur est déduit de l'IP source seule, et le ticket est toujours cherché par (propriétaire, code) ;
  - Message-Authenticator exigé ;
  - `AllowedIPs` en /32 exact.
- **RouterOS** :
  - échappement des chaînes ;
  - jetons de 256 bits, à usage unique ;
  - `check-certificate=yes` partout ;
  - le planificateur n'a ni le droit `policy` ni le droit `ftp`.
- **Production** :
  - TLS 1.2 et 1.3 ;
  - PostgreSQL et RADIUS ne sont pas exposés sur l'interface publique ;
  - sauvegardes chiffrées ;
  - la CI ne s'exécute qu'en `pull_request`, avec des actions épinglées par SHA et sans aucun secret.

## Ordre de correction proposé

1. **P1 à P4** : petits correctifs Ansible et systemd, avec un banc qui reproduit chaque échec avant correction (sans `chmod` ni journal dans `/tmp`).
2. **A1, A2, U1, U2** et le minimum de 100 F : code API, relu par un second agent (règle 4).
3. **R1** : une décision de conception est à prendre (activation au premier Accept ou alerte) ; ADR à écrire.
4. **O1** : procédure par `html-directory` distinct (ADR 0012 §9), puis script et guide.
5. **S2, S3, R2, P5** et les mineurs.
