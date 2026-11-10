# Questionnaire aux agrégateurs de paiement

> **Date : 10/11/2026.** Livrable du §12 (phase 0) et du §15 item 3 du SPEC.
> À envoyer par Telecom Universel aux prestataires retenus dans `docs/PAYMENT_PROVIDERS.md` §1.3.
> Mode d'emploi : copier le **courriel type** (§1), y coller la **partie générale** (§2), puis la **section propre au destinataire** (§3). Les champs entre crochets sont à remplir avant l'envoi.
> Demander des réponses **écrites**, de préférence avec des liens vers la documentation officielle ou les conditions contractuelles. Une réponse orale ne lève aucun [À CONFIRMER].
> Reporter chaque réponse dans `docs/PAYMENT_PROVIDERS.md` (statut « confirmé par écrit le JJ/MM/AAAA ») et, pour les points réglementaires, dans `docs/CONFORMITE.md`.

---

## 1. Courriel type

**Objet :** Demande d'informations — intégration Mobile Money pour une plateforme de WiFi Zones au Burkina Faso

Madame, Monsieur,

Telecom Universel, société basée à Ouagadougou, prépare le lancement de **WAKATNET**, une plateforme qui permet aux exploitants de WiFi Zones du Burkina Faso de vendre des forfaits de connexion depuis leur portail captif, payés par Orange Money et Moov Money.

Nous étudions plusieurs prestataires de paiement et souhaitons intégrer le vôtre. Notre cas d'usage a trois particularités, qui expliquent nos questions :

1. **Des micro-paiements.** Le forfait le plus vendu coûte **100 FCFA** ; la grille va de 100 à 1 000 FCFA. Le montant minimum et tout frais fixe par transaction sont donc déterminants.
2. **Un client sans Internet.** L'acheteur est connecté à un Wi-Fi qui ne lui donne pas encore accès à Internet. Le paiement doit pouvoir se faire **sans redirection** vers une page externe : saisie du code OTP Orange Money sur notre page, ou validation poussée Moov Money, avec un appel de serveur à serveur.
3. **Plusieurs exploitants.** Chaque exploitant de WiFi Zone vend pour son propre compte. Nous voulons savoir comment votre offre permet de servir plusieurs marchands depuis une même plateforme, et dans quel cadre réglementaire.

Vous trouverez ci-dessous nos questions, numérotées pour faciliter la réponse. Nous vous serions reconnaissants de bien vouloir y répondre par écrit, en joignant si possible les liens vers votre documentation technique et vos conditions tarifaires. Nous souhaiterions également recevoir des **identifiants d'accès à votre environnement de test**.

Nous restons à votre disposition pour un échange téléphonique ou une réunion si vous le jugez utile.

Veuillez agréer, Madame, Monsieur, nos salutations distinguées.

[Nom et fonction]
Telecom Universel, Ouagadougou
[Coordonnées professionnelles]

---

## 2. Questions générales (à envoyer à tous)

### A. Couverture et parcours de paiement

1. Quels portefeuilles du **Burkina Faso** sont actifs aujourd'hui en encaissement par votre API : Orange Money, Moov Money, Wave, Telecel Money, Sank Money, Coris Money ? Sont-ils activés par défaut sur un compte marchand burkinabè ?
2. Proposez-vous un **paiement sans redirection** (API de serveur à serveur), sans page hébergée, sans script ni widget chargé dans le navigateur du client ?
   - a. **Orange Money BF** : pouvons-nous transmettre le numéro et le code OTP saisi par le client sur notre page ? Quel est le **code USSD exact** que le client doit composer pour générer cet OTP : `*144*4*6*MONTANT#`, `*144*4*6#` ou une autre syntaxe ? Quelle est la **longueur** et la **durée de validité** de l'OTP ?
   - b. **Moov Money BF** : la validation est-elle poussée sur le téléphone (USSD push, code secret) ? Que se passe-t-il si la notification n'arrive pas (repli par `*555*6#`, OTP par SMS) ? Au bout de combien de temps la demande expire-t-elle ?
3. Si une **redirection** est inévitable pour un opérateur : quelle est la **liste exacte des domaines** (et IP) chargés par votre page de paiement, y compris les redirections vers l'opérateur ? Nous devons les autoriser un par un, sans joker.
4. Un client peut-il payer **deux fois de suite le même montant** (deux forfaits de 100 FCFA) avec le même numéro, à quelques minutes d'intervalle ? Existe-t-il une règle anti-doublon côté opérateur ou côté vous qui le refuserait, et avec quelle fenêtre ?
5. Fournissez-vous un endpoint de **vérification du statut** d'un paiement, interrogeable par notre serveur ? Quels sont les statuts possibles et leur signification exacte (initié, en attente, réussi, échoué, expiré) ?
6. Acceptez-vous une **clé d'idempotence** fournie par le marchand (notre référence de paiement) ? Que renvoyez-vous si la même référence est soumise deux fois ?

### B. Montants et frais

7. Quel est le **montant minimum** d'une transaction, par opérateur au Burkina ? Un paiement de **100 FCFA** est-il accepté sur Orange Money BF et sur Moov Money BF ? Quel est le maximum ?
8. Les montants doivent-ils respecter une règle (entier, multiple de 5 ou de 50) ? Les exprimez-vous en francs entiers ou en unités mineures ? En nombre ou en chaîne ?
9. Quelle est votre **grille de frais d'encaissement**, par opérateur au Burkina, en pourcentage ? Ces taux sont-ils **hors taxes ou TTC** ? Quelle TVA s'applique ?
10. Existe-t-il un **frais fixe** par transaction (en francs), un abonnement mensuel, des frais d'installation, des frais de gestion de compte ?
11. Comment est **arrondi** un frais fractionnaire ? Exemple : 2,5 % de 100 FCFA donne 2,5 FCFA ; quel montant est prélevé ?
12. Les frais sont-ils supportés par le **marchand** ou peuvent-ils être ajoutés au montant payé par le **client** ? Le choix est-il paramétrable par transaction ?
13. Vos tarifs sont-ils **dégressifs** selon le volume ? Si une plateforme apporte le volume cumulé de nombreux exploitants, ce volume peut-il servir à fixer la grille appliquée à chacun d'eux ?
14. Avec quel **préavis** une modification de tarif est-elle notifiée ? Le contrat prévoit-il une sortie sans pénalité dans ce cas ?

### C. Webhooks et sécurité

15. Vos notifications (webhooks, callbacks, IPN) sont-elles **signées** ? Avec quel algorithme (par exemple HMAC-SHA256 du corps brut), quel secret, dans quel en-tête, avec quel encodage ?
16. La signature couvre-t-elle un **horodatage** ou un nonce permettant de rejeter un rejeu ? Quelle fenêtre de validité recommandez-vous ?
17. Depuis quelles **adresses IP** vos notifications sont-elles émises ? Quelle est votre politique de **relance** (nombre, intervalle, délai de réponse attendu) ?
18. Exigez-vous une **liste blanche des IP** de nos serveurs ? Nous utilisons deux serveurs chez deux hébergeurs différents : pouvons-nous déclarer les deux, pour l'encaissement comme pour les transferts ?
19. Comment se fait la rotation des clés API et des secrets de webhook, sans interruption de service ?

### D. Environnement de test

20. Disposez-vous d'un **bac à sable** séparé de la production ? Comment l'obtenir et en combien de temps ?
21. Le bac à sable couvre-t-il **le Burkina** (Orange BF, Moov BF) ? Fournissez-vous des **numéros de test +226** et des moyens de simuler : un OTP valide, un OTP erroné, un solde insuffisant, une validation Moov jamais faite, une notification tardive ou jamais envoyée, un doublon de notification ?

### E. Transferts (payout)

22. Proposez-vous une **API de transfert** vers des numéros **Orange Money BF, Moov Money BF et Wave BF** ?
23. Quels sont, par destination : les **frais** (pourcentage, frais fixe), les **plafonds** (par opération, par jour, par mois), le **montant minimum**, les **délais** réels ?
24. Le transfert est-il **idempotent** (clé fournie par le marchand) ? Envoyez-vous une notification de statut ? Que faut-il faire en cas de coupure réseau pendant un transfert, avant toute relance ?
25. Un endpoint permet-il de lire le **solde** disponible ?

### F. Plusieurs exploitants, encaissement pour compte de tiers

26. Chaque exploitant de WiFi Zone peut-il ouvrir **son propre compte marchand** chez vous, rattaché à notre plateforme ? Quelles **pièces** sont exigées (personne physique, entreprise individuelle, société ; RCCM, IFU, pièce d'identité) ? Quel est le délai d'ouverture ? Existe-t-il un parcours simplifié pour les marchands apportés par une plateforme partenaire ?
27. Proposez-vous des **sous-comptes marchands** ou une **répartition automatique** d'un paiement entre plusieurs bénéficiaires (par exemple 90 % à l'exploitant, 10 % à la plateforme), les fonds de chaque bénéficiaire restant chez vous ?
28. Une plateforme peut-elle **encaisser pour le compte de tiers** (les exploitants) sur son propre compte marchand, puis leur reverser leur part ? Si oui : **sous quel statut** et avec quel contrat (offre partenaire, marque blanche, programme « payment facilitator ») ? Si non : quel montage recommandez-vous ?
29. Vos conditions générales interdisent-elles certaines activités pertinentes ici (revente de connectivité, intermédiation, agrégation de marchands) ?

### G. Statut réglementaire et contrat

30. Sous quel **agrément BCEAO** opérez-vous au Burkina Faso : établissement de paiement, établissement de monnaie électronique, banque, agent ou partenaire d'un établissement agréé ? Merci d'indiquer la **raison sociale**, le **numéro d'agrément** et la **date**.
31. Quelle **entité juridique** signerait le contrat avec une société burkinabè, et de quel droit relève-t-il ?
32. Êtes-vous **participant à PI-SPI**, ou passez-vous par un participant ? Selon la presse, la BCEAO aurait rendu PI-SPI obligatoire pour les transactions de monnaie électronique interopérables à partir du 2 novembre 2026 : pouvez-vous le confirmer, et cela change-t-il vos tarifs ou vos parcours au Burkina ?
33. Quel est le **délai de règlement** des fonds encaissés (vers le solde, puis vers un compte bancaire ou mobile money) ? Sa fréquence ? Existe-t-il un **seuil minimum** de règlement ?
34. Dans quels cas pouvez-vous **bloquer ou retenir** des fonds, et pour quelle durée maximale ?
35. Où sont **hébergées** les données des transactions (numéros des payeurs) ? Proposez-vous un accord de traitement des données personnelles ?
36. Publiez-vous un **engagement de disponibilité** et une page d'état ? Comment sommes-nous informés d'un incident ?
37. Disposez-vous d'un **support technique au Burkina** ou dans la zone UEMOA, et à quels horaires ?

---

## 3. Questions propres à chaque prestataire

À ajouter après la partie générale. Elles portent sur des points que nos lectures n'ont pas pu établir, ou sur des contradictions relevées dans les sources publiques.

### 3.1 pawaPay (Kerry Payments Burkina)

P1. Pouvez-vous nous communiquer la réponse de `GET /v2/active-conf?country=BFA` pour `ORANGE_BFA` et `MOOV_BFA` : `minAmount`, `maxAmount` et `decimalsInAmount` pour les dépôts et les payouts, ainsi que les instructions USSD affichées au client pour générer l'OTP Orange ?
P2. D’après un extrait de votre page de tarifs, que nous n’avons pas pu lire en entier, elle indiquerait pour Moov BF une collecte « tiered » à 3 % (2 % MMO + 1 % pawaPay) et un décaissement à 2 %. Quels sont les taux pour **Orange BF**, et quels sont les paliers ?
P3. Le **payout vers Orange BF** est-il activé aujourd'hui ? Votre annonce de lancement au Burkina indiquait qu'il ne l'était pas encore.
P4. Signature des callbacks (RFC 9421) : quels composants sont couverts, quel encodage de la signature ECDSA (brut r‖s ou DER), et quelle fenêtre de fraîcheur recommandez-vous sur `Signature-Date` ?
P5. D'après un extrait de vos conditions d'utilisation, que nous n'avons pas pu lire en entier, elles interdiraient d'ouvrir un compte pour un tiers. Votre annexe « sous-marchands » peut-elle s'appliquer à une plateforme qui raccorde des exploitants de WiFi Zone ? À quelles conditions ?
P6. Délais de règlement au Burkina : deux versions circulent (T+5 / T+7 et T+6 / T+8). Lesquels s'appliquent, et à quelle option correspond chacun, ainsi que le préfinancement T+2 / T+4 ?
P7. Pouvez-vous confirmer le numéro et la date d'agrément de Kerry Payments Burkina (EP.BF.002/2025 sur la liste BCEAO au 28/02/2026), et que c'est l'entité contractante pour un marchand burkinabè ?

### 3.2 CinetPay

C1. Laquelle de vos deux API recommandez-vous en production : l'API v2 (`api-checkout.cinetpay.com`, page hébergée) ou l'API v1 (`api.cinetpay.co`, `direct_pay`) ? Où se trouve la **documentation officielle de l'API v1** ? Nous ne l'avons trouvée que dans vos SDK GitHub.
C2. Le `direct_pay` fonctionne-t-il pour **OM_BF** et **MOOV_BF** sans aucune redirection (`must_be_redirected` toujours faux) ? Quel `channel` utiliser pour chacun ?
C3. Grille Burkina : d'après des extraits de vos pages que nous n'avons pas pu lire en entier, une page indiquerait 3 % pour Orange BF et Moov BF, une autre 4,5 % et 3,5 %. Quelle grille s'applique contractuellement ? Avec ou sans TVA ?
C4. Le code **606 INCORRECT_SETTINGS** peut-il être renvoyé lorsqu'un même numéro paie le même montant deux fois en peu de temps ? Pouvez-vous nous citer le texte exact et la fenêtre ?
C5. Transferts au Burkina : le minimum est-il de **500 FCFA** ? Les montants Orange doivent-ils être multiples de 5 ou de 50, et un montant non conforme est-il arrondi (au plus proche ou à l'inférieur) ou refusé ? Frais exacts (1,5 % ou 2 %) ?
C6. `WAVE_BF` figure dans votre SDK : Wave est-il actif au Burkina, en encaissement et en transfert ?
C7. Le webhook de l'API v1 peut-il être signé (HMAC du corps avec horodatage) en plus du `notify_token` ?
C8. Pouvez-vous fournir des **numéros de test +226** ? Nous n'avons trouvé que des numéros +225.
C9. Votre offre partenaire en **marque blanche** : conditions, statut réglementaire sous lequel elle s'exerce au Burkina, possibilité d'un partage automatique des paiements ?
C10. Un compte CinetPay pour le Burkina est-il ouvert par CinetPay Africa (agréée en Côte d'Ivoire, EP.CI.007/2025) ou par une autre entité ? Le délai de reversement est-il de 7 ou de 8 jours ?

### 3.3 YengaPay (Kreezus)

Y1. Quel est le **montant minimum réel** (`minAmount`) par opérateur au Burkina (Orange, Moov, Telecel, Coris, Sank) ? L'exemple de votre SDK montre 200 FCFA pour Orange : un paiement de 100 FCFA est-il possible ?
Y2. Pouvez-vous confirmer par écrit les frais de 2,5 % (PayIns) et 1,5 % (Payouts), l'absence de frais fixe et la règle d'arrondi ?
Y3. Signature des webhooks : confirmez-vous l'en-tête `X-Webhook-Hash` = HMAC-SHA256 en hexadécimal du corps brut avec le Webhook Secret ? Existe-t-il un horodatage anti-rejeu ? Depuis quelles IP ?
Y4. Les **payouts** envoient-ils un webhook de statut ? Acceptent-ils une clé d'idempotence ? Que fait exactement `POST …/payout/{id}/retry`, et peut-il provoquer un double envoi ?
Y5. Le paiement en masse décrit dans le README du SDK `@yengapay/nodejs-sdk` n'est pas implémenté dans la version 0.1.0 : est-il disponible par l'API ?
Y6. Quelle est l'URL de base canonique : `https://api.yengapay.com/api/v1` ou `https://api.yengapay.com/api` ?
Y7. Flux Telecel Money (TWO_STEP) : OTP par SMS ou validation poussée ? Durées de validité du payment intent (`expiresAt`) et de l'OTP (`otpExpiresIn`) ?
Y8. Un groupe ou un projet peut-il représenter un exploitant tiers, avec un reversement séparé ou un partage automatique ?
Y9. Sous quel agrément BCEAO Kreezus opère-t-il, directement ou par un partenaire agréé ?

### 3.4 LigdiCash

L1. Grille tarifaire d'encaissement Orange BF et Moov BF : taux, frais fixe éventuel, qui paie les frais ? Coût exact d'un paiement de 100 FCFA ?
L2. Montants minimum et maximum par opérateur (nous avons vu 10 FCFA pour Orange, 100 FCFA pour Moov, sans pouvoir le vérifier) ?
L3. Code USSD exact pour Orange BF : `*144*4*6#` ou `*144*4*6*MONTANT#` ? Durée de validité de l'OTP ?
L4. Mode de validation définitif de Moov BF : USSD push avec repli « USSD guidé », ou OTP par SMS ? Vos pages se contredisent.
L5. Les callbacks sont-ils **signés** ? Que contient `custom_data.hash` et comment le vérifier ? Depuis quelles IP sont-ils émis ?
L6. Existe-t-il un environnement `test.ligdicash.com` (déclaré dans votre SDK) ou seulement un compte temporaire en production ?
L7. Payout marchand vers numéro mobile money : destinations BF (Orange, Moov, Wave), frais, plafonds, délais, et **méthode de calcul du hash** exigé ?
L8. La liste blanche IP est-elle exigée aussi pour l'encaissement ? Combien d'IP peut-on déclarer ?
L9. En mode « un compte marchand par exploitant », chaque exploitant doit-il signer son propre contrat et ouvrir son propre projet API ?
L10. Sous quel statut et quel agrément BCEAO LigdiCash opère-t-il (raison sociale, numéro, catégorie) ?
L11. Délai, fréquence et seuil de règlement vers compte bancaire ou mobile money ?
L12. Pour information : dans le SDK JavaScript officiel, `payWithoutRedirection` place `callback_url` dans `cancel_url`. Pouvez-vous confirmer le format attendu de `actions.callback_url` ?

### 3.5 InTouch (InTouch Burkina)

I1. Quels opérateurs burkinabè sont disponibles en collecte par API (Orange, Moov, Wave, Telecel, Sank), et avec quels codes de service ?
I2. Proposez-vous un parcours Orange BF par OTP saisi chez le marchand et un parcours Moov BF par validation poussée, **sans page hébergée** ?
I3. Pouvez-vous nous transmettre la **documentation complète de l'API Touch Pay** pour le Burkina (paramètres, statuts, callbacks) ? La documentation publique indique que le simulateur est en développement : le bac à sable est-il opérationnel ?
I4. Signature des callbacks : algorithme, en-tête, secret, anti-rejeu, IP sources ?
I5. Grille de frais, frais fixe et montant minimum pour un paiement de 100 FCFA ? Unités des montants ?
I6. Paiement de masse vers Orange, Moov et Wave BF : frais, plafonds, délais, idempotence ?
I7. En tant qu'établissement de paiement agréé au Burkina (EP.BF.001/2025 d'après la liste BCEAO), pouvez-vous offrir à une plateforme un montage de **sous-marchands** ou de **répartition** des paiements, ou un encaissement pour compte de tiers encadré ? Date d'agrément ?
I8. Délai de règlement ?

### 3.6 FedaPay

F1. Le paiement sans redirection (`POST /{mode}` avec le jeton de transaction) fonctionne-t-il pour **Orange BF** et **Moov BF** ? Quels codes de mode utiliser ?
F2. Pour Orange BF, prenez-vous en charge le flux pré-OTP (code saisi sur la page du marchand) ?
F3. Si seule la page hébergée est possible pour le Burkina : liste exacte de ses domaines ?
F4. Taux actuel d'encaissement au Burkina (4 % ?), frais fixe éventuel, minimum (100 FCFA ?) ? Le endpoint `GET /transactions/fees` reflète-t-il les frais réels ?
F5. Les payouts vers Orange BF et Moov BF sont-ils disponibles (codes `orange-bf` / `moov_bf`) ? Frais, plafonds, délais ?
F6. Le compte **Marketplace** et le partage vers des sous-comptes sont-ils disponibles dans l'API actuelle ? Paramètres ? Sous quel statut au Burkina, sachant que votre agrément (EP.BN.004/2026) est béninois ?
F7. IP sources des webhooks et politique de relance ? Numéros de test Orange BF et Moov BF ?

### 3.7 Wave (pour la recharge des crédits des exploitants, hors portail captif)

W1. Les API **Checkout**, **Payout** et **Aggregated Merchants** sont-elles ouvertes aux entreprises immatriculées au **Burkina Faso** ?
W2. Tarif de l'API Checkout au Burkina : pourcentage, frais fixe, minimum ? Le barème « 20 000 FCFA gratuits par jour, puis 1 % » s'applique-t-il à l'API ?
W3. Existe-t-il un bac à sable ?
W4. Un `wave_launch_url` peut-il être ouvert depuis le mini-navigateur de portail captif d'iOS ou d'Android ? Si l'appli doit joindre vos serveurs depuis un Wi-Fi qui n'a pas encore authentifié le client, quels domaines et IP faudrait-il autoriser ?
W5. Conditions d'accès à Aggregated Merchants (statut exigé, contrat) ; plafonds et délais de payout ; IP sources des webhooks ; existe-t-il un second mode d'authentification des webhooks en plus de `Wave-Signature` ?

---

## 4. Suivi des envois

| Prestataire | Destinataire | Date d'envoi | Relance | Date de réponse | Bac à sable reçu | Reporté dans PAYMENT_PROVIDERS / CONFORMITE |
|---|---|---|---|---|---|---|
| pawaPay | [à compléter] | | | | | |
| CinetPay | [à compléter] | | | | | |
| YengaPay | [à compléter] | | | | | |
| LigdiCash | [à compléter] | | | | | |
| InTouch | [à compléter] | | | | | |
| FedaPay | [à compléter] | | | | | |
| Wave | [à compléter] | | | | | |
