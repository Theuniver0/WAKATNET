# ADR 0017 — Quota d'enrôlement et vérification de l'adresse e-mail (revue de sécurité M4)

- **Statut** : décidé le 12/11/2026, par délégation de Yacouba (« tranche M4 »).
- **Références** : `docs/REVUE_SECURITE.md` (M4, F9) ; ADR 0001 §5 (accès ouvert) ; ADR 0012 §2 et §3 (adressage, jeton) ; migration 0033.

## Contexte

- **Inscription ouverte, gratuite et sans limite de comptes** (ADR 0001 §5).
- **Ce qu'un enrôlement consomme** : chaque enrôlement prend une adresse de l'overlay 10.213.0.0/16 (64 516 au total), **jamais réemployée**, même après révocation (ADR 0012 §2). Il ajoute aussi un pair à `wg0`.
- **Aucun routeur n'est nécessaire** : un jeton, puis un `POST /enroll/:jeton` avec une clé WireGuard tirée au hasard, suffisent. Un script HTTP peut donc remplir l'overlay ; plus aucun propriétaire ne peut alors raccorder de routeur.
- Un quota qui ne compterait que les routeurs **actifs** ne protège de rien : il suffit d'enrôler, de révoquer, puis de recommencer.
- Un quota **par compte**, sans vérification de l'adresse, se contourne en ouvrant d'autres comptes.

## Décision

1. **Quota d'enrôlement par propriétaire** : `tenant.quota_routeurs`, **10** par défaut, réglable par le super-admin de 0 à 10 000.
   - Il compte les routeurs **enrôlés, révoqués compris**, et les jetons encore ouverts (ni consommés ni expirés).
   - Au-delà, la commande d'enrôlement est refusée (409).
   - Le contrôle se fait sous verrou, par propriétaire : des demandes parallèles ne le dépassent pas.
2. **Adresse e-mail vérifiée**, exigée pour **raccorder un routeur** (créer une commande d'enrôlement) ; le reste du compte s'en passe. Elle se vérifie de deux façons :
   - **par un lien** :
     - jeton de 256 bits, empreinte seule en base, 24 h, usage unique ;
     - 3 envois par heure au plus ;
     - envoyé à l'inscription et à la demande ;
     - la page du lien demande un clic avant de consommer le jeton, car les antivirus de messagerie ouvrent les liens.
   - **par le super-admin**, avec le bouton « Valider l'adresse » de l'écran Administration. L'action est inscrite au journal d'audit.
3. **Fournisseur d'e-mail : pas encore choisi.** L'envoi passe par une interface (`apps/api/src/courriel.ts`), et la production n'a encore aucun expéditeur.
   - Tant qu'aucun fournisseur n'est choisi, la vérification passe par le super-admin. C'est suffisant pour le pilote : 1 site, puis 3 propriétaires que Yacouba connaît.
   - Brancher un fournisseur revient à écrire un adaptateur de quelques lignes, plus ses secrets. C'est une décision de Yacouba : coût, hébergement des données, délivrabilité au Burkina.
4. **Alerte** `overlay_plein` : plus de 80 % des adresses de l'overlay sont prises.
5. **Comptes existants à la migration** : leur adresse est réputée vérifiée, sauf un propriétaire qui n'a encore aucun routeur (le super-admin le valide).
6. **F9** (énumération des adresses inscrites, 409 à l'inscription) : **accepté pour l'instant**. Le fermer suppose une inscription qui n'ouvre pas de session avant la vérification ; c'est à revoir avec le fournisseur d'e-mail.

## Avant de brancher un fournisseur d'e-mail (relecture de la migration 0033)

**Remplies par l'ADR 0019 et la migration 0034** (fournisseur : Brevo).

M4 n'est **fermé que tant que la vérification se fait à la main**. Avec un lien par e-mail, un domaine « catch-all » donne autant de comptes vérifiés que voulu. Conditions à remplir dans le même changement que l'adaptateur :
- quota par défaut bas (1 ou 2) pour un compte vérifié par lien ; 10 seulement après validation du super-admin ;
- plafond global d'enrôlements par jour, et refus au-delà d'environ 90 % de l'overlay, sauf pour les comptes validés par le super-admin ;
- limite d'inscriptions et d'envois de liens par source ;
- inscription sans session avant la vérification (ferme aussi F9) ;
- le fournisseur devient sous-traitant de l'adresse e-mail : registre de traitement.

Déjà en place : 3 liens par heure, et 5 en tout par compte, contre l'envoi répété d'e-mails à l'adresse d'un tiers.

## Conséquences

- Pour remplir l'overlay, il faut désormais 6 452 comptes **vérifiés** (64 516 ÷ 10). Pendant le pilote, chacun est validé à la main ; une fois le fournisseur choisi, chacun demande une vraie boîte aux lettres.
- **Reste** : des adresses jetables, une fois le lien par e-mail en service. L'alerte `overlay_plein` laisse le temps d'agir : suspendre des comptes, baisser leur quota.
- **Pour le propriétaire** : un compte non vérifié voit pourquoi le raccordement est bloqué, et ce qu'il faut faire. Un propriétaire qui atteint son quota le voit aussi, et demande une hausse à Telecom Universel.
- Un routeur remplacé consomme une place du quota : le super-admin la rend en relevant le quota.

## Audit du 13/11/2026

Deux constats, corrigés par la migration 0036 (tests : `quota.test.ts`, « audit 13/11/2026 »).

1. **[Moyen] Plafonds globaux contrôlés à la création du jeton seulement.** Le plafond de 100 routeurs enrôlés par 24 h et l'arrêt à 90 % de l'overlay comptent les routeurs **enrôlés**, pas les jetons ouverts (choix de la relecture de 0034, pour qu'un jeton jamais consommé n'épuise pas le plafond de tous). Or `enroll_register` ne refaisait aucun contrôle. N comptes qui prennent chacun 2 jetons d'un coup, puis enrôlent dans les 30 min, dépassaient largement les deux plafonds.
   - **Décision** : `enroll_register` refait les contrôles au moment de la consommation, sous les mêmes verrous que `enrolement_autorise` : d'abord celui du propriétaire, puis le verrou global pour un compte non validé. Le verrou est tenu jusqu'à l'insertion du routeur.
   - **Refus** : statut `plafond`, traduit en **409** avec le même message qu'à la création. Le jeton reste intact : il pourra servir quand le plafond glissant se libère, ou après la validation du compte.
2. **[Faible] Un jeton émis survivait à la suspension et à la baisse du quota**, pendant ses 30 minutes de validité.
   - **À la consommation** : `enroll_register` relit le propriétaire. Un compte suspendu reçoit `suspendu`, traduit en **403**. Si les routeurs enrôlés, révoqués compris, plus celui-ci, dépassent le quota courant, le refus est `quota`, traduit en **409**. Le jeton reste intact dans les deux cas.
   - **Côté super-admin** : `admin_regler` (suspension) et `admin_acces` (baisse du quota) **expirent** les jetons ouverts du propriétaire. Le nombre de jetons expirés est inscrit au journal d'audit. Ces jetons ne reviennent pas quand la suspension est levée ou le quota relevé : le propriétaire crée une nouvelle commande.

**Ordre des verrous** dans `enroll_register` : ligne du jeton (`FOR UPDATE`), puis `wakatnet_quota:<propriétaire>`, puis `wakatnet_quota:global`, puis `wakatnet.overlay`.
- `enrolement_autorise` prend les deux mêmes verrous consultatifs, dans le même ordre, et n'attend aucune ligne de jeton existante.
- `admin_regler` et `admin_acces` ne prennent aucun verrou consultatif. Ils posent `FOR NO KEY UPDATE` sur la ligne du propriétaire, ce qui reste compatible avec le `FOR KEY SHARE` que prennent les clés étrangères des insertions de `enroll_register`. Ils verrouillent ensuite les jetons ouverts.
- Aucun cycle n'est donc possible. Un essai de concurrence, avec 40 enrôlements et 17 actions de super-admin en parallèle sur une base jetable, n'a produit aucun interblocage.

**Conséquence** : une baisse de quota expire **tous** les jetons ouverts du propriétaire, même ceux qui tiendraient sous le nouveau quota. C'est le plus simple et le plus sûr : la baisse est une action rare, contre un compte suspect.
