# PRD — Phase 3 : portail captif et paiement (mode A)

- **Statut** : rédigé le 12/11/2026 par l'agent. **Validé par délégation** : Yacouba a demandé de « continuer avec la phase 3 », sans essai intermédiaire (12/11/2026).
- **Références** : `docs/SPEC.md` §4 (règles 1, 3 et 5), §7 (portail, parcours, `PaymentProvider`, matrice P), §8 (grand livre, mode A, invariants), §9, §10.1, §12 (phase 3), §13 (règle 4) ; ADR 0001, 0002, 0005 ; `docs/PAYMENT_PROVIDERS.md` §6 et §7 ; `CONTRIBUTING.md` (A1–A8).

## 1. Problème

Un client final ne peut pas encore acheter de forfait : il n'y a ni portail, ni paiement, ni grand livre. La plateforme ne perçoit donc aucune commission, et le propriétaire n'a pas de solde de crédits.

## 2. Résultat attendu

- Un client choisit un forfait sur le portail captif, paie par Orange Money (USSD + OTP) ou Moov Money (validation sur le téléphone), puis il est connecté **sans ressaisir de code**.
- Chaque vente en ligne confirmée crée, dans **une seule transaction SQL** :
  - le ticket ;
  - le lien entre le paiement et le ticket ;
  - le débit de la commission sur les crédits du propriétaire (mode A).
- Les tickets papier activés paient leur frais (ADR 0002) par une tâche hors du chemin d'authentification.
- La matrice P1 à P9 est verte contre un `MockProvider` scriptable. P10 (reversement) relève du mode B, verrouillé : il n'est pas testé ici.
- Le grand livre respecte les invariants du §8.4, prouvés par des tests de propriétés et relus par un second agent (règle 4).

## 3. Périmètre

**Dedans** :
- grand livre (`ledger`) en partie double et ajout seul, imposé par les droits ;
- `packages/payments` : interface, `MockProvider`, machine d'états du paiement ;
- webhooks (un point d'entrée par propriétaire), rapprochement par `verify()`, expiration ;
- crédits du mode A : rechargement par le super-admin, débit de la commission, découvert plafonné, suspension de la vente en ligne ;
- frais sur les tickets papier activés ;
- portail captif : pages rendues côté serveur, de moins de 100 Ko, sans dépendance externe ; récupération d'un paiement (jeton d'appareil, ou numéro et référence) ;
- clés du compte marchand du propriétaire, chiffrées au repos ;
- achat de bout en bout dans un navigateur sans interface, contre le `MockProvider`.

**Dehors** :
- le **vrai adaptateur** (ticket 08, **en attente**) : il exige les réponses des agrégateurs, leur documentation officielle et des clés de bac à sable. La spec interdit de deviner une API (§7.3) ;
- le mode B (verrouillé, ADR 0001), les reversements et P10 ;
- Wave sur le portail (`PAYMENT_PROVIDERS.md` §7) ;
- le rechargement en ligne des crédits par le propriétaire : en phase 3, c'est le super-admin qui enregistre un rechargement ;
- tableaux de bord et relevés (phase 4) ;
- installation de la page de redirection sur le routeur : la page et son générateur sont livrés, mais leur pose sur CHR reste dans la piste B.

## 4. Critères de fin de phase (§12)

1. P1 à P9 verts, en une commande.
2. Tests de propriétés du grand livre verts ; relecture par un second agent, constats traités.
3. Navigateur sans interface : achat, puis auto-connexion (redirection vers `link-login-only` avec le code), contre le `MockProvider` et un faux hotspot.
4. Matrice T toujours verte : le chemin critique n'a aucune dépendance nouvelle (C1).
5. **G-ARGENT n'est pas franchie** : il faut en plus le vrai adaptateur en bac à sable et `docs/CONFORMITE.md` rempli (piste B).

## 5. Ordre

01 → 02 → 03 → 04 → 05 → 06 → 07. Le ticket 08 attend la piste B.
