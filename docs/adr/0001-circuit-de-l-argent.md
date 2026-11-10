# ADR 0001 — Circuit de l'argent (décision D1)

- **Statut** : accepté par Yacouba le 10/11/2026, à la porte G0 (séance de questions une par une). Révisable quand les agrégateurs auront répondu au questionnaire.
- **Références** : `docs/SPEC.md` §1.4, §3 (D1, D4), §8.2, §8.3, §11 ; `docs/G0.md` ; `docs/PAYMENT_PROVIDERS.md` ; `docs/CONFORMITE.md`.

## Contexte

La spec prévoit trois circuits :
- **A — encaissement direct** : chaque propriétaire a son propre compte marchand ;
- **B — collecte centralisée** : l'argent passe par Telecom Universel, qui le reverse ;
- **C — répartition par le prestataire agréé** : sous-marchands ou partage natif du paiement.

Constats de la phase 0, tous **non vérifiés dans une doc officielle lue en entier** :
- aucun agrégateur n'a confirmé par écrit l'encaissement pour compte de tiers ;
- des CGU vues en extrait (pawaPay, FedaPay) l'interdisent sans accord écrit ;
- seules deux entités sont signalées comme établissements de paiement agréés au Burkina : InTouch Burkina et Kerry Payments Burkina.

Le mode B ressemble à un service de paiement réglementé. C'est une lecture d'ingénieur, pas un avis juridique.

Le pilote (phase 6) commence sur un site de Telecom Universel. Là, Telecom Universel est lui-même propriétaire : le mode A n'y pose aucune question réglementaire.

## Décisions

1. **Lancement en mode A**, d'abord sur les sites de Telecom Universel.
2. **Le mode C devient la cible prioritaire pour les propriétaires tiers.** Il passe de « ticket R&D » à « priorité ». Il est la première question du questionnaire aux agrégateurs : sous-comptes marchands ou répartition automatique (Q27), encaissement pour tiers (Q28).
3. **Le mode B reste verrouillé en production**, comme le prévoit la spec : pas d'activation sans l'accord écrit de l'agrégateur et sans avis juridique consignés dans `docs/CONFORMITE.md`.
4. **Commission en mode A** :
   - pourcentage sur chaque ticket vendu (`commission_bps`, défaut 1000, voir D3) ;
   - débitée à chaque vente d'un **solde de crédits prépayés** ;
   - **découvert plafonné** autorisé ;
   - quand le plafond est atteint, la **vente en ligne** est suspendue ; les tickets déjà vendus restent valides et l'authentification n'est jamais touchée.
   - La valeur initiale du plafond (valeur fixe pour un nouveau propriétaire, puis environ 3 jours de commission moyenne) reste à fixer : paramètre par propriétaire, défaut à proposer par un ticket.
5. **Accès ouvert** : tout détenteur de WiFi Zone peut créer un compte, ajouter ses routeurs et gérer ses forfaits et débits comme il l'entend, **sans compte marchand**. Tout est disponible sauf la vente en ligne : routeurs, forfaits, débits, tickets papier, suivi. En mode A, la vente en ligne s'active quand le propriétaire branche son propre compte marchand (clés chiffrées au repos, §8.2). Ce n'est pas un choix mais une conséquence du mode A : l'argent du client doit arriver sur un compte.

## Conséquences

- **D4 devient urgent.** Un propriétaire qui ne vend qu'en tickets papier ne paie aucune commission tant que `offline_fee_bps` vaut 0. Sans règle, l'accès ouvert permet d'utiliser la plateforme gratuitement.
- **Grand livre.** Le mode A demande les comptes de crédits du propriétaire (rechargement, débit de commission, découvert). Les invariants du §8.4 s'appliquent : un découvert est un solde négatif borné, jamais une écriture modifiée.
- **Modèle de données.** `tenant` porte `settlement_mode` (A/B/C ; C prévu, non codé en v1), le plafond de découvert et l'état « vente en ligne suspendue ». `credit_topup` existe déjà au §9.
- **Commercial.** Les concurrents à 10 % pratiquent probablement la collecte centralisée (hypothèse non vérifiée). WAKATNET y gagne un argument : « votre argent ne passe jamais par nous ». Il y perd en friction : compte marchand et crédits à recharger.

## Risque résiduel

Si aucun agrégateur ne propose le mode C et que les petits propriétaires ne peuvent pas ouvrir de compte marchand, la vente en ligne pour les tiers ne restera possible que par le mode B, avec un agrément ou un partenaire agréé. Ce scénario se décidera après les réponses écrites au questionnaire.
