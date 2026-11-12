# ADR 0012 — Contrats de la phase 2 : enrôlement, wg-agent, cloisonnement

- **Statut** : **accepté le 12/11/2026, par délégation de Yacouba** (« finis le travail », sans question ni essai intermédiaire). Les points marqués **[LABO]** restent à prouver sur CHR avant tout enrôlement réel.
- **Références** : `docs/SPEC.md` §4, §6, §9, §10.1, §13, §14.4 ; ADR 0003, 0006, 0008 ; ticket `.scratch/phase-2-multi-proprietaires/issues/01-contrats.md`.

## 1. `wg-agent`

Trois formes comparées (§14.4) :

| Forme | Pour | Contre |
|---|---|---|
| A. Démon Go, `wgctrl`, `LISTEN/NOTIFY` + tour périodique | Un binaire statique ; ne touche que les pairs, **jamais la clé privée** ; réveil immédiat ; parle au noyau ou à wireguard-go par la même API | Un langage de plus dans le dépôt |
| B. Module du worker TypeScript qui appelle `wg set` | Une seule pile | Le worker dépend de Redis et de l'API : une panne de l'un bloquerait les révocations ; une commande par pair |
| C. Script `wg syncconf` lancé par un timer | Très court | Exige un fichier complet, **clé privée comprise**, réécrit à chaque tour ; délai du timer pour une révocation |

**Retenu : A**, en Go (`golang-pro`, tests `-race`). Contrat :

- Lecture des pairs voulus : `app.wg_pairs()` → `(public_key text, overlay_ip inet)` des routeurs **actifs** ayant une clé. Rôle `wk_wg` : EXECUTE sur cette seule fonction, connexion, rien d'autre.
- Réveil : `NOTIFY wakatnet_pairs` posé par un déclencheur sur `app.router` (insertion, changement de clé, d'adresse ou d'`actif`) ; tour périodique toutes les 30 s en filet.
- Application : `ConfigureDevice` avec `ReplacePeers = false` ; pairs ajoutés ou mis à jour avec `AllowedIPs` = **exactement** le /32 du routeur (`ReplaceAllowedIPs = true`) ; pairs absents de la base retirés (`Remove = true`). L'interface n'est jamais recréée, et la clé privée n'est jamais lue.
- **Garde anti-effacement** : une erreur de lecture ne retire rien. Plus de `max(5, 20 %)` retraits en un tour : rien n'est retiré, et une ANOMALIE est journalisée, sauf si `WAKATNET_WG_RETRAIT_MASSIF=1` est posé à la main. Les ajouts passent toujours.
  - **[précisé au ticket 05, 12/11/2026]** Un résultat vide suit la **même** règle. La première version retenait tout retrait quand la base ne rendait aucun pair. Le test de la boucle l'a montré : on ne pouvait alors pas révoquer le **dernier** routeur d'un nœud. Une base vide ou erronée coupe désormais au plus 5 routeurs, ou 20 %.
- Journal : une ligne par pair ajouté ou retiré (clé publique tronquée, adresse), jamais de clé privée.

## 2. Plan d'adressage de l'overlay (D8)

- `10.213.0.0/16`. Plages réservées : `10.213.0.0/24` (plateforme : nœud A `.1`, nœud B `.2`, nœud de test `.3`) et `10.213.255.0/24` (essais et test de fumée).
- Routeurs : `10.213.1.1` à `10.213.254.254`, en sautant les octets de fin `.0` et `.255` (64 516 adresses).
- Allocation par `app.enroll_register` : la plus petite adresse libre, sous un verrou consultatif de transaction. **Jamais de réemploi** : un routeur révoqué garde sa ligne et son adresse. Une adresse réemployée pourrait recevoir les CoA, les sessions ou le client dynamique encore en cache d'un ancien routeur.

## 3. Jeton d'enrôlement

- 32 octets aléatoires, encodés en base64url (43 caractères). Stocké **seulement** sous forme d'empreinte SHA-256 (`app.enrollment_token.empreinte`), avec propriétaire, site, `expire_le` (création + 30 min), `consomme_le`, `routeur_id`.
- `GET /enroll/{jeton}` rend l'étape 1 sans consommer le jeton (un `/tool fetch` peut être rejoué). `POST /enroll/{jeton}` le consomme dans la transaction qui crée le routeur (`UPDATE … WHERE consomme_le IS NULL AND expire_le > now() RETURNING`) : deux POST concurrents donnent un seul routeur.
- Jeton inconnu, expiré ou consommé : même réponse 404, même corps.
- Le jeton figure dans une URL : les journaux de l'API **masquent** le chemin `/enroll/*`. Ce risque résiduel est accepté, car le jeton est à usage unique et vit 30 minutes.

## 4. Contrat HTTP de l'enrôlement

Décrit dans `apps/api/openapi.yaml` (OpenAPI 3.1), vérifié par les tests du ticket 03.

- `POST /v1/sites/{site_id}/enrollments` → 201 `{ commande, expire_le }`.
- `GET /enroll/{jeton}` → 200 `text/plain` (script de l'étape 1).
- `POST /enroll/{jeton}`, corps JSON produit par `:serialize to=json` sur le routeur **[LABO]** (disponible depuis RouterOS 7.13 d'après le journal des modifications ; il échappe les guillemets d'un nom d'identity) :
  `{ "cle": base64 32 octets, "identity", "modele", "version", "hotspots": [{ "serveur", "profil", "use_radius", "html_directory" }] }`
  plus `listen_port`, `coa_port` et `coa_accept` (relevés pour le pare-feu, le CoA et la désinstallation)
  → 200 `text/plain` (script de l'étape 2). Le jeton n'est **pas** consommé dans les cas suivants : 422 (clé invalide, version inférieure à 7.15, profil déjà en `use-radius=yes`), 409 (clé déjà enrôlée), 503 (aucun nœud configuré, overlay plein).
- **[complété au ticket 07, revue Spec]** Routes du propriétaire ajoutées par les tickets suivants : `POST /v1/routers/{id}/revoke` (ticket 06), `GET /v1/routers/{id}/uninstall.rsc` (ticket 04), `POST /v1/imports/mikhmon` (ticket 07). Toutes répondent 401 sans identité et 403 pour un propriétaire suspendu. `openapi.yaml` fait foi pour le détail.
- Le secret RADIUS (32 caractères alphanumériques, tirés côté base par `gen_random_bytes`) n'apparaît que dans la réponse de l'étape 2, sur TLS. Il n'est ni journalisé, ni réaffiché.
- L'inventaire (profils hotspot et leurs valeurs d'origine) est conservé (`app.router.inventaire`, JSON) : il sert à générer un `wakatnet-uninstall.rsc` propre à chaque routeur, qui restaure les valeurs d'origine.

## 5. Schéma `app` et Prisma : amendement de l'ADR 0008

**Écart avec le §9 de la spec et avec l'ADR 0008 §1, assumé.** L'ADR 0008 prévoyait que Prisma reprenne seul les migrations de `app` en phase 2. Ce ne serait pas sûr :
- les fonctions `radius.*` (SECURITY DEFINER) lisent les tables de `app`. Deux outils de migration avec deux historiques ne peuvent pas garantir l'ordre « colonne `app` ajoutée, puis fonction `radius` qui l'utilise » ;
- la RLS, les contraintes `CHECK`, les déclencheurs et les droits par rôle ne s'expriment pas dans le schéma Prisma. Ils finiraient de toute façon en SQL brut dans les migrations Prisma.

**Retenu** : un **seul** historique, `infra/sql/` appliqué par `migrer.sh`. Prisma est le **client** de l'API : `apps/api/prisma/schema.prisma` est produit par `prisma db pull` et versionné. Un test échoue s'il diverge de la base migrée.

## 6. Cloisonnement (I1, I2)

- Rôle `wk_api` (LOGIN, **non** propriétaire des tables) : droits DML sur les seules tables qu'il utilise, aucun droit sur `radius`, ni sur `ledger`.
  - **[précisé au ticket 07]** `wk_api` peut modifier la seule colonne `actif` d'un routeur (révocation, migration 0016). Il ne lit ni `plan` ni `voucher`, puisqu'un code de ticket vaut accès ; ces droits sont retirés par la migration 0017. L'import passe par `app.voucher_importer`, qui prend le propriétaire dans le contexte RLS.
- RLS activée sur `app.site`, `app.router`, `app.plan`, `app.voucher`, `app.audit_log` et `app.enrollment_token`. Politique : `tenant_id = nullif(current_setting('wakatnet.tenant_id', true), '')::bigint`. **Sans contexte, aucune ligne**. Ce n'est pas une erreur, c'est zéro ligne : un oubli fuit vers le vide, pas vers tout.
- L'API ouvre une transaction par requête et y pose le contexte par `set_config('wakatnet.tenant_id', $1, true)` (portée de la transaction : pas de fuite entre deux requêtes partageant une connexion du pool).
- Les fonctions `radius.*` et `app.enroll_register` appartiennent à `wakatnet_owner`, qui n'est pas soumis à la RLS (pas de `FORCE ROW LEVEL SECURITY`) : la matrice T ne change pas.
- `app.tenant` n'a pas de RLS : `wk_api` n'y a que `SELECT (id, suspendu)`, filtré dans le code par l'identité du propriétaire.

## 7. Identité du propriétaire avant la phase 4

L'authentification des propriétaires arrive avec le tableau de bord (phase 4). En attendant, l'API lit l'en-tête `X-Wakatnet-Tenant` **seulement** si `WAKATNET_AUTH_DEV=1`. Au démarrage, si `NODE_ENV=production` et `WAKATNET_AUTH_DEV=1` sont posés ensemble, l'API **refuse de démarrer** (test). Sans cet en-tête, la réponse est 401. Les routes `/enroll/*` n'en ont pas besoin : le jeton tient lieu d'identité.

## 8. Pare-feu du nœud

Fichier `infra/nftables/wakatnet.nft`, table `inet wakatnet`, chargé par le service nftables du nœud :
- `forward` : `iifname "wg0" drop`. Aucun transfert depuis le tunnel, vers le tunnel ou ailleurs : deux propriétaires ne se voient jamais, et un routeur ne peut pas sortir par le nœud.
- `input` depuis `wg0` : UDP 1812 et 1813, ICMP echo-request ; tout le reste est rejeté.
- `output` vers `wg0` : UDP 1700 et 3799, ICMP. Les réponses RADIUS (port source 1812/1813) passent par l'état `established`.
- La table ne touche pas aux autres interfaces : l'accès d'administration du nœud reste réglé ailleurs (phase 5).

## 9. Script RouterOS : choix de prudence

- **Additif** (R2) : la règle de pare-feu `input` (UDP 1700/3799 et ICMP depuis `wg-wakatnet`, sources 10.213.0.1 et 10.213.0.2) est insérée **avant** la première règle de la chaîne (`place-before`). Les règles existantes gardent leur ordre relatif.
- `login-by` du profil n'est **pas** modifié, contrairement à l'exemple illustratif du §6.2 : http-chap et http-pap sont déjà les valeurs par défaut, et le changer modifierait le comportement des utilisateurs locaux. Les valeurs posées sont `use-radius=yes`, `radius-accounting=yes` et `radius-interim-update=received` (l'intervalle vient de l'Accept, ADR 0006 §5).
- Un profil déjà en `use-radius=yes`, ou une entrée `/radius` `service=hotspot` non marquée `wakatnet`, fait **échouer** l'étape 1 avec un message. La plateforme ne cohabite pas avec un autre serveur RADIUS.
- **[ajouté après la revue Spec]** Deux règles `accept` sont posées hors de l'interface du tunnel, chacune limitée à l'IP publique du nœud, à son port source et au port d'écoute WireGuard du routeur. Elles laissent passer les paquets WireGuard du nœud : une chaîne `input` sans règle `established` les jetterait, et le tunnel ne monterait pas. Une règle accepte aussi les réponses RADIUS (ports source 1812 et 1813) depuis le tunnel, pour la même raison. C'est le **strict nécessaire** de l'exigence 3 du §6.2 : aucune règle n'ouvre l'administration du routeur.
- **[ajouté après la revue Spec]** Le walled garden du §6.2 n'est pas posé en phase 2 : il sert le portail de paiement (ticket 3.3), dont l'adresse n'existe pas encore.
- **[ajouté après la revue Spec, à confirmer par Yacouba]** Un routeur doit avoir un serveur hotspot configuré avant l'enrôlement : l'étape 1 s'arrête sinon, avec un message. Le « CHR vierge » de la porte du §12 s'entend donc comme un CHR avec hotspot, mais sans utilisateur ni réglage préalable.
- Les scripts sont en ASCII, sauf les valeurs recopiées du routeur, comme un nom de profil accentué : elles doivent rester exactes pour que `[find where name=…]` les retrouve.
- `login.html` est livré par le ticket 04, mais n'est **pas** installé par l'enrôlement en phase 2 : remplacer la page d'un propriétaire n'est pas additif. Son installation, dans un répertoire distinct (`html-directory`), relève du portail (ticket 3.3). La valeur d'origine est dans l'inventaire.
- **[LABO]** à trancher sur CHR : `:serialize to=json` ; détection d'un conflit avec `10.213.0.0/16` (`/ip address`, `/ip route`) ; lecture de `last-handshake` ; `place-before` sur une chaîne vide ; LABO-08 (vérification TLS de `/tool fetch`).

## 10. Import Mikhmon

- CSV avec en-tête, colonnes `name`, `password`, `profile` (les autres sont ignorées), et une table de correspondance « profil → forfait » fournie par le propriétaire.
- Ticket importé : `origine = 'import'`, code = `upper(name)`, motif accepté `^[0-9A-Z]{4,32}$`. Les symboles ambigus (0, O, 1, I, L) sont admis, puisque ces tickets sont déjà imprimés. Les tickets générés par la plateforme gardent l'alphabet de 31 symboles.
- Refusés, avec leur motif dans le rapport : `name` ≠ `password` (casse ignorée), caractères hors `[0-9A-Za-z]`, longueur hors 4–32, profil sans correspondance. Un code déjà présent chez ce propriétaire n'est pas un refus : il est rapporté comme **doublon**, ce qui rend l'import rejouable.
- Un seul appel SQL par fichier (`app.voucher_importer` reçoit des tableaux ; 20 000 lignes au plus). Le rapport compte les codes de moins de 8 caractères, plus faciles à deviner que ceux de la plateforme ; l'anti-devinette (ADR 0011) les protège comme les autres.
- Le comportement exact dépend de LABO-05 (utilisateurs locaux consultés avant RADIUS) : l'import reste disponible dans les deux cas. Il devient obligatoire avant l'activation si LABO-05 est négatif (§6.3).
