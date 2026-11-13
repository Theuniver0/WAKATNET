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

**Une fois pour toutes, sur le nœud primaire** (Yacouba, à la main) : l'outil ne tourne **jamais** en superutilisateur. Il lit la base sous le rôle `wk_rapprochement` (migration 0038) : connexion, deux fonctions de lecture, transactions en lecture seule par défaut ; aucun droit sur une table, ni sur le grand livre.
- Mot de passe du rôle : `WAKATNET_PG_RAPPROCHEMENT_PASSWORD`, dans `/etc/wakatnet/pg-roles.env`, posé par `migrer.sh` comme les autres rôles.
- Utilisateur système sans privilège, sans shell ni répertoire personnel : `sudo useradd --system --no-create-home --shell /usr/sbin/nologin wk-rappro`.
- Fichier `/etc/wakatnet/rapprochement.env` (root:wk-rappro, 0640), rempli à la main, une seule ligne : `WAKATNET_RAPPROCHEMENT_DATABASE_URL=postgresql://wk_rapprochement:CHANGE_ME@127.0.0.1:5432/wakatnet`, où `CHANGE_ME` est le mot de passe ci-dessus.
- Répertoire des relevés `/var/lib/wakatnet-rapprochement` (root:wk-rappro, 0750) : les relevés portent des numéros de téléphone, ils n'y sont lisibles que par l'outil.

Chaque matin :

1. Exporter le relevé du compte marchand sur **trois jours glissants** : de J − 1 à aujourd'hui. L'outil exige qu'il couvre de J − 1 00:00 à J + 1 00:10. Le copier dans `/var/lib/wakatnet-rapprochement/`.
2. Lancer l'outil sous `wk-rappro`. L'adresse de la base, mot de passe compris, est lue dans le fichier par l'environnement : elle n'apparaît **jamais** en argument, ni dans `ps`, ni dans l'historique du shell.

```bash
sudo -u wk-rappro bash -c 'set -a; . /etc/wakatnet/rapprochement.env; set +a; cd /; exec node /opt/wakatnet/apps/api/src/rapprochement.ts "$@"' rapprochement --proprietaire 1 --jour 2026-11-20 --releve /var/lib/wakatnet-rapprochement/releve.csv --releve-du 2026-11-19T00:00:00Z --releve-au 2026-11-21T08:00:00Z --reussi SUCCESS --echec FAILED,CANCELLED
```

   - **Un fichier par `--releve`** : `--releve a.csv --releve b.csv`. Jamais `--releve releve-*.csv` : le shell en ferait `--releve a.csv b.csv`, et tout argument en trop, comme toute option inconnue, arrête l'outil (code 2).
   - **Jour réellement sans mouvement** au compte marchand : l'export est réduit à son en-tête. L'outil le refuse (code 2), sauf avec `--releve-vide`, qui le dit en tête du rapport (« relevé déclaré vide par l'exploitant »). Avec cette option, une seule ligne du jour J au relevé arrête l'outil. Un fichier vide, sans en-tête, est toujours refusé.

3. Lire le code de sortie et le rapport :
   - **0, « ÉCART NUL »** : noter la ligne au journal ;
   - **1, « ÉCARTS À INSTRUIRE »** : chaque écart est listé avec sa référence. Le traiter dans la journée, et le noter au journal avec sa cause et sa suite ;
   - **2, entrée invalide** (relevé insuffisant, vide ou réduit à l'en-tête, statut inconnu, ligne illisible, argument inattendu) : corriger l'export ou la commande, jamais l'ignorer.
4. Ce que l'outil contrôle :
   - chaque ticket délivré a sa ligne au relevé ;
   - chaque encaissement a son ticket ;
   - les montants sont égaux ;
   - chaque paiement a **une** commission au grand livre, égale à la valeur figée à la confirmation, au taux du propriétaire ;
   - un paiement **remboursé** (`REFUNDED`) confirmé le jour J est toujours à instruire (`rembourse`), avec ou sans ligne au relevé. Aucun remboursement n'est encore codé : c'est une garde.
5. Ce qui est expliqué sans être un écart, mais reste listé :
   - un paiement de part et d'autre de minuit ;
   - une confirmation tardive (webhook perdu, repris par la vérification périodique, dans les 24 h).
6. Ce qu'il **ne** contrôle **pas** :
   - le montant des frais de l'agrégateur par rapport à son contrat (avec pawaPay, ils sont seulement totalisés, et bornés à 10 % de leur dépôt ; voir plus bas) ;
   - les ventes en espèces (tickets papier). Elles se rapprochent à la main : tickets activés au tableau de bord, contre la caisse du point de vente ;
   - **un relevé tronqué dont la couverture est déclarée complète**. `--releve-du` et `--releve-au` sont une déclaration de l'exploitant : l'outil vérifie qu'elle couvre la période, pas que l'export la couvre réellement. Un export arrêté à 15 h et déclaré jusqu'à J + 1 ferait paraître des encaissements absents (des écarts, jamais un faux « écart nul » pour un ticket délivré), mais un encaissement sans ticket de la fin de journée passerait inaperçu. Le contrôle de continuité de la colonne `Balance` (chaque solde = solde précédent + montant) viendra avec un export réel ; d'ici là, vérifier à l'œil que la dernière ligne de l'export est postérieure à J + 1 00:10.

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
sudo -u wk-rappro bash -c 'set -a; . /etc/wakatnet/rapprochement.env; set +a; cd /; exec node /opt/wakatnet/apps/api/src/rapprochement.ts "$@"' rapprochement --proprietaire 1 --jour 2026-11-20 --releve /var/lib/wakatnet-rapprochement/releve.csv --releve-du 2026-11-19T00:00:00Z --releve-au 2026-11-21T08:00:00Z --sep , --col-reference "Transaction ID" --col-montant Amount --col-date "Creation date" --col-statut Type --reussi Deposit --hors-paiement "Deposit pass through fees,Deposit PawaPay fees,Withdrawal"
```

- **Pas de `--echec`** : le journal ne contient que des mouvements réalisés. Un paiement réussi chez nous et absent du journal reste un écart (`absent_du_releve`).
- **Lignes hors paiement** : frais et retraits sont totalisés par type au rapport, sans être rapprochés ligne à ligne. Quatre garde-fous restent actifs (relecture de la règle 4, audit de l'outil) :
  - une ligne hors paiement **créditrice** arrête l'outil (code 2) ;
  - une ligne hors paiement qui porte la référence d'un dépôt absent du relevé est **à instruire** (`hors_paiement_orphelin`) : c'est le cas d'un remboursement déclaré par erreur ;
  - une ligne hors paiement **sans référence** n'est admise que pour les types de `--hors-sans-reference` (par défaut `Withdrawal`, le règlement vers la banque). Tout autre type sans `Transaction ID` (remboursement, ajustement, compensation) est **à instruire** (`hors_paiement_sans_reference`) : c'est de l'argent qui sortirait du contrôle sans être rattaché à un paiement (relecture de la règle 4, 13/11/2026) ;
  - sous la référence d'un dépôt **présent** au relevé, des débits hors paiement de plus de **10 %** de son montant sont **à instruire** (`hors_paiement_excessif`) : un remboursement, ou tout débit du montant entier, ajouté à tort à `--hors-paiement`. Les frais d'un dépôt pawaPay sont de quelques pour cent : ils restent sous ce seuil. Un frais fixe sur un très petit dépôt pourrait le franchir : il sera alors listé, jamais ignoré ; le seuil se relira sur la grille du contrat ;
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
