# Pilote (phase 6)

- **Références** : `docs/SPEC.md` §12 (phase 6, portes G-ARGENT et G-PILOTE), §0 (exigences 1 et 2) ; ADR 0001, 0004, 0016 ; `docs/RUNBOOK.md`, `docs/MISE_EN_PRODUCTION.md`, `docs/ONBOARDING_ROUTEUR.md`.
- **Qui fait quoi** : le pilote se joue **sur le terrain**, par Yacouba. L'agent ne se connecte à aucune machine de production (CLAUDE.md). Il a livré les outils, les procédures et ce journal à remplir.
- **Critère de sortie** (§12) : journal du pilote tenu, et **écart de rapprochement nul** chaque jour.

## 1. Déroulé

| Étape | Périmètre | Porte à franchir avant |
|---|---|---|
| **A** | Un site de Telecom Universel, 2 semaines, petits montants (forfaits de 500 F au plus), rapprochement chaque matin | **G-ARGENT** (aucun franc réel avant) |
| **B** | 3 propriétaires pilotes | **G-PILOTE** (avant le routeur d'un tiers) |

## 2. État des portes au 12/11/2026 : FERMÉES

### G-ARGENT : phase 3 verte **et** `docs/CONFORMITE.md` rempli

| Condition | État | Qui |
|---|---|---|
| Phase 3 verte avec le `MockProvider` | Fait (P1 à P9, grand livre) | — |
| **Adaptateur réel en bac à sable** (ticket 3.08) | **Écrit** : pawaPay v2 (ADR 0020), prouvé contre un faux serveur aux formes de la documentation officielle. **Bac à sable réel non joué** : il faut le jeton | Yacouba ouvre un compte de bac à sable pawaPay et fournit le jeton ; l'agent joue les numéros de test du Burkina |
| Format du relevé du compte marchand (colonnes, statuts, fuseau, référence portée) | **Encore inconnu** : pawaPay offre un relevé par API (« Statements ») et un export du tableau de bord, non lus. Notre référence voyage dans `clientReferenceId` (ADR 0020). L'outil de rapprochement se règle par options | Agent, au bac à sable |
| Écran « compte marchand » du tableau de bord (mode A) | **Fait** : environnement et jeton pawaPay, adresse des callbacks à recopier ; argent réel refusé tant que `WAKATNET_ARGENT_REEL` n'est pas posée | — |
| `docs/CONFORMITE.md` : contrat de l'agrégateur, statut d'agrément vérifié, juriste, CIL, ARCEP, comptable (mentions de facture) | **Tout est [À CONFIRMER]** | Yacouba (piste B) |

### G-PILOTE : phase 5 verte

| Condition | État | Qui |
|---|---|---|
| Phase 5 verte au labo (T13, bascule, sauvegardes, supervision, charge, revue de sécurité) | Fait | — |
| Nœuds achetés après la mesure de latence (LABO-17), nom de domaine | Non fait | Yacouba |
| Rôles Ansible rejoués sur une **VM Debian 13**, paquets de l'éditeur de FreeRADIUS (dépôt **[À CONFIRMER]**) | Non fait (prouvé sur Ubuntu 24.04 seulement) | Yacouba |
| LABO-16 et LABO-09 sur CHR : bascule réelle d'un routeur vers B, `timeout` | Non fait | Yacouba |
| **B chez un second hébergeur**, T13 rejoué, promotion rejouée (ADR 0004 §3) | Non fait | Yacouba |
| Scripts RouterOS joués sur CHR, sur un routeur vierge **et** sur un routeur déjà configuré (§13, règle 6) | Non fait (`docs/AUDIT_SCRIPTS_ROUTEROS.md`) | Yacouba |
| Décisions de la revue de sécurité : quotas d'enrôlement et vérification de l'adresse (M4) | Fait (ADR 0017) ; fournisseur d'e-mail décidé (ADR 0019, Brevo) : compte, domaine expéditeur et clé à créer | Yacouba |
| Fournisseur S3 avec verrouillage (M8) | Décidé (ADR 0018 : Backblaze B2, conformité 30 jours), prouvé au banc ; compte, bucket et exercice d'effacement sur B2 à faire | Yacouba |

## 3. Étape A : le site de Telecom Universel

1. Mise en production : `docs/MISE_EN_PRODUCTION.md`, de bout en bout, sauvegarde et essai de restauration compris.
2. Raccorder le routeur du site : `docs/ONBOARDING_ROUTEUR.md`.
3. Forfaits : de 500 F au plus pendant les deux semaines. Commission de 10 % (D3) sur le compte de Telecom Universel lui-même.
4. Chaque matin : le rapprochement de la veille (§4), puis une ligne au journal (§6).
5. Chaque jour, un test d'achat réel de 100 F par l'exploitant : ticket reçu, connexion, ligne au relevé.
6. Le premier jeudi : T13 sur les nœuds réels, en heure creuse, avec un ticket déjà vendu (RUNBOOK §2), puis la sauvegarde, puis l'essai de restauration.

## 4. Rapprochement quotidien

Il se fait chaque matin, pour la veille (J), sur le nœud primaire.

1. Exporter le relevé du compte marchand sur **trois jours glissants** : de J − 1 à aujourd'hui. L'outil exige qu'il couvre de J − 1 00:00 à J + 1 00:10.
2. Lancer l'outil. La base est ouverte en lecture seule, et son adresse n'apparaît jamais en argument :

```bash
sudo -u postgres env WAKATNET_ADMIN_DATABASE_URL=postgresql:///wakatnet node /opt/wakatnet/apps/api/src/rapprochement.ts --proprietaire 1 --jour 2026-11-20 --releve releve.csv --releve-du 2026-11-19T00:00:00Z --releve-au 2026-11-21T08:00:00Z --reussi SUCCESS --echec FAILED,CANCELLED
```

3. Lire le code de sortie et le rapport :
   - **0, « ÉCART NUL »** : noter la ligne au journal ;
   - **1, « ÉCARTS À INSTRUIRE »** : chaque écart est listé avec sa référence. Le traiter dans la journée, et le noter au journal avec sa cause et sa suite ;
   - **2, entrée invalide** (relevé insuffisant, statut inconnu, ligne illisible) : corriger l'export, jamais l'ignorer.
4. Ce que l'outil contrôle :
   - chaque ticket délivré a sa ligne au relevé ;
   - chaque encaissement a son ticket ;
   - les montants sont égaux ;
   - chaque paiement a **une** commission au grand livre, égale à la valeur figée à la confirmation, au taux du propriétaire.
5. Ce qui est expliqué sans être un écart, mais reste listé :
   - un paiement de part et d'autre de minuit ;
   - une confirmation tardive (webhook perdu, repris par la vérification périodique, dans les 24 h).
6. Ce qu'il **ne** contrôle **pas** : le montant des frais de l'agrégateur par rapport à son contrat (avec pawaPay, ils sont seulement totalisés ; voir plus bas), et les ventes en espèces (tickets papier). Ces dernières se rapprochent à la main : tickets activés au tableau de bord, contre la caisse du point de vente.

Les colonnes et les statuts se règlent par options (`--col-reference`, `--col-montant`, `--col-date`, `--col-statut`, `--reussi`, `--echec`, `--hors-paiement`, `--sep`), une fois le format réel du relevé connu.

### Relevé pawaPay (ADR 0020)

Le relevé de pawaPay (Dashboard > Finances > Statements > Export, ou `POST /v2/statements`) est le **journal du portefeuille**, et non une liste de paiements :
- une ligne par mouvement de solde, sans colonne de statut ;
- aucun dépôt échoué ;
- les frais de chaque dépôt sur des lignes à part ;
- les retraits sans `Transaction ID` ;
- `Transaction ID` = le `depositId` (UUID), que l'outil retrouve par la référence du fournisseur.

Profil, d'après les colonnes documentées (docs.pawapay.io, lu le 12/11/2026) :

```bash
sudo -u postgres env WAKATNET_ADMIN_DATABASE_URL=postgresql:///wakatnet node /opt/wakatnet/apps/api/src/rapprochement.ts --proprietaire 1 --jour 2026-11-20 --releve releve.csv --releve-du 2026-11-19T00:00:00Z --releve-au 2026-11-21T08:00:00Z --sep , --col-reference "Transaction ID" --col-montant Amount --col-date "Creation date" --col-statut Type --reussi Deposit --hors-paiement "Deposit pass through fees,Deposit PawaPay fees,Withdrawal"
```

- **Pas de `--echec`** : le journal ne contient que des mouvements réalisés. Un paiement réussi chez nous et absent du journal reste un écart (`absent_du_releve`).
- **Lignes hors paiement** : frais et retraits sont totalisés par type au rapport, sans être rapprochés ligne à ligne. Trois garde-fous restent actifs (relecture de la règle 4) :
  - une ligne hors paiement **créditrice** arrête l'outil (code 2) ;
  - une ligne hors paiement qui porte la référence d'un dépôt absent du relevé est **à instruire** (`hors_paiement_orphelin`) : c'est le cas d'un remboursement déclaré par erreur ;
  - la même ligne présente deux fois est **à instruire** (`doublon_releve`), et n'est comptée qu'une fois.
- **Tout autre type arrête l'outil (code 2)** : ajustement manuel de pawaPay (« Adjustment - … », « Compensation - … »), remboursement, recharge. Lire la colonne `Reason`, noter la ligne au journal du pilote avec sa cause, puis relancer, en ajoutant ce type à `--hors-paiement` seulement s'il ne touche aucun encaissement. Un remboursement (`Refund`) ne s'y ajoute jamais : le ticket a été délivré et l'argent rendu. En particulier, « Adjustment - Collections received » **est** un encaissement : un dépôt crédité à la main. Il s'instruit comme un `absent_du_releve`.
- **Non vérifié, à confirmer sur le premier export du bac à sable** :
  - le format exact de `Creation date` (l'outil exige l'ISO 8601) ;
  - le séparateur ;
  - les décimales et le signe de `Amount` (« 200.00 » est accepté pour un dépôt, une décimale non nulle refusée ; frais signés, deux décimales au plus) ;
  - le libellé exact des types (comparés sans tenir compte de la casse) ;
  - et si les lignes de frais portent le `Transaction ID` du dépôt.
- **Ce que ce profil ne contrôle toujours pas** : le montant des frais par rapport à la grille du contrat. Il les totalise seulement.

## 5. Arrêt du pilote : critères, et ce qu'on fait

On arrête la vente en ligne du site (forfaits retirés de la vente) et on instruit, dans les cas suivants :
- un écart à instruire non expliqué au bout de 24 h ;
- un client payé sans ticket, deux fois dans la semaine ;
- une panne de l'authentification de plus de 5 min sans bascule vers B ;
- une alerte « essai de restauration » ou « sauvegarde » non résolue dans la journée.

Les tickets déjà vendus continuent d'authentifier : la vente en ligne peut s'arrêter sans couper les clients.

## 6. Journal du pilote

Une ligne par jour. Un incident fait l'objet d'un compte rendu, sans recherche de coupable : faits datés, cause, correction, prévention.

| Jour | Ventes en ligne (nombre / F) | Commissions (F) | Rapprochement (code) | Écarts et suite | Tickets papier activés | Incidents | Bascule ou alerte |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

## 7. Étape B : trois propriétaires pilotes

Elle s'ouvre après G-PILOTE et deux semaines d'écart nul à l'étape A.
- **Rapprochement** : chaque propriétaire a son relevé et son propre rapprochement (`--proprietaire`). L'agent n'a jamais accès à leurs comptes marchands.
- **Accueil** : `docs/ONBOARDING_ROUTEUR.md`, et le guide imprimable du propriétaire et du vendeur, `docs/guides/guide-pilote.pdf` (6 pages A4 ; la partie du vendeur tient sur une page). Remplir les cases du contact avant d'imprimer.
