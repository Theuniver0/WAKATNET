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
