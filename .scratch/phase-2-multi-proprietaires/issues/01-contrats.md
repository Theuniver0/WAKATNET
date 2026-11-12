# 01 — Contrats de la phase 2 (ADR 0012)

**PRD** : `../PRD.md` · **Dépend de** : phase 1

## À livrer
`docs/adr/0012-contrats-phase-2.md`, qui tranche :
1. Langage et API de `wg-agent` (§14.4 : trois formes comparées) ; rôle PostgreSQL et fonction de lecture des pairs ; garde contre un effacement massif.
2. Plan d'adressage de l'overlay : plages réservées, allocation.
3. Jeton d'enrôlement : forme, stockage, durée, usage unique, séquence GET puis POST.
4. Contrat HTTP de l'enrôlement (OpenAPI 3.1 dans `apps/api/openapi.yaml`).
5. Reprise du schéma `app` par Prisma : procédure, et ce qui reste en SQL.
6. RLS : rôle de l'API, variable de contexte, tables couvertes, interaction avec les fonctions `radius.*`.
7. Identité du propriétaire dans l'API avant la phase 4.
8. Pare-feu du nœud (nftables).
9. Import Mikhmon : format accepté, codes non conformes.

## Critères d'acceptation
- ADR accepté (par délégation, voir PRD).
