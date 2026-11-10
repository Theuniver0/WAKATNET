# Courriels aux agrégateurs — envoi du 10/11/2026

Trois courriels prêts à envoyer, un par prestataire prioritaire (classement provisoire de `docs/PAYMENT_PROVIDERS.md`). Chacun a pour pièce jointe le questionnaire complet du prestataire, généré depuis `docs/QUESTIONS_AGREGATEURS.md` :

| Destinataire | Pièce jointe |
|---|---|
| pawaPay (Kerry Payments Burkina) | `pj/WAKATNET-questionnaire-pawapay.docx` |
| CinetPay | `pj/WAKATNET-questionnaire-cinetpay.docx` |
| YengaPay (Kreezus) | `pj/WAKATNET-questionnaire-yengapay.docx` |

Pour régénérer les pièces jointes après une modification du questionnaire : `python3 docs/courriels/generer_pj.py` (exige pandoc).

**Avant l'envoi :**
1. **Adresse du destinataire.** Je ne l'ai **pas** renseignée : je n'ai pu vérifier aucune adresse commerciale officielle (sites bloqués depuis la session). La prendre sur la page « Contact » ou « Partenaires » officielle de chaque prestataire, ou passer par le formulaire de demande de compte marchand.
2. **Champs entre crochets** : nom, fonction, téléphone, adresse, RCCM/IFU si tu veux les donner d'emblée.
3. **pawaPay** est une société dont l'équipe commerciale travaille surtout en anglais. Le courriel est en français parce que l'entité locale (Kerry Payments Burkina) est burkinabè. Une version anglaise peut être préparée à la demande.
4. **Ne rien promettre** sur les volumes : les chiffres de trafic ne sont pas encore mesurés (question Q1 de `docs/G0.md`).
5. **Suivi** : noter la date d'envoi dans le tableau du §4 de `docs/QUESTIONS_AGREGATEURS.md`. Relance conseillée après 10 jours ouvrés.

---

## 1. pawaPay (Kerry Payments Burkina)

**Objet :** Intégration Orange Money et Moov Money Burkina — plateforme de WiFi Zones (micro-paiements de 100 FCFA)

Madame, Monsieur,

Telecom Universel, société basée à Ouagadougou, prépare le lancement de **WAKATNET**, une plateforme qui permet aux exploitants de WiFi Zones du Burkina Faso de vendre leurs forfaits de connexion directement depuis leur portail captif, payés par Orange Money et Moov Money.

Votre parcours d'encaissement direct (OTP Orange transmis par le serveur, validation Moov poussée sur le téléphone) correspond précisément à notre besoin, et nous envisageons pawaPay comme prestataire de lancement.

Notre cas d'usage a trois particularités :

1. **Des micro-paiements** : le forfait le plus vendu coûte **100 FCFA**.
2. **Un client sans Internet** : l'acheteur est sur un Wi-Fi qui ne l'a pas encore authentifié. Le paiement doit se faire **sans redirection** vers une page externe.
3. **Plusieurs exploitants** : au départ, chaque exploitant encaisse sur son propre compte marchand ; notre cible est un **partage automatique** de chaque paiement entre l'exploitant et la plateforme.

Les réponses qui nous permettront de décider rapidement sont les suivantes :

- Existe-t-il chez vous un cadre de **sous-marchands** applicable à une plateforme qui raccorde des exploitants de WiFi Zone, avec un partage automatique des paiements ? À défaut, chaque exploitant peut-il ouvrir son propre compte, avec quelles pièces et dans quel délai ?
- Un paiement de **100 FCFA** est-il accepté sur ORANGE_BFA et MOOV_BFA ? Quels sont vos frais au Burkina, en pourcentage, hors taxes ou TTC, et existe-t-il un **frais fixe** par transaction ?
- Pouvez-vous nous ouvrir un **accès au bac à sable** avec des numéros de test +226 ?

Vous trouverez en pièce jointe notre questionnaire complet (questions numérotées, avec un ordre de priorité à la question 40). Nous vous serions reconnaissants d'y répondre par écrit, en joignant les liens vers votre documentation et vos conditions tarifaires.

Nous restons à votre disposition pour un échange téléphonique ou une visioconférence.

Veuillez agréer, Madame, Monsieur, nos salutations distinguées.

[Nom et fonction]
Telecom Universel, Ouagadougou
[Téléphone] · [Adresse]

*Pièce jointe : WAKATNET-questionnaire-pawapay.docx*

---

## 2. CinetPay

**Objet :** Intégration Orange Money et Moov Money Burkina sans redirection — plateforme de WiFi Zones (micro-paiements de 100 FCFA)

Madame, Monsieur,

Telecom Universel, société basée à Ouagadougou, prépare le lancement de **WAKATNET**, une plateforme qui permet aux exploitants de WiFi Zones du Burkina Faso de vendre leurs forfaits de connexion directement depuis leur portail captif, payés par Orange Money et Moov Money.

CinetPay fait partie des prestataires que nous étudions pour le lancement. Notre cas d'usage a trois particularités :

1. **Des micro-paiements** : le forfait le plus vendu coûte **100 FCFA**.
2. **Un client sans Internet** : l'acheteur est sur un Wi-Fi qui ne l'a pas encore authentifié. Le paiement doit se faire **sans page hébergée**, par un appel de serveur à serveur (OTP Orange saisi sur notre page, validation Moov poussée).
3. **Plusieurs exploitants** : au départ, chaque exploitant encaisse sur son propre compte marchand ; notre cible est un **partage automatique** de chaque paiement entre l'exploitant et la plateforme.

Les réponses qui nous permettront de décider rapidement sont les suivantes :

- Votre **paiement direct** (`direct_pay`) fonctionne-t-il pour **Orange Burkina** et **Moov Burkina** sans aucune redirection ? Où se trouve sa documentation officielle ?
- Quelle **grille de frais** s'applique contractuellement au Burkina (nous avons vu des taux différents selon les pages), hors taxes ou TTC, et existe-t-il un frais fixe ? Le minimum de **100 FCFA** est-il confirmé ?
- Votre offre partenaire permet-elle un **partage automatique** des paiements entre un exploitant et la plateforme, et sous quel statut réglementaire au Burkina ?
- Pouvez-vous fournir des **numéros de test +226** pour votre bac à sable ?

Vous trouverez en pièce jointe notre questionnaire complet (questions numérotées, avec un ordre de priorité à la question 40). Nous vous serions reconnaissants d'y répondre par écrit, en joignant les liens vers votre documentation et vos conditions tarifaires.

Nous restons à votre disposition pour un échange téléphonique ou une réunion à Ouagadougou.

Veuillez agréer, Madame, Monsieur, nos salutations distinguées.

[Nom et fonction]
Telecom Universel, Ouagadougou
[Téléphone] · [Adresse]

*Pièce jointe : WAKATNET-questionnaire-cinetpay.docx*

---

## 3. YengaPay (Kreezus)

**Objet :** Intégration Mobile Money pour une plateforme burkinabè de WiFi Zones (micro-paiements de 100 FCFA)

Madame, Monsieur,

Telecom Universel, société basée à Ouagadougou, prépare le lancement de **WAKATNET**, une plateforme qui permet aux exploitants de WiFi Zones du Burkina Faso de vendre leurs forfaits de connexion directement depuis leur portail captif, payés par Mobile Money.

Nous serions heureux de travailler avec un acteur burkinabè, et votre API d'encaissement direct pour les portefeuilles du Burkina nous intéresse. Notre cas d'usage a trois particularités :

1. **Des micro-paiements** : le forfait le plus vendu coûte **100 FCFA**.
2. **Un client sans Internet** : l'acheteur est sur un Wi-Fi qui ne l'a pas encore authentifié. Le paiement doit se faire **sans redirection**, par un appel de serveur à serveur.
3. **Plusieurs exploitants** : au départ, chaque exploitant encaisse sur son propre compte marchand ; notre cible est un **partage automatique** de chaque paiement entre l'exploitant et la plateforme.

Les réponses qui nous permettront de décider rapidement sont les suivantes :

- Quel est le **montant minimum** réel par opérateur ? Un paiement de **100 FCFA** est-il possible sur Orange Money ? (L'exemple de votre SDK mentionne 200 FCFA.)
- Pouvez-vous confirmer par écrit vos **frais** (2,5 % à l'encaissement, 1,5 % au transfert, sans frais fixe) et la règle d'arrondi ?
- Un projet peut-il représenter un **exploitant tiers**, avec un reversement séparé ou un partage automatique ? Sous quel **agrément BCEAO** opérez-vous, directement ou par un partenaire agréé ?
- Pouvez-vous nous ouvrir un accès à votre **environnement de test** ?

Vous trouverez en pièce jointe notre questionnaire complet (questions numérotées, avec un ordre de priorité à la question 40). Nous vous serions reconnaissants d'y répondre par écrit, en joignant les liens vers votre documentation et vos conditions tarifaires.

Nous restons à votre disposition pour une rencontre à Ouagadougou.

Veuillez agréer, Madame, Monsieur, nos salutations distinguées.

[Nom et fonction]
Telecom Universel, Ouagadougou
[Téléphone] · [Adresse]

*Pièce jointe : WAKATNET-questionnaire-yengapay.docx*
