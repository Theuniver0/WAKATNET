# Courriels aux agrégateurs — 14/11/2026

> **Pour Yacouba, avant l'envoi.** Ces deux courriels remplacent, pour pawaPay et CinetPay, ceux de `2026-11-10-agregateurs.md`, qui n'ont jamais été envoyés et restent comme trace. Ils sont plus courts et ne demandent que ce qui manque pour G-ARGENT. Ordre d'envoi et suivi : `docs/courriels/2026-11-14-LISEZMOI.md`.
>
> - **Adresse** : [adresse], à prendre sur la page officielle « Contact » ou « Partenaires » de chaque prestataire. Aucune adresse n'est vérifiée dans le dépôt.
> - **Pièce jointe facultative** : le questionnaire complet (`pj/WAKATNET-questionnaire-pawapay.docx`, `pj/WAKATNET-questionnaire-cinetpay.docx`). Il date du 10/11/2026 ; il contient des questions auxquelles la documentation de pawaPay, lue le 12/11/2026 (ADR 0020), répond déjà. Le joindre seulement si l'on veut aussi les grilles tarifaires et les minimums.
> - **Ne rien promettre** sur les volumes : ils ne sont pas mesurés (`docs/G0.md`, Q1).
> - **Suivi** : noter la date d'envoi au §4 de `docs/QUESTIONS_AGREGATEURS.md`. Relance conseillée après 10 jours ouvrés.
> - **Report des réponses** : voir le tableau sous chaque courriel.

---

## 1. pawaPay (Kerry Payments Burkina)

**Objet :** WAKATNET — contrat marchand pour des exploitants de WiFi Zones au Burkina Faso : quatre questions

Madame, Monsieur,

Telecom Universel, société basée à Ouagadougou, prépare le lancement de **WAKATNET**. Cette plateforme permet aux exploitants de WiFi Zones du Burkina Faso de vendre leurs forfaits de connexion depuis leur portail Wi-Fi, payés par Orange Money et Moov Money.

Nous avons préparé notre intégration de votre API v2, d'après votre documentation publique. Avant tout encaissement réel, nous avons besoin de vos réponses **écrites** sur quatre points.

**1. Contrat marchand.** Dans notre modèle, **chaque exploitant a son propre compte marchand** chez vous et reçoit directement l'argent de ses clients. Notre plateforme ne détient jamais ces fonds. L'exploitant enregistre son jeton API dans notre plateforme ; nous l'utilisons pour créer les dépôts et en vérifier le statut. Les callbacks de son compte sont envoyés à une adresse de notre plateforme.
- Ce montage est-il permis par vos conditions ? Nous avons lu, en extrait seulement, qu'elles interdisent d'ouvrir un compte pour un tiers.
- Faut-il un contrat entre vous et notre plateforme, en plus du contrat de chaque exploitant ? Votre annexe « sous-marchands » s'applique-t-elle ici ?
- Un exploitant personne physique ou entreprise individuelle peut-il ouvrir un compte ? Avec quelles pièces, et dans quel délai ?

**2. Agrément.** Pouvez-vous confirmer que Kerry Payments Burkina est agréée comme établissement de paiement au Burkina Faso sous le numéro **EP.BF.002/2025**, nous donner la date de cet agrément, et nous dire si c'est elle qui signe le contrat d'un marchand burkinabè ?

**3. Relevé du compte.** Nous rapprochons chaque jour nos ventes avec votre relevé (export du tableau de bord ou `POST /v2/statements`). Pouvez-vous nous indiquer :
- la liste exacte des colonnes et leur ordre, ainsi que le séparateur ;
- le format des dates et leur **fuseau horaire** ;
- le format des montants : décimales, signe des débits ;
- les libellés exacts de la colonne `Type` ;
- si les lignes de frais portent le `Transaction ID` du dépôt auquel elles se rattachent ;
- si `Transaction ID` est toujours le `depositId` que nous avons fourni.

**4. Données personnelles.** Où sont hébergées les données des transactions, dont le numéro du payeur ? Proposez-vous un accord de traitement des données ?

Nous vous remercions par avance de votre réponse, et restons à votre disposition pour un échange.

Veuillez agréer, Madame, Monsieur, nos salutations distinguées.

[Nom et fonction]
Telecom Universel, Ouagadougou
[Téléphone] · [Adresse]

**Report des réponses de pawaPay :**

| Point | Case remplie |
|---|---|
| 1. Contrat marchand | `CONFORMITE.md` §3, ligne « pawaPay / Kerry Payments Burkina » : entité contractante, contrat signé, modes autorisés par écrit, encaissement pour compte de tiers. Et §12, première case (contrat signé de l'agrégateur de lancement) |
| 2. Agrément | `CONFORMITE.md` §4, ligne « pawaPay », colonne « Vérifié par Yacouba » ; et §12, deuxième case |
| 3. Relevé | **aucune case de CONFORMITE.md** : `docs/PILOTE.md` §4 (profil « Relevé pawaPay ») et ADR 0020, « Non prouvé ici » |
| 4. Données | `CONFORMITE.md` §6, ligne « Données échangées avec les agrégateurs » ; §7, T2, colonne « Lieu d'hébergement » |

---

## 2. CinetPay

**Objet :** WAKATNET — compte marchand au Burkina Faso pour des exploitants de WiFi Zones : quatre questions

Madame, Monsieur,

Telecom Universel, société basée à Ouagadougou, prépare le lancement de **WAKATNET**. Cette plateforme permet aux exploitants de WiFi Zones du Burkina Faso de vendre leurs forfaits de connexion depuis leur portail Wi-Fi, payés par Orange Money et Moov Money.

Nous avons préparé une intégration du paiement direct de votre API v1, d'après votre SDK officiel `cinetpay-js`. Avant tout encaissement réel, nous avons besoin de vos réponses **écrites** sur quatre points.

**1. Contrat marchand.** Dans notre modèle, **chaque exploitant a son propre compte marchand** chez vous et reçoit directement l'argent de ses clients. Notre plateforme ne détient jamais ces fonds. L'exploitant enregistre ses identifiants API dans notre plateforme ; nous les utilisons pour créer les paiements et en vérifier le statut.
- Ce montage est-il permis par vos conditions ? Faut-il un contrat entre vous et notre plateforme ?
- Un exploitant burkinabè, personne physique, entreprise individuelle ou société, peut-il ouvrir un compte pour encaisser au Burkina ? Avec quelles pièces, et dans quel délai ?

**2. Agrément au Burkina.** Selon un extrait de la liste de la BCEAO, CinetPay Africa est agréée comme établissement de paiement en Côte d'Ivoire (**EP.CI.007/2025**). Nous ne l'avons pas trouvée parmi les établissements agréés au Burkina Faso.
- Sous quel régime et par quelle entité fournissez-vous vos services d'encaissement au Burkina Faso ?
- Quelle pièce pouvez-vous nous communiquer pour l'attester ?
- Quelle entité signerait le contrat d'un exploitant burkinabè ?

**3. Montant dans le statut d'un paiement.** C'est pour nous un point **bloquant**. Notre serveur ne délivre un ticket qu'après avoir lu, dans la réponse de `GET /v1/payment/{identifiant}`, le **montant** et la **devise** effectivement payés. Votre SDK ne lit pas ces champs.
- La réponse de statut contient-elle toujours le montant et la devise ? Sous quels noms de champs, et à quel niveau du JSON ?
- Où se trouve la documentation officielle de l'API v1 ?

**4. Relevé du compte.** Nous rapprochons chaque jour nos ventes avec votre relevé. Pouvez-vous nous indiquer :
- comment l'obtenir (export du tableau de bord, API) ;
- la liste exacte des colonnes et leur ordre, ainsi que le séparateur ;
- le format des dates et leur **fuseau horaire** ;
- le format des montants, et la façon dont les frais apparaissent ;
- les libellés exacts des statuts ;
- la référence portée par chaque ligne : notre `merchant_transaction_id`, votre `transaction_id`, ou les deux.

Nous vous serions aussi reconnaissants de nous indiquer où sont hébergées les données des transactions, dont le numéro du payeur, et si vous proposez un accord de traitement des données.

Nous vous remercions par avance de votre réponse, et restons à votre disposition pour une réunion à Ouagadougou.

Veuillez agréer, Madame, Monsieur, nos salutations distinguées.

[Nom et fonction]
Telecom Universel, Ouagadougou
[Téléphone] · [Adresse]

**Report des réponses de CinetPay :**

| Point | Case remplie |
|---|---|
| 1. Contrat marchand | `CONFORMITE.md` §3, ligne « CinetPay » : entité contractante, contrat signé, modes autorisés par écrit, encaissement pour compte de tiers ; et §12, première case |
| 2. Agrément au Burkina | `CONFORMITE.md` §4, ligne « CinetPay », colonnes « Statut » et « Vérifié par Yacouba » ; et §12, deuxième case |
| 3. Montant au statut | **aucune case de CONFORMITE.md** : ADR 0022, décision 3 (verrou `MONTANT_AU_STATUT_CONFIRME`). Une réponse écrite ne lève pas le verrou : il faut aussi la preuve du bac à sable et un nouvel ADR |
| 4. Relevé | **aucune case de CONFORMITE.md** : ADR 0022, « Conséquences » (rapprochement) ; `docs/PILOTE.md` §4 |
| Données | `CONFORMITE.md` §6, ligne « Données échangées avec les agrégateurs » ; §7, T2, colonne « Lieu d'hébergement » |
