# 04 — Confirmation d'une vente, crédits du mode A, frais papier

**Dépend de** : 03 · **ADR** : 0001, 0002 · **Règle** : A7

## À livrer
- `app.paiement_confirmer` : statut, ticket, lien paiement ↔ ticket et commission dans une seule transaction.
- Rechargement des crédits par le super-admin, découvert plafonné (3 000 F par défaut), suspension de la vente en ligne au plafond.
- Frais papier à l'activation, par une tâche hors du chemin d'authentification ; un seul frais par ticket.

## Critères d'acceptation
- Invariants du §7.2 : jamais de ticket sans paiement confirmé, jamais de paiement confirmé sans ticket.
- Un propriétaire au plafond garde des tickets authentifiés, mais sa vente en ligne est refusée. Ce test de bout en bout est dû depuis le ticket 1.2.
- Tests de propriétés sur le solde : solde = rechargements − commissions − frais.
