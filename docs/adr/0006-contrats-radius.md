# ADR 0006 — Contrats du cœur RADIUS (phase 1)

- **Statut** : **accepté par Yacouba le 11/11/2026** (ticket 01). Les points marqués **[accepté le 11/11/2026]** sont des écarts avec la spec ou des choix commerciaux, acceptés explicitement.
- **Références** : `docs/SPEC.md` §1.1, §4, §5, §10.1 ; `CONTRIBUTING.md` C1–C7, S1–S3 ; ADR 0001 à 0005 ; `docs/LABO.md` (E-FR-2, E-FR-4, L1–L9) ; `.scratch/phase-1-coeur-radius/`.
- **Révision du 11/11/2026** après une vérification adversariale dans le code source : constats 1d, 1e, 2a à 2c, 3c, 3d, 4b, 4c, 5b, 5c, 7b et 9a à 9h intégrés.
- **Faits vérifiés dans le code de FreeRADIUS 3.2.10** (tag `release_3_2_10`, lu le 11/11/2026) :
  - `rlm_detail.c` l. 347 écrit `Timestamp = request->timestamp`, l'instant de **réception** par radiusd. Le lecteur (`detail.c` l. 667) l'expose sous `Packet-Original-Timestamp`, mais pour son calcul interne il **préfère l'`Event-Timestamp` du routeur** (l. 891).
  - `auth.c`, `rad_postauth()` : un résultat `fail` en `post-auth` **transforme l'Accept en Reject**.
  - `rlm_sql` n'enregistre **aucun** processeur `map`, et `sql.c` l. 153 crée les attributs sans qualificatif de liste : une requête n'alimente qu'**une** liste.
  - `rlm_sql_postgresql.c` : `query_timeout` est un entier en **secondes**, appliqué aussi comme `connect_timeout`. Un dépassement provoque une **reconnexion puis un rejeu** de la requête (`sql.c`, `connection.c`).
  - `client.c` l. 1594 : pour un client dynamique, `require_ma` est **écrasé** par `FreeRADIUS-Client-Require-MA`. Si l'attribut est absent, la valeur est 0 : **le Message-Authenticator n'est pas exigé**.
  - `radiusd.conf` : `reject_delay = 1` par défaut. Le délai se règle par pas de 0,5 s, et 0 est accepté.
  - `sql.c` l. 80–168 : une ligne avec un attribut vide, une valeur NULL ou un attribut inconnu fait échouer **toute** la requête. Une valeur entièrement entourée d'apostrophes inverses est **évaluée** comme une expansion.
  - `listen.c` l. 276–286 : `rate_limit` vaut un nouveau client par seconde pour tout le bloc ; les autres paquets de la même seconde sont jetés. Le défaut est désactivé.

---

## 1. Signatures

Toutes les fonctions sont `SECURITY DEFINER`, avec `SET search_path = radius, pg_temp`. Leur propriétaire est `wakatnet_owner`. **EXECUTE est retiré à PUBLIC** sur chaque fonction (`REVOKE ALL … FROM PUBLIC`, et `ALTER DEFAULT PRIVILEGES` qui retire EXECUTE à PUBLIC), puis accordé à chaque rôle sur ses seules fonctions (C7). Les rôles n'ont que `USAGE` sur le schéma `radius`.

Instances `rlm_sql`, qui portent les connexions, et `rlm_sql_map`, qui portent les requêtes (§2, amendement du 11/11/2026) :
- `sql_clients` (`wk_radius`, pool propre) → `map_clients` : `client_lookup` ;
- `sql_auth` (`wk_radius`, pool propre) → `map_auth` : `authorize`. `post_auth` passe par `sql_auth` au ticket 07 ;
- `sql_acct` (`wk_acct`, pool propre) : `acct_*`.

| Fonction | Rôle | Contrat |
|---|---|---|
| `radius.client_lookup(p_src text) RETURNS TABLE(ip text, secret text, shortname text, virtual_server text, require_ma text)` | `wk_radius` | Appelée par `map_clients` dans le serveur `dynamic_clients` : **une seule requête**, et `fail` en cas d'erreur. Pour le routeur **actif** dont l'IP overlay est `p_src`, elle renvoie **une ligne**. Ses colonnes vont dans `control:FreeRADIUS-Client-IP-Address`, `-Secret`, `-Shortname`, `-Virtual-Server` et **`-Require-MA`, toujours présent et jamais NULL** (`yes` par défaut ; `no` seulement par exception tracée dans `router.require_ma_exception` et le journal d'audit, ADR 0003). Routeur inconnu ou inactif : aucune ligne, donc aucun client et aucune réponse. |
| `radius.authorize(p_user text, p_src text, p_calling text, p_called text) RETURNS TABLE(cleartext_password text, decision text, reply_message text, session_timeout bigint, rate_limit text, port_limit int, interim int)` | `wk_radius` | **Lecture seule** (`STABLE`). Renvoie **une ligne**, dont les colonnes sont associées aux attributs par `map_auth` (§2) : une seule requête par Access-Request. Ne lève jamais d'exception à cause d'une donnée : tout cas inattendu donne un refus codé. Enveloppe de `radius._authorize_at(…, p_now)` (ADR 0007). |
| `radius.post_auth(p_user text, p_src inet, p_calling text, p_result text, p_cause text) RETURNS void` | `wk_radius` | Écrit dans `auth_log` : routeur, MAC, résultat, cause, `voucher_id` si le code existe pour ce propriétaire, sinon NULL. **Jamais le code.** Pose la liaison `bind_mac` au premier Accept (§9). |
| `radius.acct_start / acct_interim / acct_stop(p_src text, p_session_id text, p_user text, p_calling text, p_framed_ip text, p_in_oct text, p_in_giga text, p_out_oct text, p_out_giga text, p_session_time text, p_cause text, p_received_epoch text) RETURNS text` | `wk_acct` | Idempotentes (§8). **Tous les paramètres sont en `text`** et analysés dans la fonction : une conversion impossible (chaîne vide, valeur invalide) envoie la ligne en quarantaine **au lieu** de faire échouer l'appel SQL, ce qui bloquerait le lecteur sans fin. `p_received_epoch` = `%{integer:Packet-Original-Timestamp}`. Renvoient `'ok'` ou `'quarantaine'`. |
| `radius.acct_on_off(p_src text, p_received_epoch text) RETURNS text` | `wk_acct` | Ferme les sessions de l'**époque courante** du routeur, puis incrémente l'époque (§8). Le critère est l'époque et non l'instant, parce que l'instant est arrondi à la seconde. |
| `radius.close_ghost_sessions() RETURNS int` | `wk_maint` | Sessions fantômes (§8). |
| `radius.purge_auth_log() RETURNS bigint` | `wk_maint` | Suppression au-delà de 90 jours (ADR 0005). Idempotente. |
| `radius.sessions_to_cut() RETURNS TABLE(…)` et `radius.mark_cut(p_session bigint, p_result text)` | `wk_coa` | Sessions à couper (volume épuisé, suspension, remboursement) (§6). |
| `radius.coa_target(p_session bigint) RETURNS TABLE(nas_ip inet, coa_port int, secret text, acct_session_id text, username text)` | `wk_coa` | **Seule** fonction qui renvoie le secret d'un routeur à partir d'un identifiant de session. |

Correspondance avec la matrice T :

| Ligne | Fonctions |
|---|---|
| T1, T4, T6 | `authorize` |
| T2 | `authorize` + `acct_start` |
| T3, T12 | `authorize` + `acct_interim` |
| T5 | `authorize` (sessions + Accept récents) + `post_auth` |
| T7 | `acct_stop` |
| T8 | `close_ghost_sessions` + `acct_on_off` |
| T9 | `sessions_to_cut` + `coa_target` |
| T10 | configuration `dynamic_clients` + `client_lookup` |
| T11 | `authorize` + `post_auth` |

## 2. Un seul appel SQL par Access-Request

**Amendement du 11/11/2026, ticket 02.** La recopie de `control` vers `reply` est remplacée par le module **`rlm_sql_map`** de FreeRADIUS 3.2.10 (`mods-available/sql_map`, `rlm_sql_map.so`). Raisons, lues dans `src/modules/rlm_sql_map/rlm_sql_map.c` (tag `release_3_2_10`) :
- une requête, et les colonnes de **la** ligne renvoyée sont associées, par leur numéro, à des attributs de **n'importe quelle liste** (`control`, `reply`). La décision et les valeurs viennent donc du même instantané, sans recopie `unlang` ;
- **valeur illisible : ignorée**, avec un avertissement, **sans faire échouer** la requête (l. 186–193). Le piège de `rlm_sql`, où une ligne malformée fait échouer toute la requête, disparaît ;
- **Correction du 11/11/2026, observée en exécution au ticket 02** : le module ignore bien une colonne NULL (l. 174), mais **le pilote PostgreSQL de FreeRADIUS rend une colonne NULL sous forme de chaîne vide**. La trace montrait `control:Auth-Type := 0` et `reply:Reply-Message := ""`. Il ne faut donc **jamais** compter sur NULL pour « attribut absent » ;
- **aucune évaluation** des valeurs (`fr_pair_value_from_str`) : l'injection par une valeur entourée d'apostrophes inverses, possible avec `rlm_sql`, disparaît ;
- erreur SQL → `fail` (l. 375–378) ; aucune ligne → `noop` (l. 353, 382).

Association pour `map_auth` (colonne → attribut) :

| Colonne | Attribut |
|---|---|
| 0 `cleartext_password` | `control:Cleartext-Password :=` |
| 1 `decision` | `control:Tmp-String-1 :=` (`Accept` ou `Reject`, **toujours explicite**) |
| 2 `reply_message` | `control:Tmp-String-2 :=` (cause du refus) |
| 3 `session_timeout` | `reply:Session-Timeout :=` |
| 4 `rate_limit` | `reply:Mikrotik-Rate-Limit :=` |
| 5 `port_limit` | `reply:Port-Limit :=` |
| 6 `interim` | `reply:Acct-Interim-Interval :=` |

- **Adaptation de transport dans le site `wakatnet`, sans logique d'accès (C2)** :
  - `decision = 'Reject'` : `Auth-Type := Reject`, puis `Reply-Message` prend la valeur de la cause ;
  - ni `Accept` ni `Reject` (ligne absente) : refus par défaut ;
  - une chaîne vide dans `Mikrotik-Rate-Limit` est retirée ;
  - les entiers vides (`Session-Timeout`…) ne passent pas l'analyse et sont donc ignorés.
- Code inconnu : `authorize` renvoie une ligne de refus (`decision = 'Reject'`, `reply_message = 'ticket_inconnu'`), et non zéro ligne, pour que la réponse soit explicite.
- Garde-fous conservés : contrainte `CHECK` en base sur `rate_limit` (`^[0-9A-Za-z/ .:-]+$`) ; une colonne d'attribut de réponse est **NULL** en cas de refus. Un test de propriétés vérifie qu'un refus ne porte jamais d'attribut d'Accept.
- La configuration `rlm_sql` des instances `sql_clients` et `sql_auth` ne définit **aucune** requête `authorize_*` : elles ne servent qu'à porter les pools.
- **À prouver en exécution au ticket 02.**

## 3. Clé de recherche

- IP source → routeur actif → **propriétaire** et **site**.
- Ticket recherché par `(tenant_id, code)` ; jamais par le code seul (T6).
- `Called-Station-Id` est journalisé, jamais utilisé pour décider.

## 4. Causes de refus (`Reply-Message`, texte exact)

| Cause | Quand |
|---|---|
| `ticket_inconnu` | Aucun ticket `(propriétaire, code)`, **ou mauvais mot de passe** **[accepté le 11/11/2026]** : une seule cause, pour ne pas révéler qu'un code existe. |
| `expire` | Validité écoulée, ou expiration absolue dépassée (même jamais activé). |
| `epuise` | Temps consommé ≥ limite, ou volume ≥ limite, ou `Session-Timeout` calculé ≤ 0. |
| `mauvais_site` | Ticket limité à un site, présenté sur un routeur d'un autre site du même propriétaire. |
| `trop_d_appareils` | Nombre d'appareils atteint (§9), ou `bind_mac` violé. |
| `proprietaire_suspendu` | Suspension **administrative** par le super-admin. **Jamais** l'état du solde de crédits (ADR 0001 et 0002). |
| `trop_de_tentatives` | Limitation anti-devinette (§11). |

Ordre d'évaluation : `trop_de_tentatives` → `ticket_inconnu` → `proprietaire_suspendu` → `mauvais_site` → `expire` → `epuise` → `trop_d_appareils`.

- **Mauvais mot de passe.** `authorize` ne peut pas le voir, puisque PAP ou CHAP décident ensuite. Dans `Post-Auth-Type REJECT` : si `reply:Reply-Message` est absent, il prend la valeur `ticket_inconnu`. On garde `attr_filter.access_reject`, qui retire les attributs d'Accept déjà recopiés.
- **PAP** : `User-Name` et `User-Password` passent en majuscules (`%{toupper:…}`) avant `pap`. **CHAP** : la mise en majuscules se fait dans `login.html` (§15).
- **`reject_delay = 0`** : le défaut de 1 s dépasse le `timeout` de RouterOS (1100 ms). Le routeur basculerait sur B et afficherait « serveur injoignable » au lieu de la cause. L'anti-devinette est assurée par `trop_de_tentatives` (§11). Testé au ticket 02.

## 5. Attributs de réponse

| Attribut | Décision |
|---|---|
| `Session-Timeout` | min(temps restant, fin de validité − maintenant, expiration absolue − maintenant), en secondes entières, ≥ 1 ; sinon `epuise` ou `expire`. |
| `Mikrotik-Rate-Limit` | Copie figée du forfait, si définie. |
| `Port-Limit` | `devices` du forfait. |
| `Acct-Interim-Interval` | **120 s** **[accepté le 11/11/2026]**. Le dépassement de volume vaut au plus débit × 120 s, par exemple 30 Mo à 2 Mbit/s. Valeur globale réglable. Le script d'enrôlement (ticket 2.3) doit poser `radius-interim-update=received`, ou 2m, de façon cohérente (LABO-19). |
| `Idle-Timeout` | **Non envoyé** en v1 : le profil hotspot du routeur garde le sien. Champ du forfait réservé pour plus tard. |
| `WISPr-Session-Terminate-Time` | **Écarté** : il dépend de l'horloge du routeur (règle 5), et `Session-Timeout` intègre déjà l'expiration absolue. |
| `Mikrotik-Recv-Limit` / `Mikrotik-Xmit-Limit` (+ Gigawords) | **Non envoyés** en v1 : les forfaits n'ont qu'un volume total. **[accepté le 11/11/2026] Écart avec le §5.3**, qui demande d'envoyer les restes de volume : contrôle côté serveur à la place (§6). Ces attributs restent réservés aux forfaits à sens séparés. |
| `Mikrotik-Total-Limit` | Non utilisé ([LABO]). |

## 6. Volume total

Contrôle côté serveur. `acct_interim` détecte l'épuisement et inscrit la session « à couper ». Le déclencheur (§17) émet le Disconnect. **Écart assumé avec la formulation de T12** (« limite restante envoyée ») : T12 est vérifié par l'Accept, puis par une coupure en moins d'un intervalle d'Interim (tickets 05 et 09).

## 7. Horloges

- **Décision d'accès** : `now()` de PostgreSQL (règle 5).
- **Événements d'accounting** : `Packet-Original-Timestamp`, c'est-à-dire l'instant de **réception** par radiusd. En production, radiusd et PostgreSQL tournent sur le même nœud, synchronisé par NTP. Le serveur virtuel de rejeu passe **explicitement** cet attribut en `p_received_at`. On n'utilise jamais l'heure du rejeu, ni l'`Event-Timestamp` du routeur.
- Passage à SQL : `%{integer:Packet-Original-Timestamp}` (époque en secondes), converti par `to_timestamp` dans la fonction. Précision : une seconde.
- **Précision proposée pour C4 et pour la règle 5 du §4** : « L'heure du routeur n'est jamais utilisée pour décider. Les décisions d'accès utilisent `now()` de la base ; les événements d'accounting sont datés à leur réception par le nœud, qui partage l'horloge de la base. »

## 8. Accounting : idempotence, compteurs, fantômes

- **Clé** : `(router_id, router_epoch, acct_session_id, username)`, dans une table de clés **non partitionnée** (ADR 0008). L'époque est incrémentée à chaque Accounting-On / Off, ce qui protège contre la réutilisation de `Acct-Session-Id` après redémarrage (LABO-18). Le `username` dans la clé fait qu'un même identifiant réutilisé pour un autre ticket ouvre une session distincte. L'anomalie est journalisée.
- **Start sur une clé existante** : rejeu, sans effet.
- **Compteurs** : total = max(total déjà vu, giga × 2^32 + octets), en BIGINT, pour chaque sens. Le temps est le max de `Acct-Session-Time`. Le sens entrée / sortie est réglé dans `radius.parametre` (C2), avec une valeur par défaut non vérifiée.
- **Activation** au premier Start, à `p_received_at`.
- **Interim ou Stop après une fermeture d'office** : compteurs mis à jour, session non rouverte.
- **Session fantôme** : `close_ghost_sessions` ferme une session dont le dernier événement **reçu** date de plus de 3 × l'intervalle mémorisé sur la session. Il n'est appelé **que si le `detail` est vidé** (§17).
- **Activation et frais papier** : l'activation inscrit un événement idempotent, lu en phase 3 par le grand livre (ADR 0002). `wk_acct` n'a jamais de droit sur `ledger`.

## 9. Appareils simultanés et `bind_mac`

- **Compte** = sessions ouvertes du ticket + Accept dans `auth_log` sans Start correspondant, sur une fenêtre de 60 s **prolongée du retard courant du lecteur `detail`**. Ce retard est mesuré par un battement que le lecteur inscrit à chaque enregistrement. La fenêtre de course résiduelle (deux Access-Request à moins d'un aller-retour d'écart) est documentée et testée.
- **`bind_mac`** (option du forfait) : posé par `post_auth` au premier Accept, et aussi par `acct_start` s'il manque. Une MAC différente donne `trop_d_appareils`. La MAC n'est jamais la seule clé : le code reste exigé. Les MAC aléatoires sont une limite connue (§11 de la spec). La remise à zéro par le propriétaire arrive en phase 4.

## 10. `post_auth` sans effet sur la réponse

- Dans `post-auth` et dans `Post-Auth-Type REJECT` : `sql_auth { fail = 1 }` (appel de `post_auth`), suivi d'un `ok` **inconditionnel** en fin de section. Mécanisme vérifié dans `modcall.c` : la section rend `ok`. **À prouver en exécution au ticket 07.**
- **Mode dégradé assumé** : l'écriture est synchrone. Sur le nœud B en lecture seule (T13), elle échoue tout de suite sans changer la réponse. Mais `auth_log` et `bind_mac` ne sont alors pas écrits, si bien que l'anti-devinette et le compte d'appareils sont affaiblis tant que B tourne seul. Le retard dû à une base lente est borné par `statement_timeout` (§13).
- Accept et Reject sont journalisés.
- `auth_goodpass = no`, `auth_badpass = no`. Aucun code en clair dans `auth_log` ni dans `radius.log`.

## 11. Anti-devinette

- Contrôle **en tête** de `authorize`, avant la recherche du ticket.
- **Par MAC** : 10 échecs en 60 s donnent un blocage de 5 min (`trop_de_tentatives`).
- **Par routeur** : 100 échecs en 60 s donnent une **alerte seule**, sans blocage, pour éviter de couper tout un hotspot.
- Les refus `trop_de_tentatives` ne comptent pas comme échecs.
- Index `auth_log(router_id, calling_station, at)`. Seuils réglables.
- **Ordre de grandeur de l'attaque restante**, en changeant de MAC à chaque essai, bornée par le seul débit :
  - à 10 essais par seconde contre un propriétaire qui a 10 000 tickets valides, l'espérance avant de tomber sur un ticket valide est de 31^8 / 10 000 ≈ 8,5 × 10^7 essais, soit environ 98 jours ;
  - l'alerte par routeur (100 échecs par minute) se déclenche dès la première minute ;
  - le super-admin peut alors bloquer le routeur.

## 12. Lecteur `detail`

- Serveur virtuel `rejeu_accounting` (`listen { type = detail }`).
- Instance `sql_acct` : rôle `wk_acct`, pool à elle, distinct de l'authentification. Paramètres passés en texte (§1).
- Module `detail` avec `locking = yes`.
- Erreur de donnée : ligne copiée dans `radius.acct_quarantaine`, retour `ok`, la file continue. Seule l'indisponibilité de la base renvoie `fail`, et le lecteur réessaie.
- Garde de version : FreeRADIUS ≥ 3.2.10, jamais 3.2.9 (#5870).

## 13. Base indisponible

- `authorize` est encadré par `map_auth { fail = 1 }` suivi de `if (fail) { do_not_respond }` (mécanisme vérifié dans `modcall.c` et `auth.c`). Pour `client_lookup`, un `fail` de `map_clients` donne déjà « pas de client, donc paquet ignoré » (`listen.c` l. 338–353), sans autre configuration.
- Puisque `authorize` et `client_lookup` ne lèvent jamais d'exception à cause d'une donnée, un `fail` ne vient que d'une indisponibilité, d'un délai dépassé ou d'un **défaut de déploiement**. Ce dernier cas est intercepté par le test de fumée exécuté après chaque migration (ticket 08).
- **Délais**, énoncés honnêtement :
  - **Borne principale** : `ALTER ROLE wk_radius SET statement_timeout = '500ms'`. Un dépassement donne le code 57014, classé **sans reconnexion**, donc un `fail` immédiat. Les connexions déjà ouvertes gardent l'ancienne valeur jusqu'au redémarrage de radiusd.
  - `query_timeout = 1` (minimum du pilote, en secondes). Son dépassement (base qui ne répond plus du tout) provoque une reconnexion et un rejeu. Avec libpq, qui arrondit `connect_timeout` à au moins 2 s (d'après sa documentation, non vérifié dans le code), le **pire cas dépasse le `timeout` de RouterOS**.
  - Le pool est réglé pour le limiter (`max_retries` bas). Le pire cas réel est **mesuré** au ticket 08 et comparé au `timeout` retenu par LABO-09.
- **Risque assumé** : `client_lookup` s'exécute dans le fil de **réception** de FreeRADIUS. Une base lente bloque donc la réception de tous les paquets pendant la création d'un nouveau client. Le risque est mesuré au ticket 10.
- Compteur des `do_not_respond` (module `linelog` local), lu par la supervision (§10.3).
- **Provisoire jusqu'à LABO-16.**

## 14. Secrets

- **Mots de passe des rôles PostgreSQL** : lus par `$ENV{}`, depuis un `EnvironmentFile` systemd réservé à root, jamais versionné (S1, S2).
- **Secret RADIUS de chaque routeur** : stocké **en clair** dans une table lisible seulement par `wakatnet_owner`, exposé uniquement par `client_lookup` et `coa_target`. Protection : séparation des rôles, chiffrement du volume du nœud, sauvegardes chiffrées.
  - **[accepté le 11/11/2026] Écart avec S3 et §10.1.** RADIUS doit utiliser ce secret en clair à chaque paquet. Une clé de chiffrement accessible à la base serait stockée et sauvegardée **avec** les données qu'elle protège : elle n'ajouterait presque rien. Passer la clé dans la requête la ferait apparaître dans les journaux.
  - Les clés API des agrégateurs (phase 3) restent, elles, chiffrées par une clé détenue par l'API.

## 15. Codes de ticket

- **[accepté le 11/11/2026] Alphabet de 31 symboles** : `23456789ABCDEFGHJKMNPQRSTUVWXYZ`. Le §5.5 annonce 32 symboles, mais en retirant 0, O, 1, I et L des chiffres et majuscules, il n'en reste que 31.
  - Avec 8 caractères : 31^8 ≈ 8,5 × 10^11 combinaisons, environ 39,6 bits. C'est l'ordre de grandeur visé (10^12).
  - Avec 9 caractères : 2,6 × 10^13. Option possible si Yacouba préfère.
- **Tirage** : `gen_random_bytes` (pgcrypto), par rejet des octets ≥ 248 (= 31 × 8), puis modulo 31. Aucun biais. `random()` est interdit.
- **Casse** : les codes sont stockés en majuscules. En CHAP, le serveur ne peut pas normaliser, puisque le hachage est calculé dans le navigateur : `login.html` met donc la saisie en majuscules **avant** le hachage (tickets 2.3 et 3.3). En PAP, le serveur met en majuscules.
- **Identifiant et mot de passe** : un ticket s'utilise avec le code comme identifiant **et** comme mot de passe, ce qui correspond à l'usage Mikhmon le plus courant **[accepté le 11/11/2026]**.
- **Unicité** : `UNIQUE (tenant_id, code)`.

## 16. Clients dynamiques : `rate_limit` et absence de cache négatif

- **`rate_limit = yes` écrit explicitement** dans le bloc client de l'overlay (il est désactivé par défaut). C'est une protection contre le déni de service. Conséquences :
  - après un redémarrage du nœud, un seul nouveau client est créé par seconde ; avec moins de 50 routeurs, la reprise prend environ 50 s, et les routeurs basculent sur B entre-temps ;
  - pendant la reprise, les paquets des routeurs pas encore recréés sont **jetés**, Accounting compris. RouterOS devrait les réémettre, mais c'est à vérifier.
  - À mesurer au ticket 10 (L8).
- Pas de cache négatif. Le risque est faible : seule une IP autorisée par un pair WireGuard (`AllowedIPs`) peut émettre dans l'overlay.

## 17. Planification et déclencheur de coupure (hors processus FreeRADIUS, règle 1)

- **Production** : timers systemd sur le nœud.
  - `wakatnet-fantomes` (toutes les 60 s) : rôle `wk_maint`. Il n'appelle `close_ghost_sessions()` **que si** le répertoire `detail` ne contient ni fichier en attente ni fichier `.work` modifié il y a plus de 5 s.
  - `wakatnet-purge` (quotidien).
  - `wakatnet-coupure` (toutes les 30 s) : rôle `wk_coa`. Il émet les Disconnect des sessions à couper.
- **Émetteur** : module TypeScript (Node 22), réutilisable par le futur worker.
  - Il appelle `radclient`, qui vérifie l'authentificateur de la réponse.
  - Le secret est passé par un fichier 0600 en tmpfs (`-S`), jamais en ligne de commande.
- **En dev** : les tests appellent directement les mêmes scripts. L'unité systemd est vérifiée par `systemd-analyze verify`, et son rejeu réel a lieu sur le nœud (phase 5).
