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
