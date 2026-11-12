# 06 — Révocation d'un routeur

**PRD** : `../PRD.md` · **Dépend de** : 03, 05

## À livrer
- `POST /v1/routers/{id}/revoke` : `actif = false`, audit, `NOTIFY` ; les sessions ouvertes du routeur sont inscrites à couper.

## Critères d'acceptation
- Pair retiré de `wg0` en moins de 2 s (test `wg-agent`).
- `radius.client_lookup` ne rend plus le routeur ; FreeRADIUS cesse de répondre au plus tard à l'expiration du client dynamique (`lifetime`), prouvé par la matrice T existante (`test_clients.py`).
- Un propriétaire ne peut pas révoquer le routeur d'un autre (404).
