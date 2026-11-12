# 06 — Révocation d'un routeur

**PRD** : `../PRD.md` · **Dépend de** : 03, 05

## À livrer
- `POST /v1/routers/{id}/revoke` : `actif = false`, audit, `NOTIFY`.
- **[précisé à la réalisation, 12/11/2026]** Les sessions ouvertes ne sont **pas** inscrites à couper : le pair est retiré en quelques dizaines de millisecondes, donc un Disconnect ne joindrait plus le routeur. Comme aucun Interim n'arrive plus, ces sessions sont fermées comme sessions fantômes (ADR 0006 §8), au bout de 3 intervalles Interim. La révocation est définitive : le routeur revient par désinstallation puis nouvel enrôlement, avec une nouvelle clé et une nouvelle adresse.

## Critères d'acceptation
- Pair retiré de `wg0` en moins de 2 s (test `wg-agent`).
- `radius.client_lookup` ne rend plus le routeur ; FreeRADIUS cesse de répondre au plus tard à l'expiration du client dynamique (`lifetime`), prouvé par la matrice T existante (`test_clients.py`).
- Un propriétaire ne peut pas révoquer le routeur d'un autre (404).
