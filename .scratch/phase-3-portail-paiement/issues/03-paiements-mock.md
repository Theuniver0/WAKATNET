# 03 — Paiements, MockProvider, webhooks

**Dépend de** : 02 · **Matrice** : P1, P2, P4, P5, P9

## À livrer
- `packages/payments` : interface, `MockProvider` scriptable, normalisation des montants XOF (A8).
- Tables `app.payment` et `app.payment_event` (corps brut conservé, identifiant d'événement unique).
- `POST /v1/portail/...` (création, idempotente sur la soumission) et `POST /webhooks/{fournisseur}/{propriétaire}`.
- Machine d'états, transitions idempotentes.

## Critères d'acceptation
- P1 : le même webhook reçu 5 fois donne un ticket et un seul jeu d'écritures.
- P2 : un webhook arrivé avant la réponse de `charge()` est traité.
- P4 : un montant différent donne `MISMATCH`, sans ticket, avec une alerte.
- P5 : une signature invalide donne 401, sans effet.
- P9 : une double soumission donne un seul paiement.
