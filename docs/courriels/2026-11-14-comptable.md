# Dossier pour le comptable — 14/11/2026

> **Pour Yacouba, avant l'envoi.** Ce dossier n'est ni un avis fiscal ni un avis comptable : il prépare les questions. Il alimente `docs/CONFORMITE.md` §9, les durées de T2, T5 et T8 au §7, et la case « §9 » du §12. Ordre d'envoi et suivi : `docs/courriels/2026-11-14-LISEZMOI.md`.
>
> - **Destinataire** : le comptable de Telecom Universel (SPEC §8.5), ou un expert-comptable exerçant au Burkina Faso. Nom : [nom]. Adresse : [adresse].
> - **À compléter** : forme juridique, RCCM, IFU et régime d'imposition actuel de Telecom Universel. Rien de tout cela n'est dans le dépôt.
> - **À demander** : une réponse écrite, question par question, avec les textes cités (titre, article ; références fiscales et SYSCOHADA). Ne pas reporter de règle sans sa référence.
> - **À joindre** : un exemple de facture mensuelle et de relevé, produits par la plateforme de démonstration (PDF « document provisoire », ADR 0014 §7). [À produire par Yacouba]

---

## 1. Lettre

**Objet :** Plateforme WAKATNET — facturation de la commission et traitement comptable des crédits prépayés

Madame, Monsieur,

Telecom Universel prépare le lancement de **WAKATNET**, une plateforme en ligne qui permet aux exploitants de WiFi Zones (les « propriétaires ») de vendre leurs forfaits de connexion par Orange Money et Moov Money.

Dans le circuit retenu pour le lancement, Telecom Universel ne reçoit jamais l'argent des ventes : il arrive sur le compte marchand de chaque propriétaire. Telecom Universel vend à chaque propriétaire des **crédits prépayés**, sur lesquels il débite une **commission** à chaque vente. Une facture de commission est émise chaque mois. Le schéma des flux figure au §2.

Avant d'encaisser le premier franc, nous avons besoin de votre avis écrit sur les questions du §3 : facture, TVA, imputation, conservation des pièces.

Nous vous remercions de nous indiquer vos honoraires et votre délai. Nous restons à votre disposition pour un entretien.

Veuillez agréer, Madame, Monsieur, nos salutations distinguées.

[Nom et fonction]
Telecom Universel, Ouagadougou
[Téléphone] · [Adresse]

---

## 2. Schéma des flux d'argent du mode A

Sources : SPEC §3 (D3, D4), §8.1, §8.2, §8.5 ; ADR 0001, 0002, 0013 §4 à §7, 0014 §7.

```text
(1) VENTE EN LIGNE D'UN FORFAIT (ex. 100 F)

    Client final ── 100 F (Orange Money / Moov Money) ──► Compte marchand DU PROPRIÉTAIRE
                                                          chez l'agrégateur
                                                          - l'agrégateur retient ses frais
                                                            (à la charge du propriétaire) ;
                                                          - il règle le solde au propriétaire.

    Telecom Universel ne reçoit rien de ces 100 F.

(2) RECHARGE DE CRÉDITS

    Propriétaire ── X F (Mobile Money) ──► Telecom Universel
    Grand livre : débit « trésorerie de la plateforme » / crédit « crédits du propriétaire ».

(3) COMMISSION, à chaque vente en ligne confirmée

    10 % du prix par défaut, arrondi au franc le plus proche (0,5 vers le haut) : 10 F sur 100 F.
    Grand livre : débit « crédits du propriétaire » / crédit « produit : commission ».

(4) FRAIS SUR TICKET PAPIER, à l'activation d'un ticket vendu en espèces

    Plus grand de 10 % du prix et de 10 F : 10 F sur 100 F, 30 F sur 300 F.
    Grand livre : débit « crédits du propriétaire » / crédit « produit : frais papier ».

(5) DÉCOUVERT

    Le solde de crédits peut devenir négatif, jusqu'à 3 000 F par défaut.
    Au-delà : vente en ligne suspendue ; les tickets déjà vendus restent valables.

(6) FIN DE MOIS

    Facture de commission : total des commissions et des frais papier du mois,
    une ligne par nature. Relevé par propriétaire (jour, mois), en CSV et PDF.
```

Points de fait utiles :
- Le grand livre est **en partie double et en ajout seul** : aucune écriture n'est modifiée ni supprimée ; une correction est une contre-écriture (SPEC §8.1 ; ADR 0013 §3).
- Montants en francs CFA entiers ; aucune décimale (SPEC §8.1).
- Le solde n'est jamais stocké : il se recalcule depuis les écritures (ADR 0013 §3).
- La facture porte aujourd'hui la mention « document provisoire ». Elle n'a pas de numérotation séquentielle : celle-ci attend votre règle (ADR 0014 §7).
- Le rechargement est aujourd'hui saisi à la main par Telecom Universel, avec sa référence (ADR 0013 §7). Le canal de paiement de la recharge n'est pas encore choisi : Wave est à l'étude (QUESTIONS_AGREGATEURS §3.7). [À CONFIRMER]
- Premier usage prévu : les sites de Telecom Universel, qui y est lui-même propriétaire (ADR 0001).
- Mode B (collecte centralisée par Telecom Universel, puis reversement) : bloqué en production. Question K16 seulement.

---

## 3. Questions

Chaque question renvoie à la case de `docs/CONFORMITE.md` qu'elle remplit.

### A. Statut de Telecom Universel

**K1.** Pour cette activité, quel est le régime d'imposition de Telecom Universel ([régime actuel à indiquer par Yacouba]) ? Est-il assujetti à la TVA ? Le lancement de WAKATNET change-t-il ce régime ou les déclarations à déposer ?
→ *CONFORMITE §9, ligne « Mentions obligatoires de la facture » (le régime y figure, ADR 0014 §7). Pas de ligne dédiée : voir le LISEZMOI.*

### B. Facture de la commission

**K2.** Quelles sont les mentions obligatoires d'une facture au Burkina Faso, pour la facture mensuelle de commission ? (Identité et IFU des deux parties, numérotation, date, désignation, montant hors taxes, taxes, montant TTC, autres mentions.)
→ *CONFORMITE §9, ligne « Mentions obligatoires de la facture mensuelle de commission ».*

**K3.** Quelle règle de numérotation faut-il : une suite continue pour toute la plateforme, ou une par propriétaire ? Une facture produite par la plateforme et envoyée en PDF est-elle valable ? Faut-il une forme normalisée imposée par l'administration fiscale ? [À CONFIRMER]
→ *CONFORMITE §9, ligne « Mentions obligatoires… ».*

**K4.** La commission sur les ventes en ligne et les frais sur tickets papier peuvent-ils figurer sur la même facture, en deux lignes ?
→ *CONFORMITE §9, ligne « Mentions obligatoires… ».*

**K5.** L'arrondi de la commission au franc le plus proche (0,5 au franc supérieur), calculé vente par vente, est-il acceptable fiscalement ? Faut-il plutôt calculer sur le total du mois ?
→ *CONFORMITE §9, ligne « Arrondi de la commission ».*

### C. TVA et autres taxes

**K6.** La commission de la plateforme est-elle soumise à la TVA ? À quel taux ? Les 10 % s'entendent-ils alors hors taxes ou toutes taxes comprises ?
→ *CONFORMITE §9, ligne « TVA applicable à la commission… ».*

**K7.** Pour la vente de crédits prépayés : la TVA est-elle exigible à la **recharge** ou à la **consommation** des crédits ?
→ *CONFORMITE §9, même ligne.*

**K8.** Les agrégateurs annoncent leurs frais hors taxes. Pour les paiements reçus par Telecom Universel (recharges de crédits ; ventes de ses propres sites), la TVA sur ces frais est-elle récupérable ?
→ *CONFORMITE §9, ligne « Frais d'agrégateur hors taxes… TVA récupérable ? ».*

**K9.** Une retenue à la source ou un autre prélèvement s'applique-t-il aux paiements faits par Telecom Universel à des prestataires établis hors du Burkina ? Sont concernés : les agrégateurs établis hors du pays, l'hébergeur des serveurs (Hetzner, Europe, ADR 0004), l'envoi d'e-mails (Brevo, France, ADR 0019), le stockage des sauvegardes (Backblaze, ADR 0018).
→ *CONFORMITE §9, ligne « Retenue à la source… prestataires étrangers ».*

### D. Recharges de crédits et imputation SYSCOHADA

**K10.** Quelle pièce Telecom Universel doit-il remettre au propriétaire à chaque recharge (reçu, facture d'acompte, facture) ?
→ *CONFORMITE §9, ligne « TVA applicable… à la vente de crédits prépayés ».*

**K11.** Comment imputer, en SYSCOHADA : le produit de commission ; le produit des frais papier ; les crédits prépayés non consommés (dette envers le propriétaire, produit constaté d'avance, autre) ; les frais d'agrégateur ?
→ *CONFORMITE §9, ligne « Imputation SYSCOHADA ».*

**K12.** Un solde de crédits **négatif** (découvert, jusqu'à 3 000 F par défaut) est une somme que le propriétaire doit à Telecom Universel. Comment la comptabiliser, et quand la tenir pour douteuse ?
→ *CONFORMITE §9, ligne « Imputation SYSCOHADA ».*

**K13.** À la fin d'un contrat, comment traiter les crédits non consommés, selon qu'ils sont remboursés ou non ? (La question de leur remboursement est posée à l'avocat, J8.)
→ *CONFORMITE §9, ligne « Imputation SYSCOHADA ».*

**K14.** Un client final est remboursé par le propriétaire (paiement débité sans ticket). La commission déjà débitée des crédits doit-elle être annulée ? Faut-il alors une facture d'avoir ?
→ *CONFORMITE §9, ligne « Mentions obligatoires… » et ligne « Imputation SYSCOHADA ».*

**K15.** Pendant le pilote, Telecom Universel vend sur ses propres sites, sur son propre compte marchand. La plateforme calcule pourtant une commission sur ces ventes. Faut-il la comptabiliser, ou seulement les ventes elles-mêmes ? Quelles pièces garder pour ces ventes (relevé de l'agrégateur, grand livre) ?
→ *CONFORMITE §9, ligne « Imputation SYSCOHADA ».*

**K16.** *(pour plus tard)* En mode B, comment imputer la dette envers les propriétaires et le compte de compensation chez l'agrégateur ?
→ *CONFORMITE §9, ligne « Mode B : imputation… ».*

### E. Relevés, archivage et durées de conservation

**K17.** Quelle est la durée légale de conservation des pièces comptables et des livres ?
→ *CONFORMITE §9, ligne « Durée légale de conservation des pièces comptables » ; §7, durées de T2, T5 et T8.*

**K18.** Quelles pièces de paiement faut-il archiver, et sous quelle forme ? Candidats : relevé du compte chez l'agrégateur, notification brute de chaque paiement, écritures du grand livre, factures et relevés de la plateforme. Un archivage purement électronique est-il admis ?
→ *CONFORMITE §9, ligne « Durée légale de conservation… » ; §7, durée de T2.*

**K19.** Pour la protection des données, le numéro de téléphone du payeur est effacé au bout de 6 mois ; il reste une empreinte et une forme masquée (`70 •• •• 12`) (CONFORMITE §7 bis). Les notifications brutes de l'agrégateur sont vidées au même terme. Une pièce de paiement ainsi réduite reste-t-elle une pièce justificative suffisante ? Sinon, quelles données faut-il garder, et combien de temps ?
→ *CONFORMITE §9, ligne « Durée légale de conservation… » ; §7 bis, paragraphe « Conflit à arbitrer ».*

**K20.** Le relevé par propriétaire produit par la plateforme (§8.5 de la spécification) peut-il servir de pièce justificative pour la comptabilité du propriétaire ? Quelles mentions doit-il porter pour cela ?
→ *CONFORMITE §9, ligne « Le relevé par propriétaire… pièce justificative ».*

---

## 4. Pièces à joindre

| # | Pièce | Source |
|---|---|---|
| 1 | Schéma des flux (§2 ci-dessus) | ce fichier |
| 2 | Exemple de facture mensuelle et de relevé, générés sur la plateforme de démonstration | [à produire par Yacouba] |
| 3 | Extraits de la spécification sur l'argent | `docs/SPEC.md` §8.1, §8.2, §8.5 |
| 4 | Décision sur les frais des tickets papier (tableau des montants) | `docs/adr/0002-frais-tickets-papier.md` |
| 5 | Statuts, RCCM, IFU et régime fiscal de Telecom Universel | [à fournir par Yacouba] |
| 6 | Grilles tarifaires écrites des agrégateurs, dès réception | dossier agrégateurs |
