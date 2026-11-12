# Rapport de performance du cœur RADIUS (ticket 10)

- **Date** : 12/11/2026. **Ticket** : `.scratch/phase-1-coeur-radius/issues/10-performance.md`.
- **Rejeu** : `radius/tests/perf/perf.sh`, ou une seule partie avec `PHASES="debit serveur plans spool x10"`. Mesure sous attaque : `perf/attaque.sql` et `perf/attaque-sans-analyze.sql`, sur la pile de mesure. Résultats bruts : `perf/resultats/*.json` et `*.txt`.
- Tous les chiffres ci-dessous sont **mesurés**. Ceux qui ne le sont pas sont dits « estimé » ou « non mesuré ».

## 1. Matériel et conditions

- **Machine** : 4 vCPU Intel Xeon à 2,10 GHz, sans hyperthreading, 16 Go de mémoire, Docker 29.9.2. C'est un conteneur de session cloud, pas un nœud de production.
- **Épinglage** (`perf/compose.perf.yml`) : le serveur (FreeRADIUS 3.2.10 et PostgreSQL 16.15) sur les cœurs **0 à 2**, le générateur sur le cœur **3**.
  - **Écart avec le §5.6**, qui vise « 200 auth/s sur 4 vCPU » pour le serveur seul : ici, le serveur n'a que **3 vCPU**. La mesure est donc plus sévère que l'objectif.
- **Configuration** : celle de production (`infra/freeradius/`, migrations jusqu'à `radius/0011`), avec la durée de vie des clients de production (300 s).
  - `reject_delay = 0` : c'est déjà la valeur de production (ADR 0006), rien n'a été neutralisé pour la mesure.
- **Paquets** : CHAP **avec** Message-Authenticator, comme le hotspot MikroTik. Chaque réponse est vérifiée (authentificateur et Message-Authenticator) ; aucune réponse invalide n'a été reçue.
- **Générateur** (`perf/charge.py`) : en boucle ouverte, une socket par routeur liée à son IP overlay.
  - En mode Accept, chaque ticket revient toujours avec la même MAC (un appareil).
  - En mode Reject, la MAC est nouvelle à chaque requête : sans cela, l'anti-devinette bloquerait la MAC et on mesurerait le blocage, pas `authorize`.

## 2. Jeu de données (`perf/donnees.sql`)

| | 50 routeurs | Essai ×10 |
|---|---|---|
| Routeurs | 50 | 500 |
| Tickets (créés par `app.voucher_creer`) | 100 000 | 100 000 |
| Sessions ouvertes | 1 000 | 1 000 |
| `auth_log` (90 jours × 300 connexions par jour et par routeur) | 1 350 000 lignes | 13 500 000 lignes |
| Durée du chargement | 37 à 39 s | 599 s |

## 3. Débit et latence vue par le routeur (50 routeurs)

Paliers de 20 s, en boucle ouverte, journalisation des instructions coupée. La latence est mesurée par le générateur, de l'envoi à la réponse vérifiée.

| Débit visé | Accept : obtenu | perdus | p50 / p95 / p99 (ms) | Reject : obtenu | perdus | p50 / p95 / p99 (ms) |
|---|---|---|---|---|---|---|
| 100/s | 99,9/s | 0 | 3,1 / 4,9 / 13,6 | 99,9/s | 0 | 2,9 / 3,9 / 10,3 |
| **200/s** | **199,9/s** | **0** | 2,8 / **3,8** / 5,9 | **199,9/s** | **0** | 2,7 / **3,5** / 5,2 |
| 400/s | 399,9/s | 0 | 2,5 / 3,3 / 4,8 | 399,8/s | 1 | 2,6 / 3,4 / 5,0 |
| 800/s | 788,3/s | 229 (1,4 %) | 2,6 / 4,6 / 10,3 | 796,5/s | 66 (0,4 %) | 3,2 / 7,2 / 14,1 |

- **Objectif de 200 auth/s : atteint**, avec 3 vCPU, sans perte, et un p95 de 3,8 ms vu du routeur.
- **Plafond** : sans perte jusqu'à **400/s** ; à 800/s, les premières pertes apparaissent (1,4 % en Accept). On place donc le débit soutenable entre 400 et 800/s sur ce matériel. La limite exacte n'est pas cherchée plus finement.
- **Reject en mode Accept** (1 à 400/s, 2 à 800/s) : cause `trop_d_appareils`. C'est un **artefact du jeu de données**, pas un défaut du serveur. Les 1,35 million d'Accept de `auth_log` sont tirés au hasard sur 90 jours, avec des MAC aléatoires. Quelques-uns tombent dans la dernière minute (estimé : 1,35 M × 60 s / 90 jours ≈ 10) et comptent comme un second appareil pour le même ticket.

## 4. Durée côté serveur (`log_min_duration_statement = 0` pour `wk_radius`)

30 s à 200/s en Accept, puis 30 s en Reject ; durées lues dans le journal de PostgreSQL (`perf/durees.py`).

| Instruction | Mesures | p50 | **p95** | p99 | max |
|---|---|---|---|---|---|
| `radius.authorize` | 11 993 | 1,13 ms | **1,73 ms** | 2,22 ms | 24,3 ms |
| `radius.post_auth` | 11 994 | 1,19 ms | 2,01 ms | 3,25 ms | 86,4 ms |

- **Objectif « p95 d'`authorize` < 50 ms » : atteint**, à 1,73 ms. Mais **voir le §7** : sous attaque par devinette, ce coût peut croître jusqu'à l'objectif.
- **Coût de `post_auth`** : du même ordre qu'`authorize`. Il s'ajoute au temps de traitement de chaque requête, mais pas à la décision, puisque son échec est sans effet (ticket 07).
- **Pertes de la phase serveur** : 2 requêtes sur 5 999. Elles sont dues aux connexions de `wk_radius` que la mesure ferme volontairement pour appliquer le réglage de journalisation, et que `rlm_sql` rouvre. Elles ne disent rien du régime établi.
- La journalisation de chaque instruction ajoute elle-même un coût : ces durées sont un **majorant**.

## 5. Rattrapage du lecteur `detail`

Une heure de panne pour 1 000 sessions ouvertes, soit 30 Interim par session : **29 997 enregistrements**.

| | Mesure |
|---|---|
| Accounting-Response, base arrêtée | 29 997 sur 29 997, p95 **0,64 ms**, max 4,5 ms |
| Vidage du spool après le retour de la base | **107,7 s**, soit environ **280 enregistrements par seconde** |

- **Comparaison avec la perte de données maximale de 5 min visée (§10.2)** :
  - aucune donnée n'est perdue pendant la panne : les enregistrements sont sur disque, dans le spool, avant la réponse au routeur ;
  - le rattrapage d'une heure de panne prend **1,8 min**, moins que les 5 min ;
  - pendant ce rattrapage, les compteurs de temps et de volume sont en retard. Une session peut alors dépasser son forfait, comme le dit déjà l'ADR 0006 §6 (aucune borne sans débit, ou si le spool est en retard).
- **Limite** : les 1 000 sessions sont créées par leur premier Interim, ce qui est plus coûteux qu'une mise à jour. À 50 routeurs et quelques milliers de sessions, le rattrapage reste de l'ordre de quelques minutes (estimé, non mesuré au-delà de 30 000 enregistrements).

## 6. Essai ×10 : 500 routeurs

| | Mesure |
|---|---|
| Création des 500 clients dynamiques | 528 s, à un par seconde (`rate_limit = yes`) |
| 200/s pendant 30 s, juste après | 199,9/s, **0 perte**, p95 3,85 ms |
| 200/s pendant 60 s, 6 min plus tard | 200,0/s, **0 perte**, p95 3,81 ms |

- **La reprise après un redémarrage du nœud est lente.** Un seul nouveau client par seconde : 50 routeurs se recréent en environ 53 s, 500 en environ 9 min. Pendant ce temps, les routeurs pas encore recréés n'obtiennent aucune réponse et basculent sur B (ADR 0006 §16).
- **Hypothèse infirmée** : j'avais estimé qu'avec `lifetime = 300` et un nouveau client par seconde, le nœud ne pourrait entretenir qu'environ 300 routeurs. **La mesure ne le montre pas** : aucune perte à 500 routeurs, 6 minutes après la création, quand la plupart des clients avaient dépassé leurs 300 s. La raison n'est **pas établie** : expiration paresseuse ou limite non appliquée au renouvellement, je ne l'ai pas vérifié dans le code. À trancher avec L8 avant de dépasser quelques centaines de routeurs par nœud.

## 7. Index et plans d'exécution

Plans relevés par `auto_explain` (instructions imbriquées d'`authorize`, `perf/plans.sql`) :
- recherche du routeur, du ticket (`voucher_tenant_id_code_key`), des sessions (`session_par_ticket`) et du compte d'appareils (`auth_log_accept_par_ticket`) : par index, en quelques dizaines de µs. Les seuls parcours séquentiels portent sur des tables de quelques lignes (`parametre`, `tenant`, `lecteur_battement`) ;
- `sessions_to_cut(100)` : 24 ms pour 1 000 sessions ouvertes, toutes les 30 s, hors chemin critique.

**Écart signalé : anti-devinette sous attaque.**
- **Cause.** Pour compter les échecs d'**une** MAC, `trop_de_tentatives` passe par l'index **par routeur** `auth_log_echecs_routeur (router_id, at)`, puis filtre la MAC, au lieu de l'index par MAC `auth_log_echecs_mac (router_id, mac, at)`. Dans le plan relevé, 715 lignes sont lues pour 0 retenue, en 1,4 ms. Les deux index ont le même coût estimé quand les statistiques ne voient pas les échecs récents. Pendant une attaque, c'est le cas : l'`autoanalyze` n'agit qu'après environ 10 % de lignes nouvelles, soit 135 000 insertions sur 1,35 million.
- **Mesure** : un client légitime sur un routeur qui reçoit des échecs avec des MAC toutes différentes (l'attaquant change de MAC).

  | Échecs récents sur le routeur | statistiques non rafraîchies (cas réel) | `ANALYZE` après chaque palier |
  |---|---|---|
  | 0 | 1,6 ms | 1,3 ms |
  | 10 000 | 3,6 ms | 2,9 ms |
  | 50 000 | **16,5 ms** | 0,4 ms (l'index par MAC est choisi) |
  | 100 000 | **44,0 ms** | — |

  100 000 échecs en 6 minutes représentent environ 280 tentatives par seconde sur un seul routeur. Le coût croît linéairement : au-delà, **l'objectif de 50 ms n'est plus tenu** pour les clients de ce routeur.
- **Pistes de correction**, à trancher dans un ADR :
  1. `ALTER TABLE radius.auth_log SET (autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = 5000)` : statistiques rafraîchies toutes les 5 000 insertions. Changement minimal ; il reste au pire environ une minute dégradée (cycle d'autovacuum).
  2. Retirer le recouvrement entre les deux index : compter les échecs par routeur (alerte du ticket 07) autrement, par exemple dans une table de compteurs par minute, pour que seul l'index par MAC puisse servir la requête par MAC.
  3. Limiter en amont : le pare-feu du nœud (phase 5) et le hotspot RouterOS (essai sur CHR) bornent le débit de tentatives d'un client.

## 8. Synthèse

| Objectif | Résultat |
|---|---|
| 200 auth/s (§5.6) | **Atteint** : 200/s sans perte sur 3 vCPU, plafond entre 400 et 800/s |
| p95 d'`authorize` < 50 ms (§5.6) | **Atteint** en régime normal (1,73 ms) ; **menacé sous attaque** sur un routeur (44 ms à 100 000 échecs récents, §7) |
| Rattrapage du `detail` comparé à 5 min (§10.2) | Une heure de panne de 1 000 sessions rattrapée en 1,8 min, sans perte |
| ×10 (500 routeurs) | 200/s sans perte ; reprise du nœud en environ 9 min (un client par seconde) |
