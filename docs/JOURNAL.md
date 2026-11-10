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
