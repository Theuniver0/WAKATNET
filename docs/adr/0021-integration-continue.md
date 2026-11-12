# ADR 0021 — Intégration continue : GitHub Actions sur les harnais existants

- **Statut** : proposé le 12/11/2026, **décidé par Yacouba le 12/11/2026 : option A**. Deux réglages ne se font pas depuis le dépôt et lui reviennent : la protection de `main` et la vérification du forfait de minutes GitHub.
- **Références** : `CONTRIBUTING.md` §6 (P1 : jamais « c'est fait » sans preuve ; P6 : fusion après tests verts) ; SPEC §13 et §14 ; ADR 0008 (migrations et tests) ; harnais `apps/api/tests/{run,e2e,charge}.sh`, `radius/tests/run.sh`, `apps/wg-agent/tests/{run,pare-feu}.sh`, `infra/ansible/essais/essai.sh`, `infra/noeud/essais/{sauvegarde,sauvegarde-s3}.sh`.

## Contexte

- **Le dépôt n'a aucun workflow** (`.github/workflows` absent). La PR [Theuniver0/WAKATNET#28](https://github.com/Theuniver0/WAKATNET/pull/28), qui touche au code d'argent, n'a donc **aucune vérification** sur GitHub.
- Toutes les preuves citées dans les ADR, le journal et les PR viennent d'un seul poste, celui de la session de développement. Personne d'autre ne peut les rejouer sans refaire ce poste, et rien n'empêche de fusionner une branche dont les tests n'ont jamais tourné. La PR #27 a été fusionnée sur la seule foi de ces preuves locales.
- P6 exige « tests verts » avant fusion, mais rien ne le vérifie.
- **Atout** : chaque harnais est déjà autonome. Une commande crée sa pile Docker jetable, avec des secrets aléatoires générés sur place, puis la détruit. Aucun ne lit de secret du dépôt ni de l'environnement, et aucun ne se connecte à une machine réelle. Le passage en CI est donc surtout une question d'hôte, pas de réécriture.
- **Contraintes** :
  - aucun secret dans le dépôt ni dans la CI (CLAUDE.md), et aucune connexion à la production ;
  - petite équipe : rien à maintenir de plus qu'un fichier ;
  - liaisons lentes au Burkina, mais la CI s'exécute dans le nuage, ce qui n'a pas d'incidence.

## Options considérées

### A. GitHub Actions, runners hébergés (`ubuntu-24.04`)

| Dimension | Évaluation |
|---|---|
| Complexité | Faible : un fichier YAML qui appelle les harnais existants |
| Coût | Gratuit dans le forfait, si le dépôt est public ou si les minutes incluses suffisent (inconnu ; voir « Incertitudes ») |
| Montée en charge | Les jobs tournent en parallèle ; aucune machine à entretenir |
| Familiarité | Docker et bash, déjà utilisés partout |

- **Pour** :
  - Docker et Compose sont présents sur le runner, avec `--privileged` permis (banc Ansible) ;
  - aucun secret nécessaire ;
  - le statut est visible sur la PR, et la protection de `main` peut l'exiger.
- **Contre** :
  - le code et les journaux de test passent chez GitHub. Le code y est déjà, et les journaux ne contiennent que des secrets jetables ;
  - les tirages Docker Hub sont limités par runner. Le risque est faible : les runners hébergés ont leur propre quota ;
  - dépendance à un service externe, mais hors du chemin critique du produit.

### B. Runner auto-hébergé (sur un VPS de WAKATNET ou sur un poste)

| Dimension | Évaluation |
|---|---|
| Complexité | Moyenne à élevée : une machine à durcir, à mettre à jour et à superviser |
| Coût | Une machine de plus, sans minutes facturées |
| Montée en charge | Un seul runner : les jobs passent l'un après l'autre |
| Familiarité | Ansible déjà en place, mais rôle à écrire |

- **Pour** : aucune limite de minutes, et le code reste sur des machines maîtrisées.
- **Contre** :
  - GitHub déconseille un runner auto-hébergé pour un dépôt qui accepte des PR d'inconnus, car le code d'une PR s'exécute sur la machine ;
  - **sur un VPS de production, c'est exclu** : du code non relu tournerait à côté de la base et des clés (SPEC §10, CLAUDE.md) ;
  - un poste à Ouagadougou est soumis aux coupures de courant et de liaison.

### C. Statu quo : les preuves locales, recopiées dans la PR

| Dimension | Évaluation |
|---|---|
| Complexité | Nulle |
| Coût | Nul en argent, mais toute la confiance repose sur un seul poste |
| Montée en charge | Aucune : un second contributeur ne peut rien vérifier |
| Familiarité | Totale |

- **Pour** : rien à faire.
- **Contre** :
  - P1 et P6 ne sont tenues que par discipline ;
  - une régression introduite pendant une fusion (conflit résolu dans l'interface GitHub, par exemple) ne serait vue par personne ;
  - c'est intenable une fois G-PILOTE franchie, avec de l'argent réel en jeu.

## Décision proposée : option A, en deux niveaux

1. **Sur chaque PR et chaque poussée vers `main`** (`pull_request`, jamais `pull_request_target`), quatre jobs en parallèle :
   - `api` : `apps/api/tests/run.sh` (typage, puis la suite complète sur PostgreSQL 16) ;
   - `e2e` : `apps/api/tests/e2e.sh` (Playwright + axe-core). Le harnais suppose Node 22 et Chromium sur l'hôte : le job les installe en versions épinglées ;
   - `radius` : `radius/tests/run.sh` (droits, contrats FreeRADIUS) ;
   - `wg-agent` : `apps/wg-agent/tests/run.sh`.
2. **Chaque nuit et à la demande** (`schedule`, `workflow_dispatch`), car ces bancs sont lents ou lourds :
   - `infra/ansible/essais/essai.sh` (conteneurs systemd privilégiés) ;
   - `infra/noeud/essais/sauvegarde.sh` et `sauvegarde-s3.sh` ;
   - `apps/api/tests/charge.sh`.
3. **Durcissement du workflow** :
   - `permissions: contents: read`, au niveau du fichier ;
   - aucun `secrets.*` ;
   - actions tierces épinglées par empreinte de commit, et non par étiquette ;
   - `runs-on: ubuntu-24.04`, jamais `ubuntu-latest`, qui bascule vers 26.04 ces jours-ci ;
   - `concurrency` qui annule le run précédent d'une même PR ;
   - `timeout-minutes` sur chaque job.
4. **Protection de `main`** (réglage GitHub, fait par Yacouba) : les quatre jobs du premier niveau sont obligatoires avant la fusion.
5. **P6 est amendée** : « tests verts » veut dire désormais le statut de la CI sur le dernier commit de la PR, et non plus une sortie recopiée.

## Analyse des compromis

- La question qui tranche est **qui peut rejouer la preuve**. A est la seule option où quelqu'un d'autre que l'auteur voit le même résultat, sur la même révision, sans rien installer.
- B n'apporte qu'une économie de minutes, et seulement si le forfait ne suffit pas. Ce n'est pas établi, et elle se paie en surface d'attaque et en entretien.
- Le découpage en deux niveaux sert à tenir le temps d'attente d'une PR bas, sans abandonner les bancs lourds. Un banc nocturne en échec n'empêche pas la fusion : c'est assumé, car ces bancs touchent l'exploitation et non le code d'argent.

## Conséquences

- **Plus facile** :
  - vérifier une PR sans le poste de développement ;
  - refuser une fusion non testée ;
  - voir une régression de dépendance (image, paquet) le lendemain, grâce au banc nocturne.
- **Plus difficile** :
  - un test lent ou instable bloque tout le monde ; il faudra le corriger, jamais le désactiver (règle de la CI) ;
  - les versions de Node, de Playwright et des actions sont à tenir à jour.
- **À revoir** :
  - la consommation de minutes, après un mois ;
  - le passage du banc de charge en hebdomadaire, s'il est trop coûteux ;
  - l'ajout du banc de sauvegarde au premier niveau si le code de `infra/noeud` change souvent.

## Incertitudes (non vérifiées ici)

- **Durée des harnais sur un runner hébergé** : jamais mesurée hors du poste de développement. Le premier run la donnera ; elle fixera les `timeout-minutes`.
- **Visibilité du dépôt et forfait GitHub** : ni l'une ni l'autre n'est connue ici. Un dépôt public a des minutes illimitées sur les runners standard ; un dépôt privé dépend du forfait (à vérifier dans Settings → Billing). Le banc nocturne est le premier poste à réduire si le quota manque.
- **Banc Ansible en conteneurs `--privileged` avec `--cgroupns=host`** : à confirmer sur le runner. Si le noyau ou cgroup v2 du runner le refuse, ce banc reste local et la CI le signale.
- **`e2e.sh`** dépend de `pdftotext` (poppler-utils), en plus de Node et Chromium : le job doit l'installer.

## Actions

1. [x] Yacouba décide : A.
2. [x] `.github/workflows/ci.yml` (premier niveau) et `.github/workflows/nuit.yml` (second niveau). Validés localement par une analyse YAML (déclencheurs, permissions, runner épinglé, délais, actions épinglées par empreinte). **`actionlint` n'a pas tourné** : son téléchargement a été refusé dans la session de développement.
3. [~] Premier run (12/11/2026) :
   - **niveau 1** : vert ; durées d'environ 1 min 30 s (`api`, `e2e`, `wg-agent`) et 8 min 30 s (`radius`) ;
   - **niveau 2** : trois défauts trouvés, corrigés et prouvés en local (voir le journal) ; à confirmer au prochain run.
4. [ ] Yacouba : protéger `main` (statuts requis : `api`, `e2e`, `radius`, `wg-agent`), puis vérifier le forfait de minutes.
5. [x] P6 amendée dans `CONTRIBUTING.md`.

## Écart constaté en écrivant le workflow : corrigé

`e2e.sh` chargeait `playwright` hors du dépôt (`createRequire`) : sur le poste de développement, il venait d'une installation globale (1.63.0, par `NODE_PATH`), absente de `package-lock.json`.
- **Corrigé** : `playwright` 1.63.0, en version exacte, figure dans les `devDependencies` de `apps/api`, et donc dans le verrou (intégrité sha512, aucun script d'installation).
- Le job `e2e` ne télécharge plus que Chromium, par `npx --no-install playwright install --with-deps chromium` : la version vient du verrou.
