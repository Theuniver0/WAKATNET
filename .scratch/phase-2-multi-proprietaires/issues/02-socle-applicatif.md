# 02 — Socle applicatif, RLS et tests d'isolement

**PRD** : `../PRD.md` · **Matrice** : T6 (côté API), I1, I2 · **Dépend de** : 01

## À livrer
- Espace de travail npm à la racine, `apps/api` (Fastify 5, TypeScript exécuté par Node 22 sans compilation, Prisma 7 avec l'adaptateur `pg`).
- `apps/api/prisma/schema.prisma` repris de la base (`prisma db pull`) ; migration de base marquée appliquée ; `infra/sql/app/` gelé.
- Migration SQL `0013` : rôle `wk_api`, RLS sur `site`, `router`, `plan`, `voucher`, `audit_log`, `enrollment_token`.
- Route `GET /v1/sites` et `GET /v1/routers` pour prouver l'isolement.
- Pile de test de l'API (`apps/api/tests/`), PostgreSQL neuf, une commande.

## Critères d'acceptation
- Le propriétaire A ne voit **aucune** ligne de B, même par une requête SQL directe sous `wk_api` sans contexte (zéro ligne, pas d'erreur silencieuse).
- `wk_api` ne peut ni lire `radius.router_secret` ni exécuter `radius.authorize`.
- La matrice T (phase 1) reste verte : les fonctions `radius.*` ne sont pas soumises à la RLS.
