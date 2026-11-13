# Journal WAKATNET

Une entrée par session. Le plus récent en haut.

---

## 2026-11-10 — Session 1 : mise en place (§14.1, §14.2) et phase 0

### Contexte d'exécution (important pour lire les preuves)

Cette session ne tourne **pas** sur le poste de Yacouba (Windows / Docker Desktop / GNS3) mais dans un conteneur Linux éphémère de Claude Code (Ubuntu 24.04, 4 vCPU, 15 Go). Constaté par commande :

| Élément | État | Conséquence |
|---|---|---|
| KVM / QEMU | absents | **aucun CHR** possible ici : tous les [LABO] RouterOS restent ouverts |
| `download.mikrotik.com`, `manual.mikrotik.com`, `www.bceao.int` | refusés par le proxy sortant (curl, 403 CONNECT) | vérification des docs officielles par un autre canal, ou à faire par Yacouba |
| `github.com` / `raw.githubusercontent.com` | accessibles | sources FreeRADIUS vérifiables |
| FreeRADIUS (apt) | 3.2.5 seulement (Ubuntu noble-updates), pas 3.2.8 | tests serveur possibles, mais sur 3.2.5 : écart à signaler |
| PostgreSQL 16 (apt), `psql` | disponible | |
| Démon Docker | arrêté au démarrage | `docker compose` à valider |
| `bash --version` | GNU bash 5.2.21 | (Linux ; le test Windows/PowerShell du §14.1.4 reste à faire par Yacouba) |
| `jq --version` | jq-1.7 | |
| `python3 --version` | Python 3.13.18 | |

### Écart avec la règle « pas de `git push` »

`CLAUDE.md` (modèle du §14.2) interdit à l'agent de pousser. Cette session cloud est éphémère et ses consignes imposent de pousser sur la branche de travail `claude/new-session-4gefvp`. Le travail est donc poussé **sur cette branche uniquement**, jamais sur `main`, avec une PR en brouillon. Yacouba décide de la fusion. À confirmer par Yacouba.

### §14.1 — Inventaire des skills dans cette session

Méthode : comparaison de la liste des skills exposés à cette session avec le §14.4. Les skills [Y] ne sont pas visibles d'un agent : **à vérifier par Yacouba avec `/skills`**.

| Skill (§14.4) | Origine | Présent ici ? | Nom exact dans cette session |
|---|---|---|---|
| `tdd` | [PC] | **absent** | — |
| `design-an-interface` | [PC] | **absent** | — |
| `codebase-design` | [PC] | **absent** | — |
| `domain-modeling` | [PC] | **absent** | — |
| `grilling` | [PC] | **absent** | — |
| `review` | [PC] | **absent** | (la commande intégrée `code-review` existe ; elle cherche des bugs, ne remplace pas la revue Standards/Spec) |
| `diagnosing-bugs` | [PC] | **absent** | — |
| `resolving-merge-conflicts` | [PC] | **absent** | — |
| `senior-backend` | [PC] | **absent** | — |
| `golang-pro` | [PC] | **absent** | — |
| `frontend-design` | [PC] | **absent** | — |
| `senior-frontend` | [PC] | **absent** | — |
| `ui-ux-pro-max` | [PC] | **absent** | — |
| `webapp-testing` | [PC] | **absent** | (Playwright + Chromium préinstallés dans le conteneur) |
| `telegram-bot` | [PC] | **absent** | — |
| `git-guardrails-claude-code` | [PC] | **absent** | — |
| `setup-pre-commit` | [PC] | **absent** | — |
| `docx`, `pdf` | [PC] | présents | `anthropic-skills:docx`, `anthropic-skills:pdf` |
| `routeur-modeles` | [CPT] | présent | `anthropic-skills:routeur-modeles` |
| `mikrotik-routeros-config` | [CPT] | présent | `anthropic-skills:mikrotik-routeros-config` |
| `web-design-pro` | [CPT] | présent | `anthropic-skills:web-design-pro` |
| `deep-research` | [CPT] | présent | `anthropic-skills:deep-research` |
| `assistant-starlink` | [CPT] | présent | `anthropic-skills:assistant-starlink` |
| `formateur-it` | [CPT] | présent | `anthropic-skills:formateur-it` |
| `design:ux-copy` | [PLG] | présent | `design:ux-copy` |
| `design:accessibility-review` | [PLG] | présent | `design:accessibility-review` |
| `operations:vendor-review` | [PLG] | présent | `operations:vendor-review` |
| `legal:review-contract` | [PLG] | présent | `legal:review-contract` |
| `finance:reconciliation` | [PLG] | présent | `finance:reconciliation` |
| `operations:runbook` | [PLG] | présent | `operations:runbook` |
| `engineering:deploy-checklist` | [PLG] | présent | `engineering:deploy-checklist` |
| `engineering:incident-response` | [PLG] | présent | `engineering:incident-response` |
| `/code-review`, `/security-review` | intégrées | présentes | `code-review`, `security-review` |
| `/grill-with-docs`, `/handoff`, `/prototype`, `/to-prd`, `/to-issues`, `/implement`, `/triage`, `/improve-codebase-architecture`, `/ask-matt`, `/setup-matt-pocock-skills` | [Y] | **non vérifiable par l'agent** | à Yacouba |

Skills à ne pas utiliser (§14.6) : `senior-devops`, `senior-fullstack`, `qa`, `request-refactor-plan`, `find-skills` — **aucun n'est présent dans cette session**.

Conséquence (§14.1.2) : les skills [PC] étant absents, le travail se fait selon les règles de la spec, sans les simuler.

### §14.2 — Mise en place

| Étape | État | Preuve |
|---|---|---|
| 1. `docs/SPEC.md` | fait | `cmp` : identique octet pour octet au fichier fourni |
| 2. `CLAUDE.md` | fait | modèle du §14.2 recopié tel quel |
| 3. `CONTRIBUTING.md` | fait | règles C1–C7, A1–A8, I1–I2, S1–S3, R1–R8, P1–P7 |
| 4. `.gitignore`, `.gitattributes` | faits | `* text=auto eol=lf`, CRLF pour `*.bat`/`*.cmd` |
| 5. `/setup-matt-pocock-skills` [Y] | **en attente de Yacouba** | réponses recommandées : tickets Markdown dans `.scratch/`, étiquettes par défaut, `CONTEXT.md` unique + `docs/adr/` |
| 6. `git-guardrails-claude-code` | **non fait** | skill absent de cette session, et accord de Yacouba requis. Garde-fou non prouvé = ne compte pas. |
| 7. `setup-pre-commit` | **non fait** | skill absent ; pas encore de `package.json` |

### Phase 0 — livrables produits dans cette session

Méthode : un workflow de 24 agents. Recherche par thème (RouterOS, FreeRADIUS, réglementaire, 6 lots d'agrégateurs), puis une contre-vérification adversariale par lot, où le vérificateur l'emporte si une citation est introuvable. En parallèle : labo FreeRADIUS exécuté, pile de dev, protocole CHR, puis synthèse et critique de complétude. Les 16 lacunes relevées par la critique ont été corrigées à la main ensuite (voir ci-dessous).

| Livrable | État | Preuve |
|---|---|---|
| `infra/lab/freeradius/` (L1–L6, serveur seul) | **36 PASS / 0 FAIL sur FreeRADIUS 3.2.5** ; rejoué par la critique, puis rejoué après correction de `run-lab.sh` | `infra/lab/freeradius/evidence/00-summary.log` et journaux associés (désormais versionnés) |
| `infra/docker-compose.yml` (dev) | démarre ; FreeRADIUS 3.2.10, PostgreSQL 16.15, Redis 7.4.12 épinglés par digest ; ports en 127.0.0.1 | `infra/dev/evidence/compose-2026-11-10.log` |
| `docs/LABO.md` | **0 [LABO] RouterOS tranché sur 10** (pas de CHR) ; 7 points serveur tranchés sur 3.2.5 ; protocoles CHR LABO-00 à 16 rédigés ; écarts avec le §1 | — |
| `docs/PAYMENT_PROVIDERS.md` | 11 prestataires. **Aucune page officielle lue en entier** (domaines bloqués) : seuls le code des SDK officiels et des extraits de recherche, marqués « non vérifié (extrait) ». Coût d'un ticket à 100 F : inconnu. | — |
| `docs/QUESTIONS_AGREGATEURS.md` | couvre la liste minimale du §12 (contrôlé par la critique) | — |
| `docs/CONFORMITE.md` | gabarit ; mode B verrouillé | — |
| `docs/G0.md` | dossier de décision D1–D6, D9 ; Q1 et Q7 | — |

Corrections après la critique : preuves sorties du `.gitignore` ; digests réellement épinglés ; preuve de la pile de dev archivée ; `run-lab.sh` passe le SQL par l'entrée standard ; constat « `NAS-IP-Address` non comparé à l'IP source » ; §1.5 marqué non vérifié ; questions aux agrégateurs reformulées (extraits ≠ faits) ; `suppress_secrets` décrit comme le défaut de l'image ; dossier G0.

Écarts majeurs avec le §1 : FreeRADIUS 3.2.10 (et non 3.2.8), ne jamais utiliser 3.2.9 ; `require_message_authenticator` du bloc client inopérant pour les clients dynamiques, il faut `&FreeRADIUS-Client-Require-MA = yes` (prouvé sur 3.2.5, lu dans le code de 3.2.8 à 3.2.10) ; base arrêtée ⇒ Reject (enjeu T13).

Push : refusé (403, la Claude GitHub App n'a pas accès au dépôt). Commits locaux seulement.

**Arrêt à la porte G0** (§12) : voir `docs/G0.md`. Attente de Yacouba.

---

## 2026-11-10 — Session 1 (suite) : porte G0, décision D1

PR n°1 (mise en place et phase 0) fusionnée par Yacouba. Branche de travail repartie de `main`.

Séance de questions sur D1, une à la fois :
1. Circuit au lancement : **A puis C**, B verrouillé.
2. Commission en mode A : pourcentage par ticket, **crédits prépayés avec découvert plafonné**. Yacouba a d'abord répondu « un pourcentage sur chaque ticket vendu », ce qui fixe le montant mais pas le mécanisme. La question a été reposée, et c'est le mécanisme recommandé qui a été retenu.
3. Propriétaire sans compte marchand : Yacouba a répondu « chaque détenteur de WiFi a le droit de créer un compte, ajouter ses routeurs et gérer le débit à son choix ». C'est consigné comme **accès ouvert**. La vente en ligne s'active au branchement du compte marchand ; c'est une conséquence du mode A, signalée à Yacouba.

Consigné dans `docs/adr/0001-circuit-de-l-argent.md` ; `docs/G0.md` mis à jour. Prochaine décision proposée : **D4** (rendue urgente par l'accès ouvert).

### Décision D4 (10/11/2026)

Séance de questions sur D4 :
1. Modèle : **un % du prix du forfait avec un plancher**, à l'activation (premier Accounting-Start), débité des crédits.
2. Valeurs : **10 % et plancher de 10 F** (Yacouba a préféré cette option à ma recommandation, 5 % et 5 F).

J'ai corrigé en séance une erreur de raisonnement que j'avais faite : un % papier plus bas ne pousse pas vers la vente en ligne, puisque la vente en ligne coûte aussi les frais d'agrégateur. Conséquence de conception signalée : un ticket papier existant s'active toujours ; au plafond du découvert, c'est la génération de nouveaux lots qui est bloquée.

Consigné dans `docs/adr/0002-frais-tickets-papier.md` ; `docs/G0.md` mis à jour.

### Décision D5 (10/11/2026)

1. Yacouba a répondu « 7.15+ et 6 ». Cela contredit SPEC §2.3 et §11 ; je lui ai présenté les coûts (deuxième tunnel sur le chemin critique, second script, matrice à refaire, RouterOS 6 en fin de vie). Choix retenu : **RouterOS 6 en phase 2b**, 6.49.x long-term, un seul tunnel.
2. Support : **toute version ≥ minimum** (contre ma recommandation : versions testées seulement). Conséquence consignée : rejeu de la matrice T sur CHR à chaque nouvelle stable.

Question restée sans réponse : la part du parc en RouterOS 6 / hAP lite. Consigné dans `docs/adr/0003-versions-routeros.md`.

### Décision D6 (10/11/2026)

1. Yacouba a un compte Hetzner. Je lui ai signalé le point de défaillance unique (compte, facturation, réseau) si A et B y sont tous les deux. Choix retenu : **Hetzner pour A et B au lancement et au pilote sur ses sites, puis B migré chez un autre hébergeur avant G-PILOTE** (condition bloquante).
2. FreeRADIUS : **paquets officiels de l'éditeur**, version épinglée ≥ 3.2.10, compilation en repli.

Consigné dans `docs/adr/0004-hebergement.md`. Reste au G0 : D9 ; D2 et D3 attendent les agrégateurs.

### Décision D9 (10/11/2026)

1. Récupération après une page fermée : **jeton d'appareil, repli numéro + extrait de la référence de transaction**.
2. Conservation : **numéro en clair 6 mois puis HMAC + forme masquée ; MAC et sessions 12 mois ; tentatives 90 jours**. J'ai corrigé une erreur de `docs/G0.md` : « numéro haché » ne protège rien sur 8 chiffres, il faut un HMAC à clé secrète.
3. Visibilité : **masqué + recherche par numéro** ; numéro complet réservé au super-admin, consultation journalisée.

Consigné dans `docs/adr/0005-identite-client-final.md`. Au G0, toutes les décisions qui relèvent de Yacouba sont tranchées sauf D2 et D3 (elles attendent les agrégateurs). La porte reste fermée tant que les preuves de labo manquent.

### Protocole de mesure de latence (ADR 0004 point 4, LABO-17) — 10/11/2026

Produit par un workflow de 4 agents : rédaction et tests, deux relectures adversariales (méthode et statistiques ; réseau, RouterOS et hébergement), puis correction. Fichiers : `docs/PROTOCOLE_LATENCE.md`, `infra/lab/latence/`.

- **Ce qui est prouvé, en simulation dans le conteneur** :
  - `analyse.py` retrouve les profils injectés (délai, gigue, pertes en rafales, coupure de 15 s, panne locale) ;
  - `test-analyse.py` : 67/67 contrôles, rejoué par moi ;
  - `verifier-test.py` : 73/73 au dernier passage de l'agent ;
  - un vrai défaut corrigé dans `sonde.sh` : dernière tranche perdue sur SIGTERM envoyé au groupe de processus.
- **Écarts de l'environnement** :
  - pas de `tc netem` (noyau sans `sch_netem`), remplacé par un dégradeur UDP en espace utilisateur ;
  - WireGuard en espace utilisateur (wireguard-go, hors dépôt).
- **Non prouvé** :
  - toute mesure réelle depuis le Burkina ;
  - `routeros-sonde.rsc`, jamais exécuté faute de CHR ;
  - `serveur-vm.sh` sur une vraie Debian avec systemd ;
  - les noms et offres Hetzner, marqués « à vérifier ».
- **À valider par Yacouba** :
  - hypothèse de 300 authentifications par jour et par routeur ;
  - attente acceptable côté client W = 5 s ;
  - seuils de choix des datacenters (§7 du protocole).
- **Donnée la plus importante qui manque** : le nombre de renvois de RouterOS avant bascule (LABO-09 / LABO-16). Un `timeout` plus long ne réduit pas les fausses bascules dues à la perte ; seuls les renvois le font.
- **Stockage** : environ 750 Mo de captures par sonde pour 72 h. Elles ne vont pas dans le dépôt ; l'archivage reste à décider.

`docs/LABO.md` : LABO-17 ajouté et renvoi depuis LABO-09. `.gitignore` : exception pour `infra/lab/latence/evidence/**/*.log`.

#### Rejeu indépendant du test de latence (règle 9 du §13)

- **Rejeu 1 : 137 PASS, 3 FAIL.**
  - Cause : la panne injectée tombait sur une frontière de tranche alignée sur l'horloge (22:00:00). La rafale a été coupée en deux : 8,4 s de pertes, mais 13,3 s de silence.
  - Le « 73/73 » de l'agent dépendait donc de l'heure de démarrage.
  - Correction : `eviter_frontiere` dans `outils/test-local.sh`, testée à part (attente de 10 s quand il le faut, aucune sinon). Le cas est aussi documenté au §8.1 du protocole.
- **Rejeu 2 : 139 PASS, 1 FAIL.**
  - Constat : seuil fixe « perte hors panne locale < 1 % » dans le tunnel, alors que le test tolère jusqu'à 4 s de bords non classés.
  - Vérifié sur la capture : toutes les pertes du tunnel tombent dans les fenêtres injectées, sans traîne de reprise WireGuard.
  - Correction : le seuil fixe devient une borne calculée à partir de la panne détectée.
  - Rejeu 2 revérifié : 0 échec. Les preuves du dépôt passent aussi.
- **Non prouvé :** un passage complet de bout en bout qui déclenche réellement l'attente de frontière.

### Courriels aux agrégateurs (10/11/2026)

- Questionnaire mis à jour avec les décisions du G0 : le point 3 du courriel type présente maintenant le mode A puis le mode C. Ajout des questions 38 (référence de transaction du SMS, D9), 39 (remboursement) et 40 (ordre de priorité).
- `docs/courriels/2026-11-10-agregateurs.md` : trois courriels (pawaPay, CinetPay, YengaPay). Chaque courriel pose 3 ou 4 questions décisives et joint le questionnaire complet.
- `docs/courriels/pj/*.docx`, produits par `generer_pj.py` (pandoc). Rendu vérifié en PDF : 4 à 5 pages, 40 questions générales et toutes les questions propres présentes. Deux défauts de mise en page corrigés : questions propres collées en un seul paragraphe, et tiret parasite sur 2a et 2b.
- Les adresses des destinataires ne sont pas renseignées : aucune adresse officielle n'a pu être vérifiée.

---

## 2026-11-11 — Session 1 (suite) : plan complet et porte G0

- Yacouba a demandé un plan de A à Z, avec une seule série de questions. Plan approuvé : `docs/PLAN.md`.
- Réponses données en une fois :
  - **G0 franchie sous réserve** ;
  - mode de travail : l'agent rédige le PRD et les tickets, Yacouba les valide en bloc, puis l'agent réalise les tickets lui-même, avec une PR par ticket ;
  - valeurs par défaut validées (`docs/G0.md` §5) ;
  - **moins de 50 routeurs** à 12 mois au début.
- `docs/G0.md` mis à jour ; `CONTEXT.md` créé (glossaire initial).
- Phase 1 ouverte : PRD et tickets dans `.scratch/phase-1-coeur-radius/`, soumis à la validation de Yacouba.

### PRD et tickets de la phase 1 : relecture adversariale (11/11/2026)

- Deux relecteurs indépendants (conformité à la spec ; testabilité et sécurité) ont conclu « à corriger » : 3 points bloquants, une vingtaine d'importants.
- Points bloquants :
  - un échec d'écriture de `post_auth` transformait un Accept en Reject, ce qui rendait T13 impossible sur une réplique en lecture seule ;
  - l'heure du rejeu de l'accounting décalait l'activation et fermait des sessions vivantes ;
  - `scope` / `mauvais_site` absents, et T6 reporté sans justification.
- Autres points corrigés :
  - réutilisation possible de `Acct-Session-Id` (LABO-18) ;
  - silence sur une erreur SQL quelconque ;
  - fuite possible de l'horloge de test (`SECURITY DEFINER`) ;
  - codes de ticket en clair dans les journaux ;
  - générateur de codes non cryptographique ;
  - double appel de `authorize` ;
  - secrets et rôles (`wk_coa`, `wk_maint`) ;
  - déclencheur de coupure absent ;
  - mesures de performance non mesurables telles qu'écrites.
- Le ticket 01 regroupe désormais toutes les décisions d'architecture de la phase. T6 revient en phase 1. Ajout de LABO-18 et LABO-19.

### Ticket 01 : ADR 0006, 0007 et 0008 (11/11/2026)

- PR n°7 fusionnée par Yacouba : validation du PRD et des tickets de la phase 1, comme annoncé.
- Faits vérifiés dans le code de FreeRADIUS 3.2.10 avant d'écrire :
  - le champ `Timestamp` du `detail` est l'instant de réception ;
  - un `fail` en `post-auth` donne un Reject ;
  - `rlm_sql` n'a pas de `map` ;
  - `query_timeout` est en secondes.
- Vérification adversariale par un agent indépendant (dans le code source) : 8 points bloquants corrigés, dont :
  - Message-Authenticator non exigé si `FreeRADIUS-Client-Require-MA` est absent ;
  - `reject_delay = 1` par défaut, supérieur au `timeout` de RouterOS ;
  - délais réfutés (reconnexion et rejeu) ;
  - `-X` incompatible avec la recherche de secrets ;
  - clé d'idempotence et partitionnement ;
  - valeur vide qui bloque le lecteur `detail` ;
  - EXECUTE accordé à PUBLIC ;
  - valeurs NULL ou entre apostrophes inverses interprétées par `rlm_sql`.
- Points soumis à l'acceptation de Yacouba : 7 dans l'ADR 0006, 1 dans l'ADR 0008 (marqués « [à accepter] »).
- **11/11/2026 : Yacouba accepte les 7 points « [à accepter] » des ADR 0006 et 0008**, et donc les ADR 0006, 0007 et 0008. C4 de `CONTRIBUTING.md` reçoit la précision sur l'horloge de l'accounting.

### Ticket 02 : T2 de bout en bout (11/11/2026)

- **Rouge d'abord.** Avant le code de production, `radius/tests/run.sh` échouait : migrations absentes, puis 16 échecs sur 31.
- **Faits appris en exécution**, intégrés au code et aux ADR :
  - `rlm_sql_map` fait une requête unique ;
  - le pilote PostgreSQL de FreeRADIUS rend NULL en chaîne vide, d'où une décision `Accept` / `Reject` explicite ;
  - le module `eap` de l'image empêchait le démarrage, d'où `mods-enabled` en liste fermée ;
  - faux positif T10 dû à `rate_limit` ;
  - la trace T10 n'existe qu'en debug (`-x`), et le `stdout` de radiusd est mis en tampon ;
  - un routeur désactivé est refusé immédiatement ;
  - `lifetime` vide accepté par FreeRADIUS, d'où la garde `verifier-env.sh` ;
  - les statistiques PostgreSQL d'une connexion inactive ne sont publiées qu'au bout de ~10 s ;
  - `-x` affiche les codes de ticket : réservé au test.
- **Revue en deux axes** (Standards, Spec), par deux agents qui n'ont pas écrit le code. Elle conclut « avec réserves » ; tous les constats bloquants et importants sont corrigés :
  - `wk_acct` créé ;
  - jamais d'Accept sans durée (`expire`, `epuise`) ;
  - refus par défaut en unlang ;
  - clés étrangères de site ;
  - mot de passe hors journal ;
  - recherche de secrets étendue à la sortie de pytest ;
  - Message-Authenticator exigé sur toute réponse ;
  - toutes les tables vérifiées ;
  - preuves de la copie figée, de l'échappement SQL, du « un seul appel SQL » (5 appels pour 5 requêtes), de l'isolement des secrets et du garde-fou ADR 0007 sur le catalogue.
- **Écarté et motivé** : RLS en phase 2 (PRD §3). Écarts techniques consignés dans l'ADR 0008 (amendement du 11/11/2026).
- **Dernier passage depuis une pile neuve** : 41 passed, trace T10 pour r4 et r1, aucun secret dans les sorties, `SUCCÈS`.
- Le code du ticket 02 a été poussé dans la PR n°8, avec le ticket 01, pour ne pas le perdre (conteneur redémarré). Les commits restent séparés par ticket.

### Ticket 03 : refus codés (11/11/2026)

- PR n°8 (tickets 01 et 02) fusionnée par Yacouba. Branche `claude/new-session-4gefvp` repartie de `main`. Imposée par la session cloud, elle remplace la branche `ticket/03-…` de P6, et Yacouba fusionne lui-même.
- **Rouge d'abord** : 23 échecs avant le SQL. L'un d'eux révèle un défaut du ticket 02 : une date `infinity` levait « cannot subtract infinite timestamps », donc FreeRADIUS restait muet au lieu de refuser.
- **Livré** :
  - `app/0003` : CHECK de la copie figée ;
  - `radius/0004` : `_authorize_at` remplacée, causes `proprietaire_suspendu`, `mauvais_site` et `expire` dans l'ordre de l'ADR 0006 §4 ;
  - tests de bout en bout (forme d) et SQL (forme a), dont une propriété Hypothesis contre un oracle de l'ADR.
- **Revue** (Standards, Spec, robustesse ; un sceptique par constat). Constats retenus et corrigés :
  - la garde « plafond de découvert » promettait plus qu'elle ne vérifiait. Elle est durcie (appels de fonction en liste fermée, colonnes de `app.tenant` limitées à `id` et `suspendu`) et présentée comme une garde partielle. Le test de bout en bout est dû au ticket 3.4 (`docs/PLAN.md`) ;
  - règles de calcul consignées dans l'ADR 0006 (amendement du ticket 03) : moins d'une seconde → `expire`, plafond 2^31 − 1, reste de validité borné par la validité vendue (activation datée dans le futur) ;
  - instant NULL ou infini → `expire` ;
  - critère T6 « tentative journalisée » ajouté au ticket 07.
- **Écartés** :
  - nom de branche (P6) : imposé par la session ;
  - sous-transaction de l'analyse de `p_src` : coût de quelques microsecondes, sans écriture, déjà présent dans `client_lookup`. Il sera mesuré au ticket 10.
- **Dernier passage depuis une pile neuve, après les corrections** : 92 passed, trace T10 pour r4 et r1, aucun secret dans les sorties, `SUCCÈS`. La garde « crédits » durcie a été vérifiée sur deux violations injectées (une colonne de `app.tenant` en plus, un appel non qualifié) : elle détecte les deux.

### Ticket 04 : accounting découplé (11/11/2026)

- PR n°9 (ticket 03) fusionnée par Yacouba. Branche repartie de `main`.
- **Rouge d'abord** : 67 échecs avant le code.
- **Livré** :
  - section accounting réduite au spool `detail_wakatnet` ;
  - lecteur `rejeu_accounting` (pool `sql_acct`, rôle `wk_acct`) ;
  - migration `radius/0005` : `session`, `acct_cle`, `acct_quarantaine`, `acct_anomalie`, `activation`, fonctions `acct_*` ;
  - mot de passe de `wk_acct` dans `migrer.sh` et `verifier-env.sh` ;
  - étapes « base arrêtée » puis « base figée » orchestrées par `run.sh`.
- **Lu dans le code de FreeRADIUS 3.2.10** : le lecteur rétablit l'adresse source depuis `Packet-Src-IP-Address` (`log_packet_header = yes`), et réessaie un enregistrement resté sans réponse (`detail.c` l. 76).
- **Limite mesurée** : pendant une panne de la base, un routeur dont le client dynamique a expiré n'obtient plus aucune réponse, accounting compris. C'est consigné dans l'ADR 0006 (§12), et c'est à trancher au ticket 08 ou avec LABO-16.
- **Revue** (Standards, Spec, robustesse et argent ; un sceptique par constat). Constats retenus et corrigés :
  - **bloquant** : des gigawords ≥ 2^31 faisaient déborder le `bigint`. Le lecteur restait bloqué sans fin. Ils sont maintenant bornés, avec une propriété Hypothesis sur du texte arbitraire dans les 12 paramètres ;
  - **important** : l'assertion « rejeu tardif » était tautologique. Elle mesure désormais l'instant réel du rejeu en base (`activation.inscrit_le`) ;
  - **mineurs** :
    - enregistrement empoisonné vérifié au milieu d'un fichier du spool (étape base arrêtée) ;
    - `Acct-Session-Id` réutilisé pour un autre ticket, journalisé (`acct_anomalie`) ;
    - conséquences de l'activation par un Interim ou un Stop écrites dans l'ADR.
- **Écartés après vérification** :
  - époque et Accounting-On/Off : relèvent du ticket 06, et le scénario n'est pas atteignable avant ;
  - USAGE des schémas : aucun droit sur les données sans droit sur un objet, déjà testé.
- **Dernier passage depuis une pile neuve, après les corrections** : 167 passed, cinq étapes base arrêtée et figée réussies, trace T10, aucun secret, `SUCCÈS`.

### Ticket 05 : temps et volume restants (11/11/2026)

- PR n°10 (ticket 04) fusionnée par Yacouba. Branche repartie de `main`.
- **Décisions de Yacouba** (questions posées avant le code) :
  - temps consommé = **somme des sessions** du ticket ;
  - **forfaits à sens séparés reportés**. Le critère du ticket 05 contredisait l'ADR 0006 §5 accepté ; il est retiré.
- **Rouge d'abord** : 15 échecs avant le SQL.
- **Livré** : migration `radius/0006`.
  - `_authorize_at` : `epuise` sur le temps ou le volume, et `Session-Timeout` = min des restes.
  - `_acct` : sessions ouvertes inscrites « à couper ».
  - Tests de bout en bout (T3, T12, deux appareils), tests SQL et propriété.
- **Revue** (Standards, Spec, robustesse et argent ; un sceptique par constat). Constats retenus et corrigés :
  - **bloquant**, relevé par les trois axes : la somme des octets se faisait en `bigint` et débordait sur des compteurs admis par le ticket 04. Une exception bloquait le lecteur : c'était une régression. Calcul passé en `numeric`, avec un test aux valeurs extrêmes ;
  - **important** : le dépassement maximal du volume était sous-estimé. La borne est réécrite (sessions × deux sens × délais) ; il n'y a **aucune borne** sans débit ou avec un Interim perdu ;
  - **mineurs** :
    - contrainte de purge des sessions consignée ;
    - index sans `INCLUDE`, pour garder les mises à jour HOT ;
    - test d'idempotence complet (motif conservé) ;
    - journal mis à jour.
- **Écarté après vérification** : la copie figée du volume (déjà couverte par la copie figée des colonnes `f_*`).

### Ticket 06 : sessions, appareils, fantômes, Accounting-On/Off (11/11/2026)

- PR n°11 (ticket 05) fusionnée par Yacouba. Branche repartie de `main`.
- **Décision de Yacouba** (question posée avant le code) : `post_auth` et `auth_log` sont avancés du ticket 07 au ticket 06, parce que le compte d'appareils et `bind_mac` en dépendent.
- **Rouge d'abord** : 19 échecs, tests lancés avec le code mis de côté (`git stash`).
- **Livré** :
  - migrations `app/0007` (`mac_liee`, `dernier_acct_on_le`) et `radius/0008` :
    - `_mac`, `auth_log`, `lecteur_battement` ;
    - `post_auth`, `close_ghost_sessions` (`wk_maint`), `acct_on_off` ;
    - `trop_d_appareils` et battement dans `_authorize_at` et `_acct` ;
  - FreeRADIUS : `post-auth` journalisé sans effet sur la réponse, et Accounting-On/Off rejoués ;
  - script et unités systemd des sessions fantômes.
- **Faits observés** :
  - `fail = 1` puis `ok` en `post-auth` : l'Accept reste un Accept quand l'écriture échoue (droit retiré) ;
  - `systemd-analyze verify` passe sur les unités, seul l'exécutable installé sur le nœud étant absent.
- **Vert** : `run.sh` depuis une pile neuve, 202 passed, étapes base arrêtée et figée réussies, trace T10, aucun secret.
- **Revue du ticket 06** (Standards, Spec, robustesse et argent ; un sceptique par constat). Constats retenus et corrigés :
  - **avancement du lecteur** : la fenêtre des Accept et la fermeture des fantômes se mesurent désormais sur l'avancement réel du lecteur. C'est le plus tardif de la réception du dernier enregistrement traité et de l'instant où le spool a été vu vide.
    - Avant, un lecteur bloqué laissait la fenêtre à 60 s : un appareil en trop pouvait passer.
    - La condition « spool vide » retardait la fermeture des fantômes sous trafic continu.
    - Le repère est plafonné à l'heure de la base : des événements datés de 2030, dans les tests du ticket 04, avaient fait paraître toutes les sessions fantômes.
  - **session fermée d'office mais vivante** : elle compte encore comme appareil et peut être inscrite « à couper ». Un vrai Stop corrige ensuite l'arrêt.
  - **script des fantômes** : il échoue sans rien faire si le spool est illisible ou introuvable, et l'unité a un délai maximal ;
  - **`acct_on_off`** verrouille en `FOR NO KEY UPDATE` et met à jour le battement ;
  - **tests ajoutés** : clause « Accept sans Start », `bind_mac` posée par l'accounting, bornes de la course concurrente, absence de code sur la ligne T6, idempotence réelle ;
  - **ADR 0006** mis en cohérence (§1, §10, §17), ticket 07 élagué.
- **Écarté** : « MAC vide = appareils illimités ». Le vérificateur l'a réfuté ; c'est une limite documentée, puisque RouterOS envoie toujours `Calling-Station-Id`.
- **Dernier passage depuis une pile neuve, après les corrections** : 208 passed, étapes base arrêtée et figée réussies, trace T10, aucun secret, `SUCCÈS`.

### Ticket 07 : anti-devinette, alertes, purge (11/11/2026)

- PR n°12 (ticket 06) fusionnée par Yacouba. Branche repartie de `main`.
- **Rouge d'abord** : 10 échecs, tests lancés avec le code mis de côté.
- **Livré** :
  - migration `radius/0009` : `trop_de_tentatives` en tête de `_authorize_at`, alertes dans `post_auth`, `radius.alerte`, seuils `devinette_*`, `purge_auth_log` (`wk_maint`, journalisée) ;
  - script et unités de purge ;
  - MAC d'appareil simulé propre à chaque test.
- **Prouvé en exécution** : base en lecture seule pour `wk_radius` → l'authentification fonctionne et rien n'est écrit ; T11 de bout en bout (10 échecs → blocage, même un code valide ; une autre MAC passe ; libéré après la fenêtre).
- **Trouvé pendant le vert** : mon test T11 vérifiait « un autre appareil passe » sur le même ticket à un appareil, ce qui occupait sa place. Le contrôle a désormais son propre ticket.
- **Vert** : `run.sh` depuis une pile neuve, 224 passed, étapes base arrêtée et figée réussies, trace T10, aucun secret.
- **Revue du ticket 07** (Standards, Spec, robustesse et sécurité ; un sceptique par constat). Constats retenus et corrigés :
  - **important** : la purge supprimait tout en un seul `DELETE`, sans index sur `at`, sous les 30 s de `wk_maint` : à volume réel, elle échouait chaque jour sans rattraper. Elle passe désormais par un index sur `at` et des lots de 50 000, que le script rappelle tant qu'un lot est plein ;
  - **important** : preuves ajoutées :
    - seuil de 100 échecs par routeur (99 → aucune alerte, 100 → une, 120 → toujours une) ;
    - aucune ligne « Login OK / incorrect » à l'exécution (`run.sh`) ;
    - mot de passe faux compté ;
    - MAC illisible jamais bloquée ;
    - purge par lots ;
  - **mineurs** :
    - acteur d'audit = `session_user` ;
    - unité de purge en `DynamicUser` ;
    - index des échecs filtré par cause ;
    - alertes purgées à 90 jours ;
    - test de lecture seule rétabli par `RESET` dans le `try` ;
    - courses connues documentées dans l'ADR.
- **Écartés après vérification** :
  - MAC aléatoire par test : l'aléa porte sur des données de test sans effet sur l'oracle ;
  - alerte par routeur sur B seul : déjà couverte par la conséquence assumée de l'§10 ;
  - usurpation de MAC pour bloquer un client : limite connue des MAC, §11 de la spec ;
  - coût de `post_auth` sous attaque : borné par l'index, et seule l'écriture du journal est en jeu.
- **Dernier passage depuis une pile neuve, après les corrections** : 227 passed, étapes base arrêtée et figée réussies, aucune ligne Login, trace T10, aucun secret, `SUCCÈS`.

### Ticket 08 : base PostgreSQL indisponible (11/11/2026)

- **Fusion avant vérification** : la PR n°14 (premier commit du ticket, marqué « en cours ») a été fusionnée par Yacouba avant le passage complet, la revue et l'ADR. La suite passe par la PR n°15, repartie de `main`.
- **Lu dans le code 3.2.10** :
  - `rlm_sql_map` rend `fail` pour **toute** erreur SQL. Le silence « seulement sur connexion ou délai » demandé par le ticket est donc impossible sans `exec`/`perl` (refusés par C1) : écart consigné dans l'ADR 0009 §1 ;
  - l'option `connect_timeout` du pool **n'existe pas** (`connection.c`) et était ignorée : retirée. Le délai de connexion réel est `query_timeout`, passé à libpq, qui ne l'arrondit plus à 2 s en version 18. L'ADR 0006 §13 est corrigé par l'ADR 0009.
- **Livré** :
  - compteurs `linelog` `silence_auth` et `silence_client` (jamais le code ; un routeur inconnu n'est pas compté ; `fail = 1` pour qu'un disque plein ne change pas le silence en Reject) ;
  - `infra/sql/fumee.sh`, appelé par `migrer.sh` (exécution en tant que `wk_radius` en transaction `READ ONLY`, droits `EXECUTE`, `statement_timeout`) ;
  - `test_t08.py` et `test_t08_indispo.py` (étapes f à l orchestrées par `run.sh`) ; ADR 0009.
- **Rouge d'abord** : les 5 tests de `test_t08.py` échouent sur le code d'avant le ticket (`1fea9ff`).
- **Trouvé en exécution** : un `wait` nu dans `run.sh` attendait aussi le `tee` du début du script et bloquait le passage. Corrigé par `wait "$PID"`.
- **Mesuré** (pile de test) :
  - table verrouillée → silence en 506 ms (`statement_timeout`) ;
  - base arrêtée → silence en 3,0 s. C'est dû à l'échec ARP de la pile de test ; en production, la base locale refuse aussitôt ;
  - base figée, 50 Access-Request en attente → Accounting-Response en 1,2 ms au plus ; les 50 silences comptés en 4,0 s ;
  - radiusd démarré sans base : prêt ;
  - retour de la base → Accept 2,3 à 2,7 s après « base prête » (limite : `retry_delay` + 1 = 6 s).
- **Décision proposée** (ADR 0009 §5) : accepter qu'un routeur hors cache n'obtienne aucune réponse pendant une panne (bascule vers B). Écartés : une liste statique des clients, un `lifetime` plus long. **À valider par Yacouba.**
- **Vert** : `run.sh` depuis une pile neuve, 232 passed, étapes du ticket 04 et du ticket 08 réussies, trace T10, aucune ligne Login, aucun secret, `SUCCÈS`.
- **Reste** : LABO-16 (piste B) clôt l'ADR 0009 ; rotation et lecture des compteurs en phase 5.

### Ticket 08 : revue complète de la version fusionnée et corrections (12/11/2026)

- **Contexte** : cette session a d'abord réalisé le ticket 08 une seconde fois, en parallèle. Elle n'avait pas pu lire `main` (accès GitHub refusé), alors que les PR n°14 et n°15 étaient déjà fusionnées. Cette version parallèle est **abandonnée** : `main` fait foi. Elle est gardée dans un `git stash` local, non poussé. Leçon : sans accès à `main`, ne pas commencer un ticket.
- **Revue** : ma lecture, puis deux relecteurs indépendants (Spec + Standards, robustesse), chaque constat vérifié. La version fusionnée est retenue. Elle a deux points plus justes : l'option `connect_timeout` du pool, inexistante, est retirée, et le retour de la base est testé avec un routeur qui insiste.
- **Constats corrigés** (rouge d'abord sur `main` quand c'était possible) :
  - **important, fuite constatée en exécution** : le journal de PostgreSQL recopiait les requêtes de FreeRADIUS en erreur, **code du ticket compris** (`STATEMENT: … authorize('<code>', …)`, et `post_auth`), à chaque délai dépassé ou droit retiré. Migration `radius/0010` : `log_min_error_statement = panic` (et deux autres réglages) pour `wk_radius` et `wk_acct`. Garde ajoutée dans `run.sh`, et contrôle du réglage dans la fumée ;
  - **important, `run.sh`** : sous `pipefail`, `docker compose logs | grep -q` est faux quand `grep` s'arrête tôt (SIGPIPE). La garde « aucune ligne Login » du ticket 07 avait cette forme et a pu passer à tort. Toutes les gardes lisent désormais le journal d'abord ;
  - **important, fumée** (rouge sur `main` : 2 échecs) :
    - `CONNECT` retiré non vu ; `LOGIN` et expiration du mot de passe non vus ;
    - `authorize` sans ligne non vu, alors que ce cas refuse tout le parc ;
  - **important, fumée** :
    - seule la branche « routeur inconnu » était exécutée. Elle suit maintenant aussi le chemin d'un vrai client (Accept), avec des données créées puis annulées ;
    - le `statement_timeout` du rôle n'était pas appliqué ; il l'est maintenant ;
    - la valeur était comparée au texte exact ; elle est maintenant lue telle qu'appliquée ;
  - **important, textes faux** : « arrêté avant d'arriver » (ADR 0009, ADR 0006 §13, `fumee.sh`, `migrer.sh`). La fumée **détecte** un défaut après la validation des migrations, elle ne l'empêche pas ;
  - **important, preuve surestimée** : « toute entrée donne un refus, prouvé par Hypothesis » n'était prouvé que pour des états de ticket. Ajouts : une propriété sur `authorize` et `client_lookup` (texte arbitraire, en tant que `wk_radius`) et un `User-Name` en UTF-8 invalide (Reject, pas silence) ;
  - **important, base figée** : l'accounting n'était mesuré que pendant 2 s, sur une attente de 4 s. Il est maintenant mesuré jusqu'au dernier silence, et le pire cas est borné sous 6 s. L'attente des 50 requêtes passe de 12 à 7 s, pour réduire le risque d'expiration du client `r11` (lifetime de 20 s en test) ;
  - **mineurs** :
    - `wait` sous `set -e` dans `run.sh` ;
    - séquences des données de test alignées sur leurs identifiants explicites ;
    - `radlib` accepte un `User-Name` en octets ;
    - affirmations « mesurées » de l'ADR 0009 requalifiées en « lues dans le code » ou « estimées » quand elles n'étaient pas mesurées ;
    - « même connexion » retiré d'une docstring qui ne le prouvait pas.
- **Écartés ou reportés** :
  - durée de chaque silence dans le compteur : utile pour suivre le pire cas en production, mais hors des critères du ticket, à voir avec la supervision (phase 4) ;
  - test du disque plein (`fail = 1` du compteur) : non simulé, déclaré dans l'ADR ;
  - nom de branche (P6) : imposé par la session.
- **Mesures du dernier passage** :
  - base arrêtée : silence compté après 3,0 s ;
  - retour de la base : 2,4 s (après redémarrage de radiusd) et 1,5 s (après gel) ;
  - base figée : 50 silences en 4,1 s, accounting à 1,1 ms au pire sur 16 mesures couvrant toute l'attente.
- **Vert** : `run.sh` depuis une pile neuve, 240 passed, étapes des tickets 04 et 08 réussies, trace T10, aucune ligne Login, aucune requête de FreeRADIUS dans le journal de PostgreSQL, aucun secret, `SUCCÈS`.
- **Non commité** : le commit a été refusé deux fois par le contrôle des permissions de la session ; en attente de l'accord de Yacouba.

### Ticket 09 : Disconnect et CoA (12/11/2026)

- PR n°16 (revue du ticket 08) fusionnée par Yacouba. Branche repartie de `main`.
- **Prototypes avant le code** (jetables, faits dans l'image de test) :
  - faux NAS FreeRADIUS : Disconnect-ACK et CoA-ACK avec Message-Authenticator ; sans Message-Authenticator, le paquet est jeté. En revanche, un mauvais secret n'est journalisé qu'au premier envoi, les renvois étant traités comme doublons : un compteur Python est nécessaire ;
  - `radclient` 3.2.10 : `-r 0` n'envoie rien, `-r 3` et `-r 5` n'envoient que 2 paquets. L'émetteur fait donc ses retentatives lui-même ; une réponse à l'authentificateur faux est rejetée ;
  - le Node d'Ubuntu 26.04 ne retire pas les types TypeScript : le binaire officiel (22.23.0) est utilisé ;
  - une route locale à source forcée fait partir les paquets de l'adresse de nœud du test.
- **Livré** :
  - migration `radius/0011` (`wk_coa`, `sessions_to_cut`, `coa_target`, `mark_cut`) ;
  - `infra/coupure/` (émetteur et déclencheur) ;
  - unités `wakatnet-coupure` ;
  - faux NAS FreeRADIUS et compteur ;
  - `test_t09.py` et `test_t09_sql.py` ;
  - ADR 0010.
- **Rouge** : 13 échecs et 10 erreurs, code de production mis de côté.
- **Vert** : `run.sh` depuis une pile neuve, 263 passed. T12 : Disconnect reçu 2,3 s après l'Interim (tour d'une seconde en test ; 30 s en production).
- **Revue** en deux axes (Spec et Standards, robustesse), constats vérifiés. Retenus et corrigés :
  - **important, famine** : le tri par date d'inscription remettait les sessions muettes en tête à chaque tour, et l'unité s'arrête à 25 s. Corrigé par le budget de temps d'un tour et l'ordre « jamais tentée d'abord » ;
  - **important, port** : tous les routeurs de test avaient 1700, donc un port codé en dur passait. Un routeur passe maintenant à 3799 dans un test ;
  - **important, configuration illisible** : toutes les sessions passaient à `abandon` sans aucun envoi. Le déclencheur sort désormais en 1 avant tout envoi ;
  - **important, panne de `radclient`** : elle passait pour un routeur muet. Elle est maintenant visible, et la session n'est pas marquée ;
  - **important, erreur de base** : elle arrêtait le tour. Elle est maintenant isolée par session ; nœud en lecture seule : aucun envoi (non testé) ;
  - **important, NAK** : il terminait la coupure sans alerte. Il donne maintenant une alerte `coupure_refusee` ;
  - **mineurs** :
    - `mark_cut` sans effet sur un état final ;
    - identifiant de session dans les alertes ;
    - `radclient` sans le mot de passe de la base dans son environnement ;
    - unité systemd durcie ;
    - faux NAS qui journalise après la vérification du Message-Authenticator ;
    - message « débit invalide » vérifié ;
    - quatre réglages de journalisation de `wk_coa` testés ;
    - retentatives de `radclient` prouvées par un test ;
    - écarts de signature avec l'ADR 0006 déclarés.
- **Décision à valider par Yacouba** (ADR 0010) : accès à la base par `psql` jusqu'à la phase 2 ; états finaux (`nak`, `abandon`) définitifs.
- **Piste B** : T9 sur CHR (coupure réelle, Stop reçu, port réel de `/radius incoming`).

### Ticket 10 : mesure de performance (12/11/2026)

- **Livré** : `radius/tests/perf/` contient :
  - `perf.sh` (orchestration, phases rejouables) et `compose.perf.yml` (épinglage des CPU, `lifetime` de production) ;
  - `donnees.sql` (50 ou 500 routeurs, 100 000 tickets, `auth_log` sur 90 jours) ;
  - `charge.py` (générateur CHAP avec Message-Authenticator, réponses vérifiées, modes Accept, Reject et Interim) ;
  - `durees.py`, `preparer.py`, `vidage.py`, `plans.sql`, `attaque*.sql` ;
  - `RAPPORT.md` et les résultats bruts. Les journaux portant des codes ne sont pas versionnés.
- **Machine** : 4 vCPU au total ; serveur sur 3 cœurs, générateur sur 1. C'est plus sévère que le §5.6, qui vise 4 vCPU pour le serveur seul.
- **Mesuré** :
  - 200 auth/s sans perte (p95 de 3,8 ms vu du routeur), sans perte jusqu'à 400/s, premières pertes à 800/s ;
  - p95 d'`authorize` côté serveur : 1,73 ms ; `post_auth` : 2,0 ms ;
  - une heure de panne (30 000 Interim) : Accounting-Response à 0,64 ms au p95 base arrêtée, rattrapée en 108 s (environ 280 enregistrements par seconde) ;
  - 500 routeurs : 200/s sans perte, y compris 6 min après la création des clients ; création des clients à un par seconde, soit environ 9 min de reprise.
- **Trouvé, mesuré et signalé** (RAPPORT §7) :
  - sous attaque par devinette sur un routeur, avec des statistiques non rafraîchies, `authorize` passe par l'index par routeur et filtre la MAC ;
  - son coût croît alors avec les échecs récents : 16,5 ms à 50 000, **44 ms à 100 000** ;
  - trois pistes de correction sont proposées, **à trancher par Yacouba dans un ADR**.
- **Hypothèse infirmée** : la limite d'environ 300 routeurs par nœud, que j'attendais de `rate_limit` combiné à `lifetime = 300`, ne se voit pas à 500 routeurs. La cause n'est pas établie ; à reprendre avec L8.
- **Erreurs corrigées pendant la mesure** :
  - `PYTHONPATH` des scripts ;
  - cibles exportées **avant** l'arrêt de la base ;
  - Interim envoyés d'abord sur le port 1812 au lieu de 1813. Ce premier rattrapage, de 0,6 s, ne valait rien et a été remplacé ;
  - Reject inattendus en mode Accept expliqués par le jeu de données.
- **Revue** : outillage de test seulement, sans code de production. Pas de revue indépendante pour ce ticket ; à faire avec la revue de fin de phase 1.

### Fin de phase 1 : anti-devinette sous attaque, décisions, revue (12/11/2026)

- PR n°17 (tickets 09 et 10) fusionnée par Yacouba.
- **Consigne de Yacouba** dans cette session, le 12/11/2026 : « fais tout le travail sans poser de question, pas d'erreur ». Les points « à valider » des ADR 0009 et 0010 sont donc acceptés **par délégation**, tels que recommandés. L'ADR 0011 l'est aussi. Yacouba peut les rouvrir.
- **Anti-devinette sous attaque** (RAPPORT §7, ADR 0011, migration `radius/0012`) :
  - **Rouge sur `main`** : 5 `authorize` d'un vrai client parcouraient l'index par routeur (compteurs de PostgreSQL).
  - **Correction** : l'index par routeur porte sur `(router_id + 0)`, et les comptes d'alerte de `post_auth` sont bornés au seuil.
  - **Mesure** : 100 000 échecs récents, 44 ms avant, **0,46 ms** après. C'est une moyenne d'appels SQL directs, pas un p95 RADIUS.
- **Revue de fin de phase 1**, en deux axes (Standards, Spec), par des relecteurs indépendants. Constats retenus et corrigés :
  - **important** : la migration 0012 supprimait l'index d'abord. Le verrou exclusif sur `auth_log`, tenu pendant la construction du nouvel index, aurait rendu le nœud muet. L'index est maintenant construit d'abord, puis l'ancien supprimé et le nouveau renommé juste avant la validation ;
  - **important** : le débit et le p95 dataient d'avant 0012. Ils ont été remesurés : p95 d'`authorize` de 1,40 ms, 200/s et 400/s sans perte (RAPPORT §9). Les chiffres sous attaque sont requalifiés en moyennes SQL ;
  - **important** : la garde « nœud en lecture seule » de la coupure n'était pas testée. Elle couvre maintenant aussi `transaction_read_only`, et elle est testée ;
  - **mineurs** :
    - `test_droits.py` couvre `wk_maint` et `wk_coa` pour CREATE, ainsi que TRUNCATE, REFERENCES et TRIGGER ;
    - `test_t10_sql.py` est renommé `test_devinette_attaque_sql.py`, pour ne pas le confondre avec T10 ;
    - les fichiers de secrets jetables laissés par un passage manuel sont supprimés.
- **Écartés ou notés** :
  - quatre anciens commits ne citent pas le chemin de leur ticket (P3) : l'historique fusionné n'est pas réécrit ;
  - la cause `ticket_inconnu` posée en unlang pour un mauvais mot de passe (C2) : choix de l'ADR 0006 §4, testé ;
  - le ticket 04 demandait une panne de 20 min, le test attend 10 s : même propriété vérifiée ;
  - l'alerte de T11 n'a pas encore de consommateur (worker en phase 2).
- **Vert** : `run.sh` depuis une pile neuve, 278 passed, étapes des tickets 04 et 08, trace T10, aucune ligne Login, aucune requête de FreeRADIUS dans le journal de PostgreSQL, aucun secret, `SUCCÈS`.
- **État de la phase 1 au regard du PRD §6** :
  1. Matrice verte en une commande : **oui**.
  2. Essais sur CHR (piste B, Yacouba) : **non**. LABO-00, 09, 16, 18 et 19 sont ouverts, ainsi que T9 et T12 sur un vrai routeur.
  3. Rapport de performance : **oui**.
  4. Revue en deux axes : **faite**, ses constats sont corrigés.
  5. Étiquette `phase-1` : **non posée**. Elle attend le point 2. L'étiquette `g0` n'existe pas non plus dans le dépôt.

### Corrections de `/code-review` sur la fin de phase 1 (12/11/2026)

- PR n°18 fusionnée par Yacouba. `/code-review` lancé par Yacouba : 9 constats, tous traités.
- **1 et 2, importants : verrous de la migration 0012.**
  - Une construction d'index en transaction bloquait les INSERT de `post_auth`, ce qui saturait le pool, tandis que les Reject n'étaient plus journalisés.
  - Le `DROP INDEX`, en attente derrière un lecteur long, aurait fait attendre tous les `authorize`.
  - **Correction** : 0012 devient `0012_…sans_transaction.sql`, avec `CREATE INDEX CONCURRENTLY` et `DROP INDEX CONCURRENTLY`, et des étapes idempotentes. `migrer.sh` applique ces fichiers hors transaction, et pose `lock_timeout` (200 ms) avec de nouveaux essais sur **toutes** les migrations (ADR 0008, amendement).
  - **Prouvé** : migration rejouée sous un lecteur long. Elle attend puis aboutit, et pendant ce temps `authorize` et `post_auth` répondent en 52 ms au pire.
- **3 : migration fusionnée modifiée.** J'ai vérifié que l'ancienne 0012 n'avait été appliquée qu'à des piles de test jetables : la pile de dev ne lance pas `migrer.sh`, et il n'existe pas de nœud. Elle est remplacée par un fichier de **nom différent**, qui reste correct sur une base qui l'aurait appliquée (ADR 0011).
- **4 et 6 : garde de lecture seule.**
  - L'état de la base est revérifié **avant chaque session**.
  - Le tour s'arrête si `mark_cut` échoue en lecture seule.
  - Une réplique donne la sortie 0 ; un primaire en lecture seule donne la sortie 1, avec le message « ANOMALIE ». La fenêtre qui reste avant `mark_cut` est documentée.
- **5 : affirmation corrigée.** Le journal disait la garde de réplique « testée ». Seule la branche « lecture seule » l'est ; la branche `pg_is_in_recovery()` exige une vraie réplique (phase 5).
- **7** : l'ADR 0011 cite les bons fichiers.
- **8 : `post_auth` plus lent après 0012**, de +7 à +23 % selon le quantile, au-delà de la variation entre passes. Ce n'est **pas expliqué**, et c'est maintenant dit dans le RAPPORT (§9) au lieu de « pas de régression ».
- **9 : données brutes rangées par passe.**
  - `perf.sh` écrit dans un répertoire daté.
  - La passe 2 est restaurée depuis le commit `386545b`, et la passe 1 depuis le journal de session.
  - Le §4 donne les deux passes : 1,73 et 1,65 ms. L'écart que relevait la revue venait de là.
- **Trouvé en exécution** : renommé, le fichier de test s'exécutait avant `test_t07_sql.py` et laissait une alerte et des échecs sur r5, ce qui faussait le seuil des 100 échecs par routeur. Les tests nettoient désormais tout ce qu'ils écrivent.

### Points mesurés mais non expliqués : expliqués (12/11/2026)

- PR n°19 (corrections de `/code-review`) fusionnée par Yacouba.
- **L8, `rate_limit` des clients dynamiques**, mesuré sur 3.2.10 :
  - un seul **nouveau** client par seconde : 3 IP inconnues dans la même seconde, 1 seule répond ;
  - un client **expiré** est recréé par une nouvelle recherche en base, **sans** limite : 3 sur 3 dans la même milliseconde, et un routeur désactivé pendant l'attente cesse de répondre ;
  - cela explique l'absence de plafond à 500 routeurs : seule la reprise à froid est lente ;
  - test permanent `test_clients.py::test_l8_*` (routeurs r15 à r17) ; LABO.md L8 passe à TRANCHÉ ; ADR 0006 §16 complété.
- **`post_auth` après 0012** : mesure A/B contrôlée (`perf/ab-post-auth.sh`), même base, corps 0009 et 0012 en alternance sur 3 tours, deux séries :
  - en Reject, le nouveau corps est **plus rapide** (environ −32 %) ;
  - en Accept, c'est le même code, et l'écart (±0,02 ms) n'est pas significatif ;
  - la hausse vue entre passes (+7 à +23 %) était de la variation d'une passe à l'autre ; RAPPORT §6 et §9 corrigés.

### Clôture de la phase 1 et ouverture de la phase 2 (12/11/2026)

- PR n°20 fusionnée par Yacouba.
- **Décision de Yacouba (12/11/2026)** : « pas besoin d'essais, finis le travail, je vais essayer à la fin ». Les essais sur CHR (LABO-00, 09, 16, 18, 19, T9 et T12 sur un vrai routeur) sont **reportés à la fin**, et non supprimés. Conséquences :
  - l'étiquette `phase-1` n'est pas posée : le critère 2 du PRD de la phase 1 reste ouvert ;
  - aucun script ni aucune configuration ne doit être appliqué au routeur d'un tiers avant ces essais (G-PILOTE l'exige de toute façon).
- Constaté dans ce conteneur : pas de KVM, `download.mikrotik.com` refusé par le proxy (403). Un CHR est donc impossible ici. En revanche, `wireguard-go` est utilisable (`/dev/net/tun` présent), mais le module WireGuard du noyau est absent. Prisma 7.10.1 s'installe, moteur de schéma compris.
- Phase 2 : PRD et tickets 01 à 07 rédigés dans `.scratch/phase-2-multi-proprietaires/`, validés par délégation. ADR 0012 (contrats) ; il amende l'ADR 0008 : un seul historique de migrations, Prisma comme client seulement. `docs/IDEES.md` créé.
- Écart de numérotation relevé : `docs/PLAN.md` appelle « LABO-08 » les utilisateurs locaux, alors que `docs/LABO.md` les numérote LABO-05 (LABO-08 est la vérification TLS de `/tool fetch`). Les documents de la phase 2 suivent `docs/LABO.md`.

### Phase 2, ticket 02 : socle applicatif, RLS, tests d'isolement (12/11/2026)

- Espace de travail npm (racine), `apps/api` : Fastify 5.12.8, Prisma 7.10.1 (client seulement, adaptateur `pg`), TypeScript exécuté par Node 22 sans compilation ; versions exactes dans `package-lock.json`.
- Migration `0013_app_cloisonnement.sql` :
  - rôle `wk_api` (journal des instructions coupé, `statement_timeout` à 5 s) ;
  - `app.enrollment_token` ;
  - colonnes d'enrôlement de `app.router` ;
  - RLS sur six tables, avec un contexte posé par transaction (ADR 0012 §6).
- `prisma/schema.prisma` est tiré de la base. Un test le compare à la base migrée, et une dérive provoquée a bien fait échouer ce test.
  - **Constaté** : `prisma db pull --print` échoue avec un `prisma.config.ts` (7.10.1). Le test tire donc dans une copie.
- **Preuves** :
  - `apps/api/tests/run.sh` (pile neuve) : 14 tests, SUCCÈS. Ils couvrent les isolements A/B par l'API et en SQL direct, zéro ligne sans contexte, la fin du contexte avec la transaction, le refus d'écrire chez un autre (WITH CHECK), l'absence de tout droit sur `radius`, la configuration interdite en production et le masquage du jeton dans les journaux ;
  - `radius/tests/run.sh` (pile neuve) : 280 passés, 12 ignorés (étapes orchestrées), SUCCÈS. La matrice T est inchangée par la RLS.

### Phase 2, tickets 03 et 04 : API d'enrôlement, scripts RouterOS, login.html (12/11/2026)

- Les deux tickets partagent un commit : le générateur de scripts (ticket 04) **est** la réponse de l'API d'enrôlement (ticket 03).
- **Migration 0014** :
  - `app.enroll_register` fait en **une** transaction la consommation du jeton (ligne verrouillée), l'allocation de l'adresse (verrou consultatif, sans réemploi, sans `.0` ni `.255`), le secret RADIUS (pgcrypto, 32 caractères) et l'audit ;
  - `app.enroll_token_valide` vérifie le jeton.
- **API** :
  - `POST /v1/sites/{site}/enrollments` ;
  - `GET` et `POST /enroll/{jeton}` ;
  - `GET /v1/routers/{id}/uninstall.rsc`, propre au routeur, avec les valeurs d'origine relevées ;
  - le contrat `apps/api/openapi.yaml` est confronté aux routes servies par un test.
- **Scripts** (`apps/api/src/routeros.ts`) : étapes 1 et 2, désinstallation. Toute valeur venue du routeur est échappée, et les scripts sont en ASCII seul.
  - Audit `mikrotik-routeros-config` : `docs/AUDIT_SCRIPTS_ROUTEROS.md`. Un défaut probable a été corrigé : `place-before` vers une règle dynamique du hotspot.
  - **Deux points critiques restent suspendus au CHR** : la vérification TLS de `/tool fetch` en 7.15 (LABO-08), et la remontée d'un `:error` à travers `/import`.
- **`routeros/hotspot/login.html`** (3,5 Ko, autonome) : code en majuscules avant le CHAP. Le MD5 intégré a été vérifié contre `crypto` sur 200 entrées aléatoires. La page n'est pas installée par l'enrôlement (ADR 0012 §9).
- **Preuves** :
  - `apps/api/tests/run.sh` (pile neuve) : 43 tests, SUCCÈS. Ils couvrent le jeton stocké en empreinte, le GET qui ne consomme pas, le 404 identique, 6 POST concurrents pour un seul routeur, le 422 et le 409 qui laissent le jeton intact, l'expiration, l'adressage (10.213.1.0/24 plein, donc passage à 10.213.2.x), l'absence du jeton et du secret dans le journal, et R1 à R7 sur le texte des scripts ;
  - `radius/tests/run.sh` (pile neuve, avec 0014) : 280 passés, SUCCÈS.
- **Non prouvé** : aucune exécution sur RouterOS (écart R8, PRD §6).

### Phase 2, ticket 05 : wg-agent et pare-feu du nœud (12/11/2026)

- **`apps/wg-agent`** (Go 1.24, `wgctrl`, `pgx`) :
  - la planification est une fonction pure ;
  - la boucle fait `LISTEN wakatnet_pairs`, avec un tour de filet toutes les 30 s ;
  - seuls les pairs sont configurés : ni la clé privée, ni le port, ni l'interface.
- **Migration 0015** :
  - rôle `wk_wg` (EXECUTE sur `app.wg_pairs()` seule, journal coupé) ;
  - déclencheur `NOTIFY` sur `app.router`.
- **Garde anti-effacement, amendée (ADR 0012 §1)** : la première version bloquait tout retrait quand la base ne rendait aucun pair. Le test de la boucle l'a montré : il était alors impossible de révoquer le **dernier** routeur. Une seule règle demeure : au-delà de `max(5, 20 %)` retraits par tour, rien n'est retiré, sauf garde levée à la main.
- **`infra/nftables/wakatnet.nft`** : rien ne transite par `wg0`. En entrée, seuls 1812/1813 et ICMP sont acceptés depuis le tunnel ; en sortie, seuls 1700/3799 et ICMP. Le rechargement est atomique, et les autres interfaces ne sont pas touchées (anti-lockout).
- **`infra/systemd/wakatnet-wg-agent.service`** : seule capacité, `CAP_NET_ADMIN`. L'unité est vérifiée par `systemd-analyze` (matrice T).
- **Preuves** :
  - `apps/wg-agent/tests/run.sh` (pile neuve) : tests Go avec `-race` sur une **vraie** interface WireGuard (`wireguard-go`, le module du noyau étant absent du banc) ;
    - ajout, correction d'un `AllowedIPs` élargi, retrait d'un pair étranger, changement de clé, base injoignable sans aucun changement, interface jamais recréée ;
    - boucle complète contre PostgreSQL : ajout appliqué en **28 ms**, révocation en **25 ms**, avec un tour de filet réglé à 60 s ;
  - pare-feu prouvé dans des espaces de noms réseau. Sans les règles, r1 joint r2 **à travers** le nœud ; avec elles, plus jamais. Le nœud répond au ping, TCP 22 est rejeté et compté, la sortie vers 3799 est permise et vers un autre port refusée ;
  - `radius/tests/run.sh` (pile neuve, avec 0015) : 281 passés, SUCCÈS.
- **Constaté** :
  - l'archive Debian n'est pas joignable depuis ce conteneur (proxy CONNECT seul : 405 en HTTP). Le conteneur de test est donc construit sur Ubuntu 24.04, avec la chaîne Go recopiée de l'image officielle ;
  - `wireguard-go` exige `WG_I_PREFER_BUGGY_USERSPACE_TO_POLISHED_KMOD=1` sous Linux.
- **Non prouvé ici** : le module WireGuard du noyau sur un nœud Debian. `wgctrl` passe alors par netlink plutôt que par la socket de `wireguard-go`, avec la même API. À rejouer en phase 5.

### Phase 2, ticket 06 : révocation d'un routeur (12/11/2026)

- `POST /v1/routers/{id}/revoke` : idempotente, avec une seule entrée d'audit. Migration 0016 : `wk_api` peut modifier la **seule** colonne `actif`, et seulement sur ses routeurs (RLS).
- Effets prouvés :
  - en base, `client_lookup` ne rend plus le routeur (test HTTP) ;
  - sur le tunnel, le pair est retiré en 25 ms (`wg-agent`, ticket 05) ;
  - dans FreeRADIUS, le routeur est oublié au plus tard à l'expiration du client dynamique (`test_clients.py::test_l8_*`, phase 1).
- Sessions ouvertes : fermées comme sessions fantômes, puisqu'un Disconnect ne passerait plus (ticket 06 précisé).
- **Preuves** : `apps/api/tests/run.sh` (pile neuve) donne 46 tests, SUCCÈS. Ils couvrent la révocation, le 404 chez un autre propriétaire, et `wk_api` qui ne change que `actif` et seulement chez lui.

### Phase 2, ticket 07 : import Mikhmon ; revue de fin de phase (12/11/2026)

- **Import** : `POST /v1/imports/mikhmon`, avec un CSV (`name`, `password`, `profile`) et une correspondance « profil → forfait ».
  - Migration 0017 : colonne `origine`, forme du code selon l'origine (les tickets importés admettent 0, O, 1, I et L), et `app.voucher_importer` en **un seul appel par lot**.
  - Le rapport donne une ligne par entrée du CSV, et compte les codes courts.
  - Le rejeu ne crée aucun doublon.
- **Revue en deux axes** (deux agents qui n'ont pas écrit le code) :
  - **Bloquant**, confirmé par la matrice : `test_droits.py` ne connaissait pas `voucher_importer`. **Corrigé**.
  - **Important** :
    - l'import passait par une ligne SQL par entrée, dans une transaction interactive limitée à 5 s : un gros export Mikhmon aurait échoué. **Corrigé** : un appel par lot. **Mesuré** : 20 000 tickets en 1,24 s, et 20 001 lignes donnent 422 ;
    - le test d'isolement pouvait passer à vide (`plan`, `voucher` et `enrollment_token` vides). **Corrigé** : il remplit les six tables pour A et B, et vérifie qu'elles sont remplies ;
    - deux règles du pare-feu routeur n'étaient pas justifiées. **Justifiées** dans l'ADR 0012 §9, sans changement de code.
  - **Mineurs corrigés** :
    - `wk_api` ne lit plus `plan` ni `voucher` (moindre privilège) ;
    - un identifiant au-delà de 2^63 − 1 donne 401 ou 422 au lieu de 500 ;
    - 422 strict sur les corps invalides, et le corps d'un 404 est identique pour un jeton expiré, consommé ou inconnu ;
    - ADR §4 et §10, et `openapi.yaml` (401 et 403), alignés sur le code ;
    - walled garden reporté à la phase 3, et note sur l'ASCII des scripts, consignés dans l'ADR.
  - **Mineurs non corrigés, notés** :
    - la branche n'est pas `ticket/NN-titre` (livraison par une seule branche, décidée par Yacouba) ;
    - pas de PAP **à travers FreeRADIUS** pour un ticket importé : seul l'appel SQL à `radius.authorize` est testé, et c'est la même fonction ;
    - pas de test de bout en bout « révocation par l'API → NOTIFY → pair retiré » : chaque maillon est prouvé séparément.
  - **Point ambigu, à trancher par Yacouba** : l'enrôlement exige un hotspot déjà configuré. Le « CHR vierge » de la porte du §12 s'entend donc comme un CHR avec hotspot, mais sans utilisateur.
- **Preuves**, toutes depuis des piles neuves : `apps/api/tests/run.sh` (55 tests), `apps/wg-agent/tests/run.sh` (Go `-race` et pare-feu) et `radius/tests/run.sh` (281 passés) donnent SUCCÈS. shellcheck 0.10.0 ne relève rien sur les cinq scripts de test et de migration.

### État de la phase 2

1. Tests verts en une commande, sur trois bancs : **oui**.
2. Scripts audités par `mikrotik-routeros-config` : **oui** (`docs/AUDIT_SCRIPTS_ROUTEROS.md`).
3. Exécution sur CHR, vierge et déjà configuré : **non**. L'écart a été décidé par Yacouba, qui fera les essais à la fin. En dépendent : LABO-05, LABO-08 (vérification TLS de `/tool fetch` en 7.15, **critique**), LABO-14 et les points [LABO] de l'ADR 0012 §9.
4. Revue en deux axes : **faite**, constats traités.
5. Étiquette `phase-2` : **non posée**, elle attend le point 3.

### Ouverture de la phase 3 : portail et paiement, mode A (12/11/2026)

- Demande de Yacouba : « continue avec la phase 3 ». PRD et tickets 01 à 08 rédigés dans `.scratch/phase-3-portail-paiement/`, validés par délégation. Le ticket 08 (vrai adaptateur) est **en attente** de la piste B : réponses des agrégateurs et clés de bac à sable. La spec interdit de deviner une API (§7.3).
- ADR 0013 (contrats) :
  - `verify()` fait foi, et le webhook n'est qu'un déclencheur ;
  - grand livre en en-tête et lignes, équilibre vérifié à la validation, ajout seul imposé y compris au propriétaire des tables ;
  - comptes du mode A ;
  - commission arrondie au franc, 0,5 vers le haut ;
  - **écart avec D10, assumé** : pas de BullMQ en phase 3, une minuterie systemd suffit ;
  - portail servi par le processus de l'API, sur l'IP dédiée ;
  - garde contre une redirection ouverte pour l'auto-connexion.

### Phase 3, ticket 02 : grand livre (12/11/2026)

- `infra/sql/ledger/0018_ledger_socle.sql` (ADR 0013 §3 à §5) : en-tête et lignes, débit **ou** crédit sur chaque ligne, équilibre vérifié à la validation par des déclencheurs différés. **Ajout seul** : `UPDATE`, `DELETE` et `TRUNCATE` sont refusés par déclencheur, propriétaire des tables compris, et aucun rôle de connexion n'a de droit. `ledger.ecrire` est la seule porte, idempotente sur sa clé ; une même clé avec un autre contenu est refusée. `ledger.commission` arrondit au franc, 0,5 vers le haut. `migrer.sh` lit désormais aussi `infra/sql/ledger/`.
- **Trouvé et corrigé en exécution** :
  - un déclencheur différé s'exécute **à la validation, avec les droits du rôle de connexion**, et non ceux de la fonction `SECURITY DEFINER` qui a écrit. Les fonctions de vérification sont donc `SECURITY DEFINER`. Les tests du grand livre, lancés en superutilisateur, ne le voyaient pas ; ceux du paiement passent par `wk_api` et le couvrent ;
  - la clé étrangère `ledger.compte → app.tenant` faisait échouer la remise à zéro des tests de la phase 1 (`TRUNCATE … CASCADE` atteignait le grand livre). Elle est retirée, et le propriétaire est vérifié à la création du compte. Le grand livre survit ainsi à toute suppression applicative.
- **Preuves** : 7 tests de propriétés (fast-check 4.10.2) sur PostgreSQL réel, dont 60 suites aléatoires d'opérations avec doublons de clés :
  - soldes égaux au modèle ;
  - rejeu complet sans nouvelle ligne ;
  - Σ débits = Σ crédits, par transaction et en tout ;
  - écritures déséquilibrées et lignes invalides refusées sans trace ;
  - ajout seul vérifié ;
  - commission exacte sur la table du §8.1, les frais de l'ADR 0002 et 200 tirages contre une référence en `BigInt`.

### Phase 3, tickets 03 à 07 : paiement, crédits, rapprochement, portail, achat de bout en bout (12/11/2026)

- **`packages/payments`** : interface `FournisseurPaiement` (§7.3), normalisation XOF (A8) et `MockProvider` scriptable. Le scénario se lit dans les deux derniers chiffres du numéro. Le mock exige `WAKATNET_MOCK=1` et est refusé en production.
- **Migration 0019** :
  - paiement : trois formes du numéro, jeton d'appareil en empreinte, clé de soumission (P9) ;
  - CHECK « confirmé ⇔ ticket » ;
  - compte marchand chiffré par l'API (AES-256-GCM), webhook à identifiant aléatoire ;
  - `paiement_transition` : ligne verrouillée, idempotente ; vers `SUCCEEDED`, ticket, lien et commission dans **une** transaction (A7) ; `MISMATCH` final, avec alerte ;
  - crédits du mode A et découvert plafonné.
- **Migration 0020** : tâche périodique (expiration, rapprochement à 2 min puis toutes les 5 min pendant 24 h, frais papier, purge des numéros), lancée par une minuterie systemd.
- **Migration 0021** : récupération d'un achat (jeton d'appareil ; repli numéro + 4 caractères ; tentatives limitées, sérialisées et journalisées).
- **Portail** (`apps/api/src/portail.ts`) : pages de 1,6 à 2,5 Ko, sans ressource externe, CSP stricte. Il fonctionne sans JavaScript. Auto-connexion par GET, vers les seuls hôtes du hotspot relevés à l'enrôlement.
  - `routeros/hotspot/redirection.html` : page `login.html` du routeur, qui renvoie vers le portail, générée par site.
- **Relecture de l'argent par un second agent** (règle 4) : 1 bloquant, 4 importants, 8 mineurs. Tous traités ou acceptés avec leur motif (ADR 0013 §12). Le bloquant était le contournement de la limite de récupération par des requêtes parallèles.
- **Preuves**, depuis des piles neuves :
  - `apps/api/tests/run.sh` : 92 tests, SUCCÈS. Ils couvrent P1, P2, P3, P4, P5, P6, P7, P8 et P9, la propriété « confirmé ⇔ ticket ⇔ une commission » sur 40 paiements aléatoires, les crédits, le découvert, la suspension de la vente en ligne (un ticket existant reste accepté au plafond : test dû depuis le ticket 1.2), les frais papier (une fois, jamais rétroactifs, sans famine), la purge, la récupération et le contrat OpenAPI ;
  - `apps/api/tests/e2e.sh` : **Chromium sans interface**. Parcours : page de redirection du faux hotspot, portail, forfait, Moov, attente, ticket, auto-connexion GET, code accepté par `radius.authorize`. Puis P6 : page fermée pendant l'attente, et ticket proposé au retour. SUCCÈS ;
  - `radius/tests/run.sh` : 282 passés, SUCCÈS ;
  - shellcheck ne relève rien.
- **Non fait** :
  - ticket 08 (vrai adaptateur) : il attend les clés de bac à sable et la documentation officielle d'un agrégateur ;
  - P10 (reversements, mode B verrouillé).
- **Piste B (Yacouba)** :
  - mini-navigateurs iOS et Android : LABO-11 (lien `tel:`), LABO-12 (GET d'auto-connexion), LABO-14 ;
  - variables `-esc` de la page de redirection ;
  - `hotspot-address` et `dns-name` ;
  - références d'opérateur alphanumériques (récupération).
- **G-ARGENT n'est pas franchie** : il faut le ticket 08 en bac à sable et `docs/CONFORMITE.md` rempli.

### Revue complète de la phase 3 et corrections (12/11/2026)

- Demande de Yacouba : « full review and fix », après la fusion de la PR n°22.
- Trois relectures en parallèle, par trois agents qui n'avaient pas écrit le code : normes du dépôt, conformité à la spec, bugs et failles. Aucun bloquant. Plusieurs constats importants, dont un relevé par les trois : `verify()` n'avait pas de délai, si bien qu'un fournisseur muet aurait bloqué toute la tâche périodique.
- Corrections : migration `0022_app_revue_phase3.sql` (redéfinition des fonctions concernées, les migrations 0019 à 0021 étant immuables) et code. Le détail est dans l'ADR 0013 §13.
- **Trouvé en rejouant la matrice** : `test_t09.py::test_panne_de_radclient_visible_et_session_non_marquee` a échoué une fois. Le défaut vient de la phase 1 et ne dépend pas de la phase 3 : `radclient` qui meurt avant d'avoir lu son entrée provoque un `EPIPE` non rattrapé, et Node plante sans le message attendu.
  - **Reproduit de façon déterministe** : un enfant ferme son entrée pendant qu'on lui écrit 1 Mo. Sans garde : `EPIPE`, 3 fois sur 3. Avec garde : code de sortie 1, 3 fois sur 3.
  - **Corrigé** dans `infra/coupure/emetteur.ts` et `infra/coupure/coupure.ts` (`psql`) : une erreur sur l'entrée de l'enfant est ignorée, et son code de sortie fait foi.
- **Preuves**, toutes depuis des piles neuves :
  - `apps/api/tests/run.sh` : 102 tests, SUCCÈS ;
  - `apps/api/tests/e2e.sh` : Chromium, achat, auto-connexion et P6, SUCCÈS ;
  - `radius/tests/run.sh` : 282 passés, SUCCÈS ;
  - shellcheck ne relève rien.

### Ouverture de la phase 4 : exploitation commerciale (12/11/2026)

- Demande de Yacouba : « continue avec la phase 4 ». PRD et tickets 01 à 08 rédigés dans `.scratch/phase-4-exploitation/`, validés par délégation.
- ADR 0014 :
  - sessions côté serveur, avec cookie `SameSite=Strict` et en-tête anti-CSRF ;
  - scrypt pour les mots de passe ;
  - quatre rôles ;
  - TOTP pour le super-admin ;
  - tableau de bord React servi par l'API (même origine) ;
  - PDF et CSV sans dépendance ;
  - mode B verrouillé par un drapeau de plateforme ;
  - P10 sans écriture comptable du mode B.
- L'en-tête de développement de l'ADR 0012 §7 sera retiré.

### Phase 4, tickets 02 à 06 : comptes, rôles, forfaits, lots, argent, super-admin (12/11/2026)

- **Comptes** (migration 0023, `apps/api/src/auth.ts`) :
  - sessions côté serveur : cookie `HttpOnly; Secure; SameSite=Strict`, empreinte seule en base, 12 h glissantes et 7 jours au plus ;
  - en-tête anti-CSRF exigé ;
  - scrypt (N = 2^15) ; 5 échecs par adresse en 15 min ; même réponse que le compte existe ou non ;
  - quatre rôles, déclarés route par route ;
  - TOTP du super-admin écrit à la main et vérifié contre les vecteurs de la RFC 6238, sans rejeu possible ;
  - **en-tête de développement retiré** : les tests ouvrent de vraies sessions ;
  - script `admin-creer.ts`, essayé sur une base jetable : mot de passe lu sur l'entrée standard, URI TOTP affichée une fois.
- **Exploitation** (migration 0024, `exploitation.ts`, `admin.ts`, `pdf.ts`, `csv.ts`) :
  - forfaits, retirés de la vente au lieu d'être supprimés ;
  - sites et points de vente ; gérants et vendeurs ;
  - lots de tickets papier (refusés au plafond du découvert, ADR 0002), planche PDF A4 de 10 tickets, états généré, remis, activé, expiré ;
  - statistiques par point de vente et par auteur ;
  - synthèse d'argent ; relevé en CSV et en PDF, numéro masqué seulement ; facture mensuelle **provisoire** (mentions [À CONFIRMER]) ;
  - recherche par numéro par HMAC, journalisée ;
  - super-admin : propriétaires, rechargement idempotent, suspension et réglages audités, TOTP exigé.
- **Trouvé en exécution** : Prisma écrit toutes les colonnes d'une ligne. Les droits par colonne bloquaient donc la création d'un forfait. L'insertion sur `app.plan` est accordée en entier, bornée par la RLS. La création d'un utilisateur passe par une insertion SQL explicite, pour que `wk_api` ne puisse jamais écrire `totp_secret`.
- **Preuves**, depuis des piles neuves :
  - `apps/api/tests/run.sh` : 117 tests, SUCCÈS. Ils couvrent l'authentification, les rôles, le cloisonnement par point de vente, la validité des PDF (table xref vérifiée objet par objet), le CSV (BOM, injection de formules), la synthèse égale au grand livre au franc près, et le super-admin ;
  - `apps/api/tests/e2e.sh` : SUCCÈS ;
  - `radius/tests/run.sh` : 282 passés, SUCCÈS.

### Phase 4, tickets 07 et 08 : mode B verrouillé, P10, tableau de bord, parcours 1 à 5 (12/11/2026)

- **Mode B et reversements** (migration 0025, `apps/api/src/reversements.ts`, `payout` et `verifyPayout` du MockProvider) :
  - `settlement_mode = 'B'` est refusé par un déclencheur tant que le drapeau de plateforme est faux. Aucun rôle de connexion ne peut lire ni écrire ce drapeau. Il est relu à la création et au traitement, donc le rabaisser gèle aussi les reversements ;
  - P10 : écriture `EN_DOUTE` avant l'appel, `verifyPayout()` avant tout renvoi, renvoi sur « inconnu » seulement, par comparaison-échange, 5 envois au plus, reprise après 120 s au moins (plancher posé en base), requête annulée à l'expiration du délai ;
  - aucun appelant tant que le verrou tient. Les préalables à sa levée sont listés dans l'ADR 0014 §9 : rôle dédié, montant tiré du grand livre, plafonds du SPEC §8.3.
- **Tableau de bord** (`apps/dashboard`, React 18 et Vite, écrit par un sous-agent puis relu et intégré) :
  - servi par l'API sous `/tableau/` (`apps/api/src/tableau.ts`) : fichiers lus une fois au démarrage, CSP sans `unsafe-inline` ;
  - parcours 1, 2, 4 et 5 joués dans Chromium par `tests/e2e/tableau.ts`, avec audit axe-core 4.14.0 de 11 écrans et contrôle des PDF par `pdftotext`.
- **Relecture du code d'argent par un second agent (règle 4)** : aucun point bloquant, quatre importants, tous corrigés et testés :
  - I1 : la garde d'âge était réglable par l'appelant et le délai abandonnait la requête sans l'annuler ;
  - I2 : une erreur sur un reversement arrêtait tout le tour ;
  - I3 : le drapeau n'était pas relu à la création ;
  - I4 : **une vente en ligne était datée par `payment.maj_le`**, que `paiement_retrouver` remet à l'heure courante, et pouvait quitter le relevé déjà remis de son mois. Migration 0026 : colonne `confirme_le`, posée une fois par déclencheur.
  - Corrigés aussi : une date impossible (`2026-02-30`) était décalée sans erreur, et un `payout()` « inconnu » était classé `SENT`.
  - Laissés, consignés : une écriture `correction` ne sera pas rattachée à sa nature (latent, aucune n'est écrite aujourd'hui), et la ligne « tickets papier activés » ne compte pas les tickets importés.
  - P10 est **resserrée** : l'ADR permettait un renvoi sur « échoué », ce qui devient un verdict définitif.
- **Trouvé par l'e2e**, invisible aux tests de l'API :
  - `POST /v1/sites` répondait 500 : Prisma relit la ligne insérée, ce que le droit par colonne refuse. Corrigé par une insertion explicite, et un test a été ajouté ;
  - le ticket papier portait « Ticket Wi-Fi » au lieu du nom du site ;
  - la phrase du bas du ticket débordait sur le ticket voisin. Les largeurs sont désormais les chasses AFM de Helvetica, et un test de propriété prouve qu'aucune ligne coupée ne dépasse.
- **Preuves**, depuis des piles neuves :
  - `apps/api/tests/run.sh` : 134 tests, SUCCÈS ;
  - `apps/api/tests/e2e.sh` : achat et parcours 1, 2, 4 et 5, SUCCÈS ; axe-core ne relève aucune violation sur 11 écrans ;
  - `radius/tests/run.sh` : 282 passés, SUCCÈS ;
  - shellcheck ne relève rien sur les scripts modifiés.
- **Restent bloqués** : G-ARGENT, qui attend l'adaptateur réel (ticket 3.08) et `docs/CONFORMITE.md` ; les mentions fiscales et la numérotation de la facture ([À CONFIRMER]) ; les écritures du grand livre pour le mode B.

### Phase 5 : haute disponibilité et durcissement (12/11/2026)

- **Demande** de Yacouba : « continue avec la phase 5 ». PRD, tickets 01 à 08 et ADR 0015, validés par délégation.
- **T13 et bascule** (tickets 02, 03) :
  - réplication physique asynchrone A → B par une interface WireGuard dédiée (`wk-noeuds`) ;
  - `post_auth` muet sur une réplique (migration 0027) ;
  - spool d'accounting vidé dans le primaire, où qu'il soit (liste d'hôtes et `target_session_attrs`, lu dans `rlm_sql_postgresql.c`) ;
  - promotion manuelle gardée, puis retour de A par `pg_rewind` (rôle `wk_rewind` aux droits minimaux) ;
  - `docs/RUNBOOK.md`.
- **Sauvegardes** (ticket 04) :
  - pgBackRest chiffré, sur le primaire. ADR corrigé : la sauvegarde n'est pas prise sur B, ce qui aurait exigé un canal SSH ou TLS ;
  - essai de restauration mensuel, qui compare le grand livre sauvegardé à la base vivante, ligne par ligne.
- **Supervision** (ticket 05) : collecteur `sante.ts` (rôle `wk_sante`, comptes seulement), alertes Telegram au changement d'état, page publique `/etat`, rotation des compteurs de silence.
- **Déploiement** (ticket 06) : rôles Ansible, sans aucun secret ; garde contre l'effacement d'un primaire ; nftables sans `flush ruleset`, qui effacerait Docker.
- **Charge** (ticket 07) : `docs/CHARGE.md`.
- **Revue de sécurité** par un agent qui n'a pas écrit le code (ticket 08) : `docs/REVUE_SECURITE.md`.
  - Aucun constat critique.
  - Corrigés et testés : E1 (double primaire après une bascule), E2 (TOTP deviné sans limite), M2 (verrou des connexions contourné en parallèle), M3 (retrait de l'accès d'un vendeur), M5 (MAC et page demandée dans les journaux), M6 (essai de restauration sans alerte), F6, F7, F8.
  - Attendent une décision : M1 et M7 (limitation de débit), M4 (quotas, vérification d'adresse), M8 (verrouillage des sauvegardes chez le fournisseur S3).
- **Trouvé en exécution** :
  - un test qui rejoue la migration 0012 réinstallait l'ancien `post_auth`. Il rejoue désormais aussi 0027 ;
  - deux matrices lancées en même temps se gênaient : une seule à la fois ;
  - la garde contre le double primaire tournait en root (l'unité de Debian n'a pas de `User=`) et laissait passer : vu au banc Ansible, corrigé ;
  - la reconstruction d'une réplique effaçait le répertoire de données avant l'arrêt complet de PostgreSQL : on attend désormais `postmaster.pid` ;
  - dans le PDF des tickets, le nom du site manquait et le texte débordait (vu par l'e2e de la phase 4).
- **Preuves**, depuis des piles neuves :
  - `radius/tests/run.sh` : 286 passés, SUCCÈS. T13 ; promotion refusée tant que A répond ; arrêt de A → B primaire et fumée en 6,9 s ; retour de A par `pg_rewind` en 0,7 s ;
  - `apps/api/tests/e2e.sh` : achat, puis parcours 1, 2, 4 et 5, SUCCÈS. La page de redirection sans MAC ni IP mène bien au portail ;
  - `apps/api/tests/run.sh` : 146 tests, SUCCÈS ;
  - `infra/noeud/essais/sauvegarde.sh` : SUCCÈS. Restauration chronométrée en 3,9 s pour 349 Mo ; altération du grand livre détectée et nommée ;
  - `infra/ansible/essais/essai.sh` : SUCCÈS, sept étapes. ansible-lint, profil production, sans remarque ;
  - charge : `perf.sh` (phase `ha`) et `apps/api/tests/charge.sh`.
- **Non prouvé ici**, et à rejouer par Yacouba avant G-PILOTE :
  - Debian 13 sur VM ;
  - module WireGuard du noyau ;
  - paquets de l'éditeur de FreeRADIUS ;
  - transport S3 ;
  - envoi réel vers Telegram ;
  - LABO-16 et LABO-09 sur CHR ;
  - B chez un second hébergeur (ADR 0004).

### Phase 6 : préparation du pilote (12/11/2026)

- **Demande** de Yacouba : « continue avec la phase 6 ». Pas de PRD (SPEC §14.3) : le pilote se joue sur le terrain. L'agent livre les outils et les procédures, et s'arrête aux portes.
- **Rapprochement quotidien** (`apps/api/src/rapprochement.ts`, `docs/PILOTE.md` §4) : code d'argent, donc tests de propriétés et relecture par un second agent (règle 4).
  - Première relecture : trois cas disaient « écart nul » alors qu'un franc manquait (B1 paiement de 23:55 sans encaissement, B2 statut inconnu lu comme un échec, B3 ligne CSV mal découpée), plus I1 à I4. Tous corrigés.
  - Contre-relecture : tous fermés ; deux nouveaux cas importants corrigés (N1 second encaissement sous la référence d'un paiement d'un autre jour, N2 virgule finale dans `--echec`), et N3 (commission figée recalculée au taux et au plancher), N4, N5 (dates impossibles), lancement par lien symbolique.
- **Mise en production** (ADR 0016) : API en service systemd derrière nginx (écart assumé avec D7) ; filtrage par `Host`, limites par IP, TLS Let's Encrypt ; pare-feu public en `drop` avec retour arrière programmé avant chargement. Ferme M1 et F10, F5 ; réduit M7.
- **Procédures** : `docs/PILOTE.md`, `docs/MISE_EN_PRODUCTION.md`, `docs/ONBOARDING_ROUTEUR.md`.
- **Preuves** :
  - `apps/api/tests/run.sh` : 158 tests, SUCCÈS (rapprochement de bout en bout sur une vraie base, `TZ=Europe/Paris`, chemin avec espace et accent) ;
  - `infra/ansible/essais/essai.sh` : SUCCÈS, neuf étapes (nginx : `Host`, `X-Forwarded-For`, 429 à la 7e connexion ; pare-feu) ; ansible-lint, profil production, sans remarque ;
  - `systemd-analyze verify` sur `wakatnet-api.service`.
- **Portes : G-ARGENT et G-PILOTE FERMÉES** (`docs/PILOTE.md` §2). Arrêt obligatoire : rien ne touche à un franc réel ni au routeur d'un tiers sans Yacouba.
- **Non prouvé ici** : scripts RouterOS sur CHR, Debian 13, vrai VPS, Let's Encrypt réel, format du relevé de l'agrégateur.

### Revue de sécurité, M2 et M7 : limites par source (12/11/2026)

- **Demande** de Yacouba : il n'existe pas de phase 7 au SPEC (§12 s'arrête au pilote). Parmi les trois pistes proposées sans franchir de porte, il a retenu « fermer M2 et M7 ».
- **Migration 0031** et `apps/api/src/cle-ip.ts` :
  - source = IPv4, ou /64 d'une IPv6 (un abonné en reçoit un entier ; compter par adresse ne le limiterait pas). Gardée en HMAC du jour, jamais en clair ;
  - M7 : garde des paiements par (site, source), plafond de 100 par minute et par site ;
  - M2 : 5 essais par (adresse, source), 10 par adresse pour les sources inconnues ; cookie d'appareil connu, posé à une connexion réussie, avec son propre budget ;
  - l'API refuse de démarrer en production sans `WAKATNET_TRUST_PROXY` ; nginx compte lui aussi par /64 ; Ansible redémarre l'API après les migrations.
- **Relu par un second agent** (règle 4) sur la première version :
  - elle ne faisait que déplacer le blocage d'un compte (6 /64 suffisaient) : le cookie d'appareil connu répond ;
  - plafond de paiements à 300 : régression contre l'envoi massif de demandes, ramené à 100 ;
  - IP gardée en clair et reliable au paiement par l'horodatage : remplacée par le HMAC du jour ;
  - et : nginx comptait par adresse IPv6 entière, l'API pouvait tourner sur l'ancien code après la migration, la purge n'avait pas d'index, la documentation était périmée.
- **Restes, honnêtes** :
  - M7 n'est que réduit : 4 sources bloquent encore un site. Le fermer demande l'IP publique du routeur, vue par `wg-agent` : décision de Yacouba ;
  - M2 : un titulaire sans appareil connu attend 15 min pendant une attaque d'au moins 2 sources.
- **Preuves** :
  - `apps/api/tests/run.sh` : 165 tests, SUCCÈS. Dont 40 demandes parallèles d'une source → 30 acceptées, appareil connu qui passe une attaque distribuée, en-tête `X-Forwarded-For` forgé hors du proxy non cru ;
  - `radius/tests/run.sh test_droits.py` : 12 passés ;
  - `apps/api/tests/e2e.sh` : SUCCÈS ;
  - `infra/ansible/essais/essai.sh` : SUCCÈS, neuf étapes ; ansible-lint, profil production, sans remarque.
- **Non prouvé** : la clé /64 de nginx sur une vraie IPv6 (le banc tourne en IPv4 seulement ; `nginx -t` valide la syntaxe).

### Guide imprimable du propriétaire et du vendeur (12/11/2026)

- **Demande** de Yacouba : « fais le point 3 » (SPEC §14.4, guide du propriétaire et du vendeur pour le pilote).
- **Livré** : `docs/guides/guide-pilote.html` (source), `docs/guides/imprimer.mjs` (rendu par Playwright et Chromium), `docs/guides/guide-pilote.pdf` (6 pages A4).
  - Partie 1, propriétaire : compte, raccordement, page de connexion, forfaits, points de vente, tickets papier et leur coût, vente en ligne (pas encore ouverte), suivi de l'argent ;
  - partie 2, vendeur, sur une page : connexion, vente, aide au client, mémo de caisse ;
  - partie 3 : dépannage, retrait d'un routeur, sécurité.
- **Vérifié** : chaque libellé de bouton et d'écran cité a été relevé dans `apps/dashboard/src`, et les droits du gérant et du vendeur dans `apps/api/src/exploitation.ts`. Rendu relu page par page.
- **Trouvé en l'écrivant** : la coupure de l'accès d'un vendeur (M3) existe dans l'API (`PUT /v1/utilisateurs/:id`), mais **aucun écran** ne l'offre. Le guide dit d'appeler Telecom Universel.
- **Non vérifié** : la compréhension par un vrai propriétaire, à éprouver au premier accueil. Les étapes sur le routeur suivent `docs/ONBOARDING_ROUTEUR.md`, qui n'a pas encore été joué sur CHR.

### Écran : couper l'accès d'un gérant ou d'un vendeur (12/11/2026)

- **Demande** de Yacouba, après le guide du pilote, qui avait montré le manque : M3 existait dans l'API, mais sans écran.
- **Fait** : écran « Points de vente et vendeurs », colonne Actions.
  - Bouton « Couper l'accès », puis « Confirmer la coupure » ou « Annuler », sur le modèle de la révocation d'un routeur.
  - Il appelle `PUT /v1/utilisateurs/:id { actif: false }`. L'état passe à « Suspendu ».
- **Preuve** : `apps/api/tests/e2e.sh`, SUCCÈS. Au parcours 4, le propriétaire coupe l'accès du vendeur depuis l'écran ; ses sessions sont fermées en base ; sa reconnexion est refusée (401). axe-core : 12 écrans sans violation sérieuse, dont la confirmation.
- **Guide** mis à jour, PDF régénéré (6 pages) ; `docs/REVUE_SECURITE.md` (M3) mis à jour.
- **Constaté** : le démon Docker de l'environnement s'est encore arrêté ; relancé avant l'e2e.

### Revue de sécurité M7 : budget propre à l'IP publique du routeur (12/11/2026)

- **Demande** de Yacouba : « ferme M7 avec l'IP du routeur vue par wg-agent ».
- **Fait** :
  - `wg-agent` relève le point de terminaison de chaque pair de `wg0` (poignée de main de moins de 3 min) et l'écrit par `app.wg_points_noter`. Sans effet sur une réplique ; au plus une écriture par routeur toutes les 5 min ; IP effacée à la révocation, ou après un jour sans être revue. Les IP ne sont pas journalisées ;
  - migration 0032 : une demande qui vient de l'IP d'un routeur actif du site, vue il y a moins de 10 min, a son propre budget (30 par minute), hors plafond. IPv4 : égalité ; IPv6 : même /64 ;
  - règle de santé `ip_routeurs` : sur le primaire, routeurs actifs mais aucune IP notée.
- **Relu par un second agent** (règle 4) ; constats repris :
  - D1 : `DROP` de l'ancienne signature, donc paiements en erreur entre la migration et l'API. Corrigé par `p_ip DEFAULT NULL`, et un test appelle l'ancienne signature ;
  - H1 et D2 : le plafond des autres sources, que j'avais baissé à 60, aurait affaibli la garde quand le routeur n'est pas reconnu. Remis à 100, avec l'alerte ;
  - P1 : IP du routeur gardée sans limite. Désormais effacée ;
  - une IPv6 à zone faisait échouer tout le lot : écartée.
- **Reste de M7, honnête** : un voisin de NAT ou de CGNAT de même IP publique partage le budget du routeur et peut le vider ; un routeur non reconnu (double WAN, CGNAT qui sépare TCP et UDP, clients en IPv6, `wg-agent` arrêté) retombe sur la garde de 0031.
- **Preuves** :
  - `apps/wg-agent/tests/run.sh` : SUCCÈS. Dont une **vraie poignée de main** entre deux `wireguard-go` : l'agent note l'IP du « routeur » en base en 6,4 s, la base la reconnaît pour son site, puis plus du tout une fois le routeur révoqué ;
  - `apps/api/tests/run.sh` : 168 tests, SUCCÈS. Dont : le hotspot achète alors que 100 sources saturent le site, budget propre de 30, IP périmée, routeur révoqué ou d'un autre site, /64, écritures bornées de `wg_points_noter` ;
  - `radius/tests/run.sh test_droits.py` : 12 passés ;
  - `apps/api/tests/e2e.sh` : SUCCÈS.
- **Non prouvé** : l'hypothèse de terrain (les clients d'un hotspot sortent vers le portail par l'IP du tunnel du routeur) sur un vrai MikroTik et un vrai opérateur. À vérifier au pilote : la règle `ip_routeurs` et `paiement_demande.routeur` le montrent.

### Revue de sécurité M4 : quota d'enrôlement et vérification de l'adresse (12/11/2026)

- **Demande** de Yacouba : « tranche M4 : quota de routeurs et vérification de l'e-mail ». Décision : `docs/adr/0017-quota-et-verification.md`.
- **Constaté en lisant le code** :
  - un enrôlement s'obtient sans routeur (jeton, puis clé tirée au hasard) et consomme une adresse de l'overlay jamais réemployée ;
  - un quota sur les seuls routeurs actifs ne protège donc de rien, et un quota par compte, sans vérification de l'adresse, se contourne en ouvrant d'autres comptes.
- **Fait** (migration 0033) :
  - quota par propriétaire, 10 par défaut, réglable par le super-admin ; il compte les routeurs enrôlés, révoqués compris, et les jetons ouverts, sous verrou ;
  - raccorder un routeur exige une adresse vérifiée, par un lien (jeton de 256 bits, 24 h, usage unique, consommé au clic seulement ; 3 liens par heure, 5 en tout) ou par le super-admin ;
  - envoi d'e-mails derrière une interface : aucun fournisseur choisi, donc validation par le super-admin pendant le pilote ;
  - alerte `overlay_plein` à 80 % ;
  - écrans : bandeau « Adresse e-mail à confirmer » avec « Renvoyer le lien », page « Confirmer mon adresse », Administration (état de l'adresse, « Valider l'adresse », quota).
- **Relu par un second agent** : M4 est fermé tant que la vérification se fait à la main. Corrigés :
  - C2 : envoi répété d'e-mails à l'adresse d'un tiers ;
  - C3 : comptes ouverts avant la migration ;
  - C4 : message d'erreur du fournisseur dans le journal ;
  - C5 : inscription en échec si l'envoi échoue ;
  - C6 : purge des liens.
  
  C1 (adresses jetables une fois le lien en service) devient une liste de conditions dans l'ADR, à remplir avant de brancher un fournisseur.
- **Trouvé en l'éprouvant** :
  - une table sans clé primaire rendait `prisma db pull` instable. Clé ajoutée ; deux régénérations donnent le même fichier ;
  - une régénération sur un schéma devenu invalide échouait sans rien dire, car sa sortie était masquée : schéma repris de la version commitée.
- **Preuves** :
  - `apps/api/tests/run.sh` : 174 tests, SUCCÈS. Dont : quota avec routeur révoqué et jeton expiré ; 12 commandes parallèles pour un quota de 4, donc 4 acceptées ; adresse non vérifiée (403) ; lien d'inscription suivi ; lien rejoué ou expiré ; limites de 3 par heure et 5 en tout ; validation par le super-admin, auditée ;
  - `radius/tests/run.sh test_droits.py` : 12 passés ;
  - `apps/api/tests/e2e.sh` : SUCCÈS. Le parcours 1 suit le lien dans le navigateur avant d'obtenir la commande d'enrôlement ; axe-core : 14 écrans sans violation sérieuse.
- **Guide du pilote** mis à jour (étape 1, dépannage), PDF régénéré (6 pages).
- **Reste** : F9 accepté pour l'instant ; fournisseur d'e-mail à choisir (Yacouba), avec les conditions de l'ADR 0017.

### Revue de sécurité M8 : sauvegardes verrouillées (12/11/2026)

- **Demande** de Yacouba : « tranche M8 : fournisseur S3 avec verrouillage ». Décision : `docs/adr/0018-sauvegardes-verrouillees.md`.
- **Vérifié sur sources** :
  - pgBackRest relit un dépôt S3 **versionné** tel qu'il était à une date donnée (`--repo-target-time`, depuis la 2.54) ;
  - la 2.59.2 corrige cette relecture au-delà de 1 000 versions (#2854) ;
  - Backblaze B2 documente l'Object Lock en mode conformité, irréversible ;
  - Cloudflare R2 n'a pas d'Object Lock ; Wasabi facture 90 jours minimum par objet.
- **Décidé** :
  - Backblaze B2, région EU Central : fournisseur de stockage seulement, jamais hébergeur de A ni de B ;
  - bucket versionné, verrouillé en mode conformité 30 jours ; clé des nœuds sans droit sur les réglages du bucket ;
  - pgBackRest 2.59.2 au moins, contrôlé par Ansible ;
  - procédure « Restaurer après l'effacement du dépôt » (RUNBOOK §7), et exercice sur B2 avant G-PILOTE.
- **Prouvé** par le banc `infra/noeud/essais/sauvegarde-s3.sh` (Ubuntu 26.04, pgBackRest 2.58, S3 de test moto derrière nginx) :
  - avec les clés du nœud, l'attaquant efface la stanza et tous les objets ;
  - ses 986 effacements définitifs de versions sont refusés ;
  - `--repo-target-time` retrouve la sauvegarde, et la base revient avec sa ligne témoin.
- **Trouvé en l'éprouvant** :
  - l'image MinIO n'existe plus sur Docker Hub, d'où moto ;
  - le serveur TLS intégré de moto ferme ses connexions sans la notification TLS de fin, ce qu'OpenSSL 3 refuse : nginx placé devant ;
  - pgBackRest refuse `--target-action` sans type de cible ;
  - le banc Ansible échouait dès que l'image en cache avait plus d'une heure (apt hors ligne) : la liste des paquets est désormais datée au démarrage.
- **Autres preuves** :
  - `infra/noeud/essais/sauvegarde.sh` : SUCCÈS ;
  - `infra/ansible/essais/essai.sh` : SUCCÈS, neuf étapes ; ansible-lint, profil production, sans remarque.
- **Non vérifié** : B2 lui-même (en-têtes exigés par un bucket verrouillé, prix, nom de région). D'où l'exercice de mise en service.

### Fournisseur d'e-mail : Brevo, et les protections de l'ADR 0017 (12/11/2026)

- **Demande** de Yacouba : « tranche le fournisseur d'e-mail ». Décision : `docs/adr/0019-fournisseur-email.md`.
- **Sources consultées** :
  - Brevo : 300 e-mails par jour gratuits, API v3 stable, données en France et en Allemagne ;
  - Scaleway TEM : API encore en `v1alpha1` ;
  - Mailjet : convient, sans avantage sur Brevo ;
  - Postmark et Resend : données aux États-Unis ;
  - Amazon SES : gratuit seulement la première année.
- **Adaptateur** `ExpediteurBrevo` (`fetch`, sans dépendance) :
  - la clé ne passe que dans l'en-tête ;
  - aucune redirection suivie, corps des réponses jamais lu, délai de 10 s ;
  - réglage `WAKATNET_COURRIEL=brevo` ; sans lui, aucun envoi.
- **Conditions de l'ADR 0017, remplies** (migration 0034) :
  - inscription sans session, à réponse identique (ferme **F9**) ;
  - connexion refusée avant confirmation, avec le message d'un mauvais mot de passe ;
  - renvoi du lien sans session ;
  - limites par source (/48 en IPv6) ;
  - quota de 2 pour un compte neuf, 10 après validation ;
  - pour les comptes non validés : plafond de 100 routeurs enrôlés par jour, et arrêt à 90 % de l'overlay.
- **Relu par un second agent** ; corrigés :
  - un tiers bloquait un compte neuf en 5 inscriptions : avis compté à part, 1 par jour ;
  - envoi en masse vers des tiers : plafond global de 200 e-mails par jour, alerte `courriels` ;
  - adresse occupée pour toujours : libérée après 7 jours sans confirmation, rien n'est effacé ;
  - quota de 2 contourné par les comptes existants ;
  - ancienne API qui rouvrait F9 : `app.inscription` retirée à `wk_api` ;
  - plafond global épuisé par des jetons jamais consommés : il compte désormais les routeurs enrôlés ;
  - baisser le quota validait le compte ;
  - minutage : l'envoi part en arrière-plan ;
  - redirection qui aurait emporté la clé ;
  - suivi des clics de Brevo à désactiver (consigné).
- **Preuves** :
  - `apps/api/tests/run.sh` : 184 tests, SUCCÈS. Dont l'adaptateur contre un faux serveur, la réponse identique (adresse libre ou prise), la connexion refusée avant confirmation, les limites par source, le quota de 2, le plafond global, le seuil des 90 % (overlay rempli pour de bon, puis vidé), la libération d'adresse et le plafond d'e-mails ;
  - `radius/tests/run.sh test_droits.py` : 12 passés ;
  - `apps/api/tests/e2e.sh` : SUCCÈS. Inscription sans session, connexion refusée, lien suivi, connexion, raccordement ; axe-core : 13 écrans.
- **Non vérifié** : Brevo lui-même (délivrabilité vers Gmail et Outlook depuis le Burkina, mention de marque sur l'offre gratuite, restriction des clés par IP, DPA).

### G-ARGENT préparée : adaptateur réel pawaPay v2 (12/11/2026)

- **Demande** de Yacouba : « tranche G-ARGENT : prépare l'adaptateur réel ». Décision : `docs/adr/0020-adaptateur-pawapay.md`.
- **G-ARGENT reste fermée** : elle exige aussi `docs/CONFORMITE.md` (contrat, avis juridique, autorisations), qui revient à Yacouba.
- **Choix** : pawaPay, premier du classement de D2.
- **Réseau** : la documentation était bloquée par l'environnement par défaut. Un environnement personnel « WAKATNET » (réseau par défaut + `docs.pawapay.io`) a été créé avec l'accord de Yacouba. L'outil de lecture web résolvait encore mal le domaine ; la documentation a été téléchargée en Markdown par le proxy de la session (`llms.txt`), puis dépouillée par un agent, en citant les pages.
- **Ce que la documentation a changé** :
  - `depositId` en UUID v4, d'où une dérivation depuis notre référence ;
  - montant rendu en « 100.00 », que l'ancienne normalisation aurait classé en écart ;
  - signature RFC 9421 sur la méthode, l'hôte et le chemin, d'où la requête transmise à `parseWebhook`, devenu asynchrone ;
  - signature en DER ;
  - `NOT_FOUND` vaut un échec sûr.
- **Fait** :
  - `packages/payments/src/pawapay.ts` ;
  - fabrique et garde de l'argent réel (`WAKATNET_ARGENT_REEL`, posée par Yacouba après G-ARGENT) ;
  - vérification du compte à l'enregistrement ;
  - écran « Compte marchand » ;
  - migration 0035.
- **Relu par un second agent** (règle 4) ; corrigés :
  - bac à sable en production : tickets délivrés avec des numéros de test publics ;
  - changement de compte avec des paiements ouverts ;
  - relecture des clés non bornée ;
  - callback sans `clientReferenceId` ;
  - `UNKNOWN_ERROR` classé comme refus ;
  - adresse de test.
- **Preuves** :
  - `apps/api/tests/run.sh` : 194 tests, SUCCÈS. Dont des tests de propriétés (UUID, montants), une vraie paire de clés ECDSA, des callbacks falsifiés refusés, et un achat de bout en bout jusqu'au ticket ;
  - `radius/tests/run.sh test_droits.py` : 12 passés ;
  - `apps/api/tests/e2e.sh` : SUCCÈS. Écran « Compte marchand », argent réel refusé ; axe-core : 14 écrans.
- **Non prouvé** : le bac à sable réel de pawaPay (jeton de Yacouba, sur une plateforme d'essai), le format réel des callbacks signés, le minimum du Burkina, le relevé pour le rapprochement.

## 12/11/2026 — ADR 0021 proposée : intégration continue

- **Constat** : aucun workflow GitHub. La PR #28 (code d'argent) n'a aucune vérification, et toutes les preuves viennent d'un seul poste.
- **Proposé** (`docs/adr/0021-integration-continue.md`, statut « proposé ») : GitHub Actions sur `ubuntu-24.04`, qui appelle les harnais existants. API, e2e, RADIUS et wg-agent à chaque PR ; Ansible, sauvegardes et charge chaque nuit. Aucun secret, permissions en lecture, actions épinglées par empreinte. Écartés : un runner auto-hébergé (exclu sur un VPS de production) et le statu quo.
- **Non vérifié** : la durée des harnais sur un runner hébergé, la visibilité du dépôt et le forfait de minutes, le banc Ansible privilégié sur le runner.
- **En attente** : la décision de Yacouba. Aucun workflow écrit.

## 12/11/2026 — ADR 0021 décidée (option A) : workflows de CI écrits

- **Fait** :
  - `.github/workflows/ci.yml` : `api`, `e2e`, `radius` et `wg-agent` sur chaque PR et chaque poussée vers `main` ;
  - `.github/workflows/nuit.yml` : `ansible`, `sauvegarde` (posix puis S3 verrouillé) et `charge`, à 02:17 UTC et à la demande ;
  - P6 amendée : « tests verts » veut dire désormais les statuts de la CI.
- **Durcissement** : `permissions: contents: read`, aucun secret, `persist-credentials: false`, actions épinglées par empreinte (checkout v7.0.1, setup-node v7.1.0), `ubuntu-24.04`, Node 22.23.4, délai par job.
- **Écart trouvé** : Playwright (1.63.0) n'est pas dans `package-lock.json`. Il vient d'une installation globale sur le poste de développement. Le job l'installe en version épinglée ; l'ajouter au verrou reste à faire.
- **Vérifié** : analyse YAML (déclencheurs, permissions, runner, délais, empreintes de 40 caractères).
- **Non vérifié** :
  - `actionlint` : téléchargement refusé dans la session ;
  - `shellcheck` : absent du poste ;
  - aucun run sur GitHub tant que la branche n'est pas poussée. Les durées et le banc Ansible privilégié restent à confirmer au premier run.
- **Premier run de la CI** (`63e5841`) : `api` et `wg-agent` verts. `e2e` en échec : `genere/prisma/client.ts` est introuvable. Le client Prisma est ignoré par git et n'existait que sur le poste de développement. Échec reproduit en local en retirant `apps/api/genere`. Correctif : `e2e.sh` et `charge.sh` génèrent le client (`npm run generer`), comme `tests/Dockerfile`. Après correctif, `e2e.sh` est en SUCCÈS en local, à partir d'un client absent.
- **Playwright verrouillé** : `playwright` 1.63.0 (version exacte) dans les `devDependencies` de `apps/api`. Le job `e2e` ne télécharge plus que Chromium, et l'installation globale par `NODE_PATH` a disparu.
  - Preuves : `e2e.sh` lancé sans `NODE_PATH` : SUCCÈS (résolu depuis `node_modules`, 1.63.0) ; `apps/api/tests/run.sh` : 194/194.

## 12/11/2026 — Premier run des bancs de nuit (ADR 0021, point 3)

- **Run** : `nuit` lancé à la main sur `main` (45d5c45). Résultat : `ansible`, `sauvegarde` et `charge` en échec.
- **`ansible` et `sauvegarde`** : `apt-get` sort en 100 pendant la construction de l'image.
  - Cause : `Dockerfile.noeud` et `Dockerfile.sauvegarde` passaient les dépôts apt en `https://` dans tous les cas, alors que `ubuntu:24.04` n'a aucune autorité de certification (`ca-certificates` absent, vérifié). Sur le poste de développement, le certificat du proxy, monté comme secret, masquait le défaut.
  - Reproduit : apt en HTTPS sans certificat → « Certificate verification failed ».
  - Correctif : HTTPS seulement si le certificat est monté, comme le faisait déjà `Dockerfile.s3`. Sinon, http, dont les index restent signés par GPG.
- **`sauvegarde-s3.sh`**, joué sans certificat : 502 sur `CreateBucket` au premier démarrage d'une image neuve.
  - Cause : la boucle d'attente (`curl -sk`, sans `-f`) acceptait la 502 de nginx alors que moto, derrière lui, n'était pas prêt.
  - Correctif : `curl -skf`, 30 s au plus, puis échec explicite avec le journal de moto.
- **`charge`** : toutes les mesures sont bonnes (0 erreur, 2 001 paiements confirmés), mais le banc sortait en code 1.
  - Cause : `grep -c` sort en 1 quand il ne trouve rien, ce qui, sous `pipefail`, faisait échouer le banc quand il n'y avait aucune erreur. Le code de retour n'avait jamais été regardé en phase 5. Reproduit en local : code 1.
  - Correctif : le compte est lu, le banc échoue s'il y a au moins une erreur interne, et affiche SUCCÈS sinon.
- **Preuves**, sur le poste, avec le certificat masqué (`unshare` + `mount --bind /dev/null`), donc comme en CI :
  - `sauvegarde.sh` : SUCCÈS ;
  - `sauvegarde-s3.sh` : SUCCÈS, image reconstruite sans cache ;
  - `essai.sh` (Ansible) : SUCCÈS ;
  - `charge.sh` : code 0, SUCCÈS.
- **Non prouvé** : le banc Ansible sur un runner GitHub (conteneurs systemd privilégiés), qui n'a pas encore dépassé la construction de l'image.
- **Confirmé sur GitHub** (`0875067`) :
  - `nuit` (run 43327951145) : `ansible`, `sauvegarde` et `charge` verts. Le runner accepte les conteneurs systemd privilégiés du banc Ansible ;
  - `ci` : `api`, `e2e`, `radius` et `wg-agent` verts.
  - Le point 3 de l'ADR 0021 est clos.

## 12/11/2026 — Rapprochement : relevé pawaPay (ADR 0020, PILOTE.md §4)

- **Constat** : d'après la documentation de pawaPay (Dashboard > Statements, lue le 12/11/2026), le relevé est le **journal du portefeuille** (`Creation date, MSISDN, Transaction ID, Amount, MNO, Type, Balance, Reason, Metadata`), et non une liste de paiements. On y trouve : aucune colonne de statut, aucun dépôt échoué, des lignes de frais séparées, des retraits sans référence, et des montants probablement en « 100.00 ». L'outil de rapprochement, tel qu'il était, ne pouvait pas le lire : il sortait en code 2 tous les jours.
- **Fait** (`apps/api/src/rapprochement.ts`) :
  - `--hors-paiement TYPE,…` : lignes totalisées par type au rapport, ni rapprochées ni comptées comme écarts ;
  - `--echec` facultatif ;
  - « N.00 » accepté pour un encaissement, une décimale non nulle restant refusée ;
  - profil pawaPay dans `PILOTE.md` §4.
- **Relu par un second agent** (règle 4) : aucun bloquant.
  - Corrigés :
    - **I-a** : une ligne hors paiement créditrice passait sans signal. Elle provoque désormais une erreur (code 2) ;
    - **I-b** : une ligne hors paiement sous une référence sans encaissement (remboursement déclaré par erreur) donnait « écart nul ». Elle est désormais à instruire (`hors_paiement_orphelin`) ;
    - **M-1** : une ligne hors paiement en double était comptée deux fois. Elle est désormais à instruire (`doublon_releve`), et comptée une fois ;
    - **M-3** : commentaires et `PILOTE.md` mis à jour.
  - Différés :
    - **M-2** : contrôle de continuité de la colonne `Balance`, à écrire une fois le format réel connu ;
    - **M-4** : type contenant une virgule, aucun n'est documenté ; il donne le code 2, jamais un silence.
- **Preuves** : `apps/api/tests/run.sh` : 196/196. Dont l'outil en ligne de commande sur un vrai paiement en base, relevé au format pawaPay : écart nul, frais et retrait totalisés, code 2 sur un ajustement manuel. Les trois tests de la relecture ont été écrits avant le correctif, mais leur échec préalable n'a pas été observé à l'exécution.
- **Non prouvé** : un export réel. Restent à confirmer le format de la date, le signe et les décimales, le libellé des types, et si les frais portent le `Transaction ID` du dépôt. Le jeton du bac à sable est nécessaire.

## 13/11/2026 — Audit de sécurité du code ajouté depuis la phase 5, corrections

- **Audit** : dix agents en lecture seule, un par domaine. Synthèse et suites dans `docs/REVUE_SECURITE.md` §4. Aucun Critique, cinq Élevés, une vingtaine de Moyens, environ quarante Faibles. Les sous-agents prévus n'ont pas pu être lancés, faute d'outil : chaque domaine a été audité par un seul agent.
- **Corrections** : sept agents sur des fichiers séparés, puis des raccords faits ici :
  - plafond de scrypt ;
  - `npm ci` avec retour arrière ;
  - droits du test de RADIUS ;
  - `.invalid` refusé à la création d'un gérant ;
  - bancs de sauvegarde en `root:postgres` ;
  - README d'Ansible, ADR 0015, OpenAPI ;
  - schéma Prisma régénéré (table `compte_marchand_verification`).
- **Migrations nouvelles** :
  - 0036 : quota vérifié à la consommation du jeton ;
  - 0037 : verrous du compte marchand, limite de vérification, depositId noté avant `charge()` ;
  - 0038 : rôle `wk_rapprochement` en lecture seule ;
  - 0039 : comptes durcis.
- **Relecture de la règle 4** des correctifs d'argent, par un agent neuf : aucun bloquant. Corrigés ici :
  - I-1 : ligne hors paiement sans référence ;
  - I-2 : tolérance d'horloge sur `expires` ;
  - M-1 : 401 pour les appelants simultanés ;
  - M-4 : `[ ]` échappés.

  Pour chacun, test rouge avant et vert après.
- **Preuves** (sur l'état final, sauf mention) :
  - `apps/api/tests/run.sh` : 224/224 ;
  - `apps/api/tests/e2e.sh` : SUCCÈS (axe-core sur 14 écrans) ;
  - `radius/tests/run.sh` : 288 réussis, 19 ignorés (droits compris) ;
  - `apps/wg-agent/tests/run.sh` : SUCCÈS (13 tests Go, intégration et pare-feu compris) ;
  - `infra/ansible/essais/essai.sh` : SUCCÈS sur les 10 étapes (idempotence ; 444, en-têtes, budget par site, `/etat`, jeton masqué, B en auto-signé ; retour arrière du pare-feu déclenché) ;
  - `infra/noeud/essais/sauvegarde.sh` et `sauvegarde-s3.sh` : SUCCÈS ;
  - `apps/api/tests/charge.sh` : SUCCÈS.

  e2e, RADIUS, wg-agent, Ansible, sauvegardes et charge ont tourné avant les quatre correctifs de la relecture, qui ne touchent que `pawapay.ts`, `rapprochement.ts` et leurs tests, couverts par les 224.
- **Non prouvé** :
  - certbot réel ;
  - B2 réel ;
  - le filtre d'appels système de systemd sur Debian 13 ;
  - le format réel du relevé pawaPay ;
  - le bac à sable pawaPay : le jeton n'est pas injecté par le proxy de la session.

## 13/11/2026 — Suites de l'audit hors du code

- **Mot de passe oublié** : non prévu par le SPEC, donc inscrit dans `docs/IDEES.md` (P5), à décider.
- **Blocage de « J'ai payé »** : laissé exprès, car le plafond par numéro est l'anti-devinette du suffixe. Le correctif proposé ferait passer le risque de vol de ticket d'environ 5 % à environ 20 %. Le chiffrage est dans `docs/REVUE_SECURITE.md` §4.

## 13/11/2026 — CONFORMITE.md : durées réellement appliquées

- **Fait** : `docs/CONFORMITE.md` §7 bis relève les durées de conservation que le code applique (16 lignes, chacune avec sa source : migration, fonction ou ADR). Le juriste et la CIL valideront le réel, et non plus une proposition.
- **Trouvé** : trois données sans aucune purge codée, à trancher avant G-PILOTE :
  - les sessions RADIUS (`radius.session` : MAC, IP, octets) ;
  - les corps bruts des webhooks (`payment_event`, F4, encore ouvert). Avec pawaPay, ils gardent le numéro du payeur en clair au-delà des 6 mois ;
  - le journal d'audit.
- **Non fait** : aucune purge n'a été écrite, car la durée relève du juriste et de la CIL (§6). Les sections qui exigent une signature ou un avis restent `[À CONFIRMER]`.

## 13/11/2026 — Test de promotion instable (CI de la PR 31)

- **Échec** : `radius` en CI sur une PR qui ne change que de la documentation. En cause, `test_promotion.py::test_p2`, avec l'assertion « le spool de A attend toujours (A arrêté) ».
- **Cause racine** : le test contredisait la conception.
  - Le spool de A se vide « dans le PRIMAIRE, où qu'il soit » (ADR 0015 §2, `WAKATNET_PG_ACCT_HOSTS` contient B).
  - Une fois B promu, le FreeRADIUS de A, toujours en marche, peut vider son spool dans B avant l'assertion. Tout dépend de son délai de réessai.
  - La fin du journal de CI le montre : `Reconnecting`, `PGRES_TUPLES_OK`, puis `Unlinking detail.work`. C'était donc une course, et non un défaut du produit.
- **Correctif** : l'assertion est retirée, avec son motif en commentaire. Les propriétés réelles restent vérifiées :
  - p1b : le spool attend tant qu'aucun primaire n'est joignable ;
  - p3 : l'événement de A arrive dans B, une seule fois.
- **Preuve** : `radius/tests/run.sh`, 288 réussis, 19 ignorés, étapes de promotion comprises : SUCCÈS.

## 13/11/2026 — Durées de conservation appliquées (migration 0040)

- **Décidé par Yacouba** :
  - sessions RADIUS : 12 mois ;
  - corps des webhooks : 6 mois ;
  - journal d'audit : 5 ans.

  Ces durées sont à valider par le juriste et la CIL (`docs/CONFORMITE.md` §6 et §7 bis).
- **Fait** : `radius.purge_conservation`, appelée chaque jour par `wakatnet-purge` (rôle `wk_maint`), par lots, et journalisée.
  - **Sessions fermées** : la MAC et l'IP sont effacées, mais la ligne reste. Supprimer la ligne fausserait le décompte d'un ticket limité seulement en temps d'usage, qui n'a pas de date de fin, et lui rendrait du temps gratuit. Les sessions vivantes ne sont jamais touchées.
  - **Quarantaine et anomalies d'accounting** (MAC brute, oubliées du relevé du §7 bis) : supprimées à 12 mois.
  - **Corps des webhooks** : vidés à 6 mois. F4 est fermé.
  - **Journal d'audit** : supprimé à 5 ans.
- **Preuves** :
  - `radius/tests/run.sh` complet, migration 0040 appliquée : 288 réussis. Seul le nouveau test échouait, à cause de deux erreurs dans le test lui-même : il attendait 6 lignes au lieu de 5, et lisait un enregistrement SQL rendu en chaînes. Après correction, `run.sh -k "conservation or droits or purge"` : 18 réussis ;
  - `apps/api/tests/run.sh` : 224/224.

## 13/11/2026 — Rôles Ansible et unité de l'API éprouvés sur Debian 13

- **Débloqué** : `deb.debian.org` et `apt.postgresql.org` ajoutés à l'environnement de développement, avec l'accord de Yacouba. Jusqu'ici, tout était prouvé sur Ubuntu 24.04, faute d'accès aux dépôts Debian.
- **Fait** :
  - `essai.sh` prend `WAKATNET_ESSAI_OS=debian13`, en plus du défaut `ubuntu2404`. L'image `Dockerfile.noeud-debian13` contient Debian 13, avec PostgreSQL 16 et pgBackRest 2.60.0 tirés de PGDG ; le dépôt est déclaré comme le rôle le déclare, et les seuils sont ceux de la production.
  - Clé PGDG : les clés de `cles/` restent hors du dépôt (README Ansible). Le banc prend donc celle du paquet Debian `postgresql-common`, après contrôle de son empreinte (`B97B…4CF8`).
  - `infra/systemd/essais/unite-api.sh` lance la vraie `wakatnet-api.service` sous systemd 257, avec une sonde à la place de l'API.
  - Banc de nuit : `ansible` passe en matrice (`ubuntu2404`, `debian13`), et un job `unite-api` est ajouté.
- **Trouvé par Debian 13** :
  - **Défaut de production** : nginx refusait toute la configuration (`"server_tokens" directive is duplicate`). Debian 13 active `server_tokens off;` dans son propre `nginx.conf`, alors qu'Ubuntu le laisse en commentaire. **Corrigé** : la directive est désormais déclarée dans chaque bloc `server`.
  - FreeRADIUS de Debian 13 : **3.2.7**, refusé par la garde de version. Le dépôt de l'éditeur reste nécessaire (ADR 0004).
  - Le 444 de nginx se lit `curl 56` avec OpenSSL 3.5 (`curl 52` sur Ubuntu). Le test accepte les deux codes, et vérifie aussi le 444 dans le journal de nginx.
  - À titre d'information : Debian 13 livre Node 20 et PostgreSQL 17. Les rôles installent Node 22 (nodejs.org) et PostgreSQL 16 (PGDG), comme prévu.
- **Preuves** (état final) :
  - `WAKATNET_ESSAI_OS=debian13 essai.sh` : SUCCÈS sur les 10 étapes. Idempotence `changed=0`, garde contre le double primaire, nginx (444, limites, en-têtes), pare-feu et retour arrière déclenché ;
  - `essai.sh` (Ubuntu 24.04) : SUCCÈS sur les 10 étapes, sans régression ;
  - `unite-api.sh` : SUCCÈS. HTTP, fetch, scrypt, fs, DNS, worker, zlib et wasm passent, `Seccomp: 2`, exposition 1,5. Contrôle négatif : avec `~@process` ajouté, l'essai échoue.
- **Non prouvé** :
  - une VM Debian 13 (module WireGuard, `noeud_wakatnet`, FreeRADIUS de l'éditeur) ;
  - un processeur avec PKU ;
  - `actionlint` : son installation par le registre Go a été refusée dans la session. GitHub validera `nuit.yml` à son premier run.

## 13/11/2026 — Second adaptateur réel : CinetPay (ADR 0022)

- **Demande** : « Ajoute cinetpay ».
- **Choix** : API v1 en paiement direct. Elle entre dans le contrat `FournisseurPaiement` sans changer l'architecture ; la v2, à page hébergée, imposerait une redirection depuis le portail captif. Source : le SDK officiel `cinetpay-js` 0.1.1, la v1 n'ayant aucune page de documentation et `docs.cinetpay.com` étant bloqué par le réseau de la session.
- **Fait** :
  - `packages/payments/src/cinetpay.ts` ;
  - les branches `cinetpay` de `fournisseurs.ts` : clé `sk_test_` ou `sk_live_` liée à l'environnement, gardes G-ARGENT et bac à sable ;
  - `ServicePaiement` connaît l'adresse publique (notify_url) ;
  - choix du fournisseur dans le tableau de bord ;
  - faux serveur et 10 tests ;
  - ADR 0022.
- **Trouvé** : le statut v1, tel que le SDK le lit, ne contient pas le montant. A8 est gardé : sans montant au statut, c'est un écart sans ticket. La production CinetPay reste donc verrouillée (`MONTANT_AU_STATUT_CONFIRME = false`) tant que le bac à sable n'a pas tranché.
- **Relecture par un second agent** (règle 4) : aucun ticket possible sans paiement. Dix constats ; sept corrigés et testés, l'un en partie, deux reportés au bac à sable (ADR 0022, section Preuves).
- **Preuves** (état final) :
  - `apps/api/tests/run.sh` : 234/234, dont 10 tests CinetPay (234 = 224 existants + 10), typage compris ;
  - `apps/api/tests/e2e.sh` : SUCCÈS, axe-core sans violation sur 14 écrans, compte marchand compris ;
  - typage du tableau de bord : `tsc` sans erreur.
- **Non prouvé** :
  - aucun appel au vrai CinetPay (hôtes non joignables, clés absentes) ;
  - l'e2e ne joue l'écran du compte marchand qu'avec pawaPay, pas avec CinetPay ;
  - le format du relevé CinetPay pour le rapprochement ;
  - l'agrément de CinetPay au Burkina (`CONFORMITE.md` §4).
