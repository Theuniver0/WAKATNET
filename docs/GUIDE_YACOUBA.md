# Ce qui reste à faire de votre côté, étape par étape

- **Pour** : Yacouba.
- **État au 15/11/2026** : le code faisable sans vous est terminé et fusionné dans `main` (PR #34 à #41, CI verte). Tout ce qui suit demande vos comptes, vos documents, vos serveurs ou votre matériel.
- **Règle permanente** : aucun secret dans une conversation, un ticket ou une ligne de commande. Quand je dois utiliser une clé, je vous ouvre un formulaire sécurisé ; les mots de passe des serveurs restent chez vous.
- **Ordre** : les étapes 1, 2 et 3 peuvent commencer le même jour. L'étape 6 (argent réel) attend les étapes 1 et 2. L'étape 7 (pilote) attend tout le reste.

Chaque étape suit le même plan :
1. but ;
2. ce qu'il vous faut ;
3. les gestes ;
4. comment savoir que c'est bon ;
5. ce que vous m'envoyez, et ce que je fais ensuite.

---

## Étape 0 — Protéger `main` et faire le ménage

**But** : qu'aucune modification n'entre dans `main` sans tests verts. La PR #40 a été fusionnée pendant que le job `radius` tournait encore : `main` est resté rouge jusqu'à la PR #41.

**Il vous faut** : un accès administrateur au dépôt GitHub `Theuniver0/WAKATNET`.

**Gestes**
1. Sur GitHub : **Settings**, puis **Branches**, puis **Add branch ruleset** (ou *Add rule*). Cible : `main`.
2. Cochez **Require a pull request before merging**.
3. Cochez **Require status checks to pass before merging**. Ajoutez les quatre jobs : `api`, `e2e`, `radius`, `wg-agent`. Ils n'apparaissent dans la liste que s'ils ont déjà tourné : c'est le cas.
4. Cochez **Require review from Code Owners**. Le fichier `.github/CODEOWNERS` vous désigne sur la CI, les tests, le SQL et le code d'argent.
5. **Laissez-vous un contournement** : ajoutez-vous dans *Bypass list*, ou ne cochez pas *Do not allow bypassing the above settings*. GitHub interdit à l'auteur d'une PR de l'approuver. Comme mes PR sont ouvertes sous votre compte, vous seriez bloqué sans contournement.
6. Cochez **Block force pushes**.
7. Dans les réglages de l'environnement cloud WAKATNET (menu de l'environnement, puis **Edit**, puis **Network secrets**), **supprimez** « Jeton bac à sable pawaPay ». pawaPay est retiré du projet (ADR 0024).

**C'est bon quand** : dans une PR, le bouton de fusion reste gris tant que les quatre jobs ne sont pas verts.

**À m'envoyer** : rien.

---

## Étape 1 — MoneyFusion : compte, contrat, agrément, réponses techniques

**But** : obtenir par écrit ce que la documentation de MoneyFusion ne dit pas. C'est le plus gros risque restant du projet.

**Il vous faut** : les documents de Telecom Universel (RCCM, IFU, pièce du gérant). MoneyFusion vérifie l'identité des comptes « Enterprise ».

**Gestes**
1. Créez un compte **Money Fusion Enterprise** au nom de Telecom Universel sur `moneyfusion.net`. C'est votre compte d'essai ; chaque propriétaire aura plus tard le sien.
2. Dans le menu, ouvrez **API de paiement** et créez une application. Ne la terminez pas tout de suite : elle demandera les IP de vos serveurs et l'adresse de votre site, que vous n'aurez qu'à l'étape 3. Notez seulement ce qu'elle demande.
3. Ouvrez `docs/courriels/2026-11-14-agregateurs.md`, complétez les champs entre crochets, puis envoyez le courriel à MoneyFusion. Il pose huit questions :
   1. contrat marchand quand chaque propriétaire a son compte et que la plateforme appelle l'API pour lui ;
   2. **entité et agrément pour le Burkina Faso**. MoneyFusion est à Abidjan et se dit seulement « partenaire d'institutions agréées BCEAO » ;
   3. le champ `Montant` du statut est-il **brut ou net** des frais ?
   4. devise du statut ;
   5. valeur exacte du champ `moyen` pour Orange Money et Moov Money **Burkina** ;
   6. existe-t-il un mode test ?
   7. format du relevé : colonnes, fuseau horaire, référence portée ;
   8. signature des webhooks, et procédure quand l'IP d'un serveur change.
4. Relancez au bout d'une semaine sans réponse.

**C'est bon quand** : vous avez une réponse **écrite** à chaque question et, pour la question 2, un document : contrat, attestation ou numéro d'agrément.

**À m'envoyer** : le texte de leurs réponses, sans adresse e-mail ni clé.

**Ce que je fais ensuite**
- Je reporte les réponses dans `docs/CONFORMITE.md` (§3 et §4) et dans l'ADR 0024.
- Si une réponse contredit mes hypothèses, je corrige l'adaptateur et ses tests. Par exemple si `Montant` est net, ou si `moyen` vaut `orange` sans pays.

**Si MoneyFusion n'a pas d'agrément valable au Burkina** : on en parle avant d'aller plus loin. Changer d'agrégateur est possible (le code est prévu pour), mais c'est une décision à prendre avec l'avocat de l'étape 2.

---

## Étape 2 — Conformité : avocat, comptable, puis CIL

**But** : remplir `docs/CONFORMITE.md`, condition de G-ARGENT. Aucun franc réel ne passe avant.

**Il vous faut**
- L'identité complète de Telecom Universel : forme juridique, RCCM, IFU, siège, régime fiscal.
- Un avocat inscrit au barreau du Burkina, qui pratique le droit des paiements (UEMOA, BCEAO) et des télécoms.
- Votre comptable.

**Gestes**
1. Lisez `docs/courriels/2026-11-14-LISEZMOI.md` : il dit à qui envoyer quoi, quelles pièces joindre, et dans quel ordre.
2. Dans les trois dossiers, remplacez chaque champ entre crochets : identité de Telecom Universel, noms, adresses.
3. **Avocat** : envoyez `2026-11-14-juriste.md`, avec les pièces listées en tête (schéma des flux, extraits de la spécification ; jamais la spécification entière).
   - Il y a 32 questions, dont une sur le recours à un agrégateur non agréé lui-même au Burkina.
   - Demandez une **réponse écrite et signée, question par question, textes cités**. Une réponse orale ne remplit aucune case.
   - Demandez d'abord ses honoraires et son délai.
4. **Comptable**, le même jour : envoyez `2026-11-14-comptable.md` (20 questions sur la facture de commission, la TVA, les recharges de crédits, l'archivage).
5. **CIL**, **après** la relecture du dossier par l'avocat : envoyez `2026-11-14-cil.md`. Il contient le projet de formalité pour les 10 traitements de données et la mention courte à afficher sur le portail. L'avocat peut en retirer des traitements.
6. Gardez chaque réponse : PDF signé, courrier, récépissé.

**C'est bon quand** : chaque ligne marquée « [À CONFIRMER] » dans `docs/CONFORMITE.md` a une pièce écrite, avec sa référence, sa date et son auteur.

**À m'envoyer** : chaque réponse, au fur et à mesure.

**Ce que je fais ensuite**
- Je remplis les cases et les durées de conservation de `CONFORMITE.md`.
- Je mets la mention de la CIL sur le portail.
- J'applique les mentions de facture demandées par le comptable.

---

## Étape 3 — Infrastructure : mesure, domaine, serveurs, comptes, déploiement

**But** : faire tourner la plateforme sur de vrais serveurs.

**Rappel** : je n'ai pas le droit de me connecter à une machine de production. C'est vous qui lancez les commandes ; je prépare, je relis les sorties et je corrige.

### 3.1 Mesurer la latence avant d'acheter les serveurs (LABO-17)

Il s'agit de choisir le datacenter d'après des mesures réelles depuis le Burkina (fibre, 4G, Starlink), et non au hasard.

1. Suivez `docs/PROTOCOLE_LATENCE.md` §5 :
   - J-7 : fiches de site et premier tri ;
   - J0 : petites VM temporaires dans chaque datacenter candidat, puis sondes ;
   - mesure d'environ 72 h, puis 12 à 24 h de plus en 4G et Starlink ;
   - collecte, puis destruction des VM le jour même.
2. Les scripts sont dans `infra/lab/latence/`. La sonde RouterOS (`routeros-sonde.rsc`) a été vérifiée sur CHR. Le script des VM (`serveur-vm.sh`) **n'a jamais tourné sur une vraie VM** : surveillez sa première installation (§5.2), avec la console de l'hébergeur à portée de main.
3. **À m'envoyer** : les fichiers collectés (§5.7). Je lance l'analyse (§6), et j'en déduis le datacenter et la valeur du `timeout` RADIUS.

### 3.2 Nom de domaine

1. Achetez le domaine et choisissez deux noms : `api.DOMAINE` et `portail.DOMAINE`.
2. Ne créez les entrées DNS qu'une fois l'IP de A connue (3.3). Les deux noms pointent vers **A** avant le premier déploiement : c'est la condition du certificat Let's Encrypt.

### 3.3 Deux serveurs Debian 13, chez deux hébergeurs différents

1. **A** (principal) dans le datacenter choisi en 3.1. **B** (réplique) chez un **autre** hébergeur (ADR 0004 ; obligatoire avant G-PILOTE).
2. Pour chacun : Debian 13, IP publique **fixe**, authentification SSH par clé, et **accès console** de l'hébergeur (en cas de coupure SSH).
3. Si l'hébergeur le permet, une IP dédiée de plus pour le portail (ADR 0013 §10).
4. Notez les IP publiques : elles vont dans l'inventaire Ansible, et chaque propriétaire devra les déclarer dans son application MoneyFusion.

### 3.4 Brevo (e-mails)

1. Créez le compte Brevo, avec la double authentification.
2. Authentifiez le sous-domaine `notif.DOMAINE` : SPF, DKIM selon la console Brevo, DMARC `p=quarantine`.
3. Désactivez le suivi des ouvertures et des clics.
4. Créez une clé API, limitée aux IP de A et B si Brevo le permet.
5. La clé va **directement** dans `/etc/wakatnet/api.env` des deux nœuds (3.6), jamais ailleurs.

### 3.5 Backblaze B2 (sauvegardes hors site)

1. Créez le compte, avec la double authentification, distinct de celui de l'hébergeur.
2. Créez un bucket privé, région EU Central, avec **Object Lock activé à la création** : il ne s'active pas après. Rétention par défaut : **conformité 30 jours**. Cycle de vie : versions masquées effacées après 31 jours.
3. Créez les deux clés **depuis votre poste** avec l'outil `b2`, en suivant `docs/MISE_EN_PRODUCTION.md` §1 « Clés B2 » (commandes exactes) : `wakatnet-noeuds` et `wakatnet-controle`. La clé maîtresse ne va jamais sur un serveur.

### 3.6 Déploiement

Suivez `docs/MISE_EN_PRODUCTION.md` §0 à §2, dans l'ordre. Chaque point se vérifie avant le suivant. En résumé :

1. **§0** : vérifiez les prérequis, dont les clés PGDG et FreeRADIUS **vérifiées par leur empreinte**.
2. **§1** : posez les secrets à la main sur chaque nœud, par `sudoedit`, un fichier par service (`infra/ansible/README.md`). Dans `/etc/wakatnet/api.env` :
   - `WAKATNET_CLE_MARCHANDS` et `WAKATNET_CLE_HMAC` : les **mêmes** valeurs sur A et B, avec une copie dans votre coffre (sans elles, rien n'est relisible après une restauration) ;
   - `WAKATNET_API_URL_PUBLIQUE=https://api.DOMAINE`, `WAKATNET_PORTAIL_URL_PUBLIQUE=https://portail.DOMAINE` et `WAKATNET_PORTAIL_IPS=<IP du portail>` ;
   - `WAKATNET_RACINES_TLS=/opt/wakatnet/infra/tls/racines-api.pem` ;
   - les variables Brevo (3.4) ;
   - **pas** `WAKATNET_ARGENT_REEL` : il ne sera posé qu'à l'étape 6.
3. **§2** : déployez.
   1. Copiez l'inventaire d'exemple et remplissez-le : IP, clés publiques WireGuard, noms ; `frontal_tls: letsencrypt` sur A, `autosigne` sur B.
   2. Créez les entrées DNS vers A.
   3. Déployez A, puis B en réplique.
   4. Vérifiez la réplication et la page `https://api.DOMAINE/etat`.
   5. Créez le compte super-admin (commande au §2, étape 6), puis scannez l'URI TOTP **une seule fois**.
   6. Lancez la première sauvegarde et le premier essai de restauration (§2, étape 7).
   7. Vérifiez qu'une alerte Telegram arrive bien (§2, étape 8).
4. **Vérifications TLS** (§1, « Racines TLS ») :
   1. comparez les deux empreintes de `infra/tls/README.md` avec celles de `https://letsencrypt.org/certificates/` ;
   2. lancez les deux commandes `openssl` qui vérifient la chaîne **réellement servie** par nginx.
5. **Avant G-PILOTE** :
   - l'exercice d'effacement B2, **sur une machine jetable, jamais sur A ni B** (§2, étape 7) ;
   - le contrôle externe B2, sur une troisième machine.

**C'est bon quand** :
- `https://api.DOMAINE/etat` répond ;
- la réplication est à jour ;
- la sauvegarde et l'essai de restauration sont réussis ;
- l'alerte de test est reçue ;
- `openssl verify` affiche `OK`.

**À m'envoyer** : la sortie de chaque commande de vérification (sans secret), et toute erreur telle quelle. Je corrige les rôles Ansible ou la configuration si quelque chose ne passe pas. Le déploiement n'a été prouvé que sur des conteneurs, jamais sur une vraie VM : des écarts sont possibles.

---

## Étape 4 — Matériel : un vrai routeur et de vrais téléphones

**But** : prouver ce qu'un banc virtuel ne peut pas prouver.

**Il vous faut**
- Un routeur MikroTik avec un hotspot configuré. De préférence en **RouterOS 7.15 à 7.18**, le cas le plus délicat (ni magasin de certificats, ni ligne de commande longue testée) ; idéalement un second en 7.19 ou plus.
- Un téléphone Android et un iPhone, avec des comptes Orange Money et Moov Money.
- Votre compte propriétaire sur la plateforme de l'étape 3.

**Gestes** (le guide propriétaire `docs/ONBOARDING_ROUTEUR.md` décrit les écrans)

1. **Enrôlement par la vraie commande.**
   - Dans le tableau de bord, cliquez **Raccorder un routeur**.
   - Copiez la commande (quatre lignes), puis collez-la **dans le terminal de Winbox**. La première ligne fait environ 3,1 Ko ; le banc l'envoyait autrement, je ne sais pas si Winbox l'accepte d'un bloc.
   - Notez exactement ce qu'affiche le terminal. Il doit finir par « routeur enrôlé ».
   - Si la ligne est coupée ou refusée, notez où.
2. **Page de paiement depuis un téléphone non connecté.**
   - Connectez le téléphone au Wi-Fi du hotspot sans ticket. Ouvrez le portail, choisissez un forfait et lancez l'achat.
   - Vérifiez que la page MoneyFusion (`payin.moneyfusion.net`) s'affiche **entièrement** : styles, logos, champs.
   - Vérifiez aussi qu'avec ce téléphone sans ticket **aucun autre site** ne s'ouvre. Le walled garden ne doit pas devenir un accès Internet gratuit.
   - Cet essai ne demande pas de payer : arrêtez-vous à la page MoneyFusion.
3. **Retour au portail** (à faire réellement à l'étape 6, avec de l'argent) : après le paiement, le téléphone doit revenir sur la page de suivi et afficher son ticket. Notez s'il revient, et si le ticket apparaît sans rien ressaisir.
4. **Les 10 essais LABO ouverts**, décrits dans `docs/LABO.md` :

| Essai | Ce qu'on vérifie |
|---|---|
| LABO-00 | L'Access-Request et le Message-Authenticator (refus du login si le serveur ne le renvoie pas) |
| LABO-01 | `/radius incoming` : port réel (1700 ou 3799), source non déclarée |
| LABO-02 | Déconnexion et CoA de bout en bout ; attributs vraiment modifiables |
| LABO-09 | Valeur du `timeout`, bascule de A vers B, ordre des entrées `/radius` |
| LABO-14 | HTTPS du walled garden par nom d'hôte (portail et MoneyFusion) |
| LABO-15 | Code d'option DHCP réellement envoyé (160 ou 114) |
| LABO-16 | RouterOS bascule-t-il vers B sur un refus, ou seulement sur un délai dépassé ? |
| LABO-17 | Latence réelle (étape 3.1) |
| LABO-18 | `Acct-Session-Id` réutilisé après une coupure de courant ? |
| LABO-19 | `Acct-Interim-Interval` appliqué ? Écart réel entre deux mises à jour |

**C'est bon quand** : chaque essai a un résultat noté (réussi ou échoué) et une preuve (capture, texte du terminal ou journal).

**À m'envoyer**
- Pour chaque essai : le résultat et le texte affiché.
- Pour l'enrôlement : la sortie complète du terminal.
- Pour la page MoneyFusion : une capture, plus la liste des éléments manquants s'il y en a.

**Ce que je fais ensuite**
- Je corrige le code ou les scripts RouterOS : par exemple découper la ligne de commande, ou ouvrir un domaine de plus pour la page MoneyFusion.
- Je mets à jour `docs/LABO.md`, `docs/PILOTE.md` et `docs/ONBOARDING_ROUTEUR.md`.

---

## Étape 5 — Compter les routeurs encore en RouterOS 6

**But** : décider si le support de RouterOS 6 vaut d'être développé (phase 2b, ADR 0003 : un autre tunnel, plusieurs jours de travail).

**Gestes**
1. Demandez à chaque futur propriétaire pilote la sortie de `/system resource print` (lignes `version` et `board-name`).
2. Pour chaque routeur en version 6, demandez si une mise à jour vers 7.15 ou plus est possible : certains vieux modèles ne la supportent pas.

**À m'envoyer** : un tableau simple, avec pour chaque routeur le modèle, la version, et si une mise à jour est possible (oui ou non).

**Ce que je fais ensuite** :
- si la plupart peuvent passer en version 7 : on n'enrôle que la version 7, et la phase 2b est abandonnée ;
- sinon, je propose un ADR sur le tunnel à utiliser pour la version 6.

---

## Étape 6 — Ouvrir l'argent réel (G-ARGENT) : le premier paiement de 100 F

**Condition** :
- l'étape 1 est faite : MoneyFusion a répondu par écrit, avec un agrément ou un contrat valable ;
- l'étape 2 est faite : `CONFORMITE.md` est rempli ;
- l'étape 3 est faite : la plateforme est en ligne.

**But** : vérifier sur un vrai paiement ce que la documentation de MoneyFusion ne dit pas (montant brut ou net, valeur de `moyen`). MoneyFusion n'a pas de mode test : c'est le seul moyen.

**Gestes**
1. Sur les deux nœuds, ajoutez `WAKATNET_ARGENT_REEL=1` dans `/etc/wakatnet/api.env` (par `sudoedit`), puis redémarrez `wakatnet-api` et `wakatnet-taches`.
2. Finissez l'application MoneyFusion commencée à l'étape 1 :
   - **IP autorisées** : les IP publiques de A **et** de B ;
   - **site** : `https://portail.DOMAINE`.
3. Une fois l'application validée, copiez le **lien API** que MoneyFusion génère. Dans le tableau de bord, ouvrez **Compte marchand**, collez le lien, puis cliquez **Enregistrer**. La page affiche ensuite les IP à déclarer : vérifiez qu'elles correspondent à l'étape 2.
4. Créez un forfait à **100 F**.
5. Avec un téléphone connecté au hotspot, achetez ce forfait par Orange Money. Recommencez ensuite avec Moov Money.
6. Pour chaque achat, regardez dans le tableau de bord :
   - le statut du paiement : réussi ou **écart** ;
   - le ticket délivré ou non ;
   - le texte de l'alerte d'écart, s'il y en a une.

**Résultats possibles**
- **Ticket délivré** : le montant et le moyen sont bien lus, la vente peut ouvrir.
- **Écart** (vous êtes débité de 100 F, aucun ticket) : c'est le comportement prévu quand mes hypothèses sont fausses. Aucun ticket gratuit ne sort. Vous perdez au pire 100 F par essai.

**À m'envoyer** : le statut, l'heure, et le texte de l'alerte d'écart. Aucun numéro de téléphone complet.

**Ce que je fais ensuite**
- En cas d'écart, je corrige l'adaptateur (lecture du montant, liste des moyens du Burkina), puis je vous demande un second essai de 100 F.
- Quand deux achats (Orange et Moov) délivrent leur ticket, je consigne la preuve : G-ARGENT est franchie.

---

## Étape 7 — Le pilote

**But** : faire tourner WAKATNET en conditions réelles, d'abord chez vous, puis chez trois propriétaires.

**Gestes**
1. **Site de Telecom Universel, deux semaines** (`docs/PILOTE.md` §3) : petits montants, ventes réelles.
2. **Chaque jour**, exportez le relevé MoneyFusion et lancez le rapprochement (`docs/PILOTE.md` §4).
   - Envoyez-moi le **premier export** : son format n'est pas documenté, je dois régler l'outil dessus (noms de colonnes, format des dates, frais).
3. **Critères d'arrêt** (`docs/PILOTE.md` §5) : un seul écart d'argent non expliqué arrête le pilote jusqu'à son explication.
4. **G-PILOTE** : quand les étapes 3 à 5 sont faites, que B tourne chez le second hébergeur et qu'une bascule a été rejouée (RUNBOOK §3), on la franchit.
5. **Trois propriétaires pilotes** (`docs/PILOTE.md` §7). Pour chacun :
   - créer son compte MoneyFusion et son application (IP de A et B, site du portail) ;
   - créer son compte WAKATNET ;
   - enrôler son routeur ;
   - lui remettre le guide imprimé (`docs/guides/guide-pilote.pdf`).

**À m'envoyer** : le premier export du relevé, puis tout écart ou incident, avec l'heure et la référence du paiement (`wk_…`).

---

## Récapitulatif

| Étape | Vous faites | Vous m'envoyez | Débloque |
|---|---|---|---|
| 0 | Protection de `main`, suppression du secret pawaPay | — | Plus de fusion rouge |
| 1 | Compte MoneyFusion, courriel | Leurs réponses écrites | G-ARGENT |
| 2 | Avocat, comptable, puis CIL | Les avis écrits | G-ARGENT |
| 3 | Mesure, domaine, 2 serveurs, Brevo, B2, déploiement | Sorties des vérifications | Tout le reste |
| 4 | Routeur et téléphones, essais LABO | Résultats et captures | G-PILOTE |
| 5 | Versions RouterOS du parc | Le tableau | Décision RouterOS 6 |
| 6 | `WAKATNET_ARGENT_REEL=1`, paiements de 100 F | Statut et alerte éventuelle | Ouverture de la vente |
| 7 | Pilote de 2 semaines, puis 3 propriétaires | Premier relevé, écarts | Lancement |
