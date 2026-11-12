# PRD — Phase 2 : multi-propriétaires et enrôlement

- **Statut** : rédigé le 12/11/2026 par l'agent. **Validé en bloc par délégation** : Yacouba a demandé de « finir le travail » sans question ni essai intermédiaire (12/11/2026). Il fera tous les essais sur routeur à la fin (voir §6).
- **Références** : `docs/SPEC.md` §4 (règles 1 et 4), §6 (overlay et enrôlement), §9, §10.1, §12 (phase 2), §13 ; `docs/PLAN.md` (lignes 2.0 à 2.6) ; ADR 0003, 0006, 0008 ; `CONTRIBUTING.md` (C1–C7, I1–I2, S1–S3, R1–R8).

## 1. Problème

En phase 1, un routeur n'existe que si quelqu'un l'insère à la main dans la base, avec son secret et son adresse dans le tunnel. Il n'y a ni tunnel réel, ni API, ni cloisonnement entre propriétaires au-delà des fonctions SQL. Un propriétaire ne peut donc pas raccorder un routeur seul, et deux propriétaires ne peuvent pas cohabiter sans risque.

## 2. Résultat attendu

En fin de phase, dans le dépôt :
- un propriétaire obtient une **commande d'enrôlement** valable 30 minutes et à usage unique ; collée dans le terminal RouterOS, elle crée le tunnel, s'enregistre auprès de l'API, puis reçoit et applique sa configuration ;
- le nœud tient ses pairs WireGuard alignés sur la base (`wg-agent`), sans redémarrer l'interface, et le pare-feu du nœud interdit tout trafic entre deux routeurs ;
- un routeur **révoqué** perd son pair WireGuard immédiatement et n'est plus reconnu par FreeRADIUS ;
- l'API applique le cloisonnement par Row Level Security, prouvé par des tests d'isolement ;
- un propriétaire peut importer ses tickets Mikhmon non utilisés ;
- `wakatnet-uninstall.rsc` retire tout ce que l'enrôlement a posé.

## 3. Périmètre

**Dedans** :
- socle applicatif TypeScript (pile D10 : Node 22, Fastify, Prisma), reprise du schéma `app` par Prisma (ADR 0008) ;
- rôle PostgreSQL de l'API, RLS sur les tables métier de `app`, tests d'isolement ;
- API d'enrôlement (jeton, inscription du routeur, adresse dans le tunnel, secret RADIUS, script de configuration) ;
- générateur des scripts RouterOS v7 : `wakatnet-enroll.rsc` (étapes 1 et 2), `wakatnet-uninstall.rsc`, `login.html` minimal ;
- `wg-agent` et règles nftables du nœud ;
- révocation d'un routeur ;
- import de tickets Mikhmon (CSV).

**Dehors** :
- authentification des propriétaires et tableau de bord (phase 4). En phase 2, l'API reçoit l'identité du propriétaire par un en-tête de **développement**, refusé en production (voir ADR 0012) ;
- portail captif complet et paiement (phase 3). `login.html` se limite à la saisie d'un ticket ;
- second nœud réel et réplication (phase 5). Le contrat prévoit deux nœuds dès maintenant ;
- RouterOS 6 (phase 2b, ADR 0003) : il exige un choix de tunnel tranché sur CHR ;
- étape 3 de l'enrôlement, « entretien » par script planifié (§6.2) : ticket R&D, noté dans `docs/IDEES.md`.

## 4. Architecture retenue

```
Routeur (RouterOS ≥ 7.15)
  │ 1. /tool fetch https://api/enroll/JETON  → étape 1 (.rsc)
  │ 2. étape 1 : crée wg-wakatnet, génère sa clé, POST /enroll/JETON (clé publique, inventaire)
  │ 3. réponse : étape 2 (.rsc) → pairs, adresse, routes, /radius, pare-feu ; use-radius en dernier
  ▼
API (Fastify, rôle wk_api)
  │  app.enroll_register(...)  SECURITY DEFINER : jeton consommé, IP allouée, secret créé, en une transaction
  ▼
PostgreSQL ── NOTIFY wakatnet_pairs ──► wg-agent (Go, rôle wk_wg) ──► wg0 (pairs) 
                                         lecture : app.wg_pairs()
FreeRADIUS : client_lookup inchangé (routeur actif + secret) → le routeur enrôlé est reconnu.
```

- Le chemin critique ne change pas (C1) : `wg-agent` et l'API sont **hors** du chemin d'authentification. Si l'API tombe, les routeurs déjà enrôlés continuent d'authentifier. Si `wg-agent` tombe, les pairs existants restent en place : seuls les nouveaux enrôlements et les révocations attendent.
- Toute la logique sensible (jeton, allocation d'adresse, secret) vit dans des fonctions SQL appelées en une transaction, comme la décision d'accès en phase 1.

## 5. Décisions à prendre avant le code (ticket 01)

Liste dans `issues/01-contrats.md`. Elles sont consignées dans l'ADR 0012.

## 6. Critères de fin de phase (§12)

1. Tests verts en une commande : `radius/tests/run.sh` (matrice T, inchangée) et `apps/api` (tests HTTP et d'isolement), plus les tests de `wg-agent` sur des interfaces WireGuard réelles (espace utilisateur).
2. Scripts RouterOS générés et **audités** par le skill `mikrotik-routeros-config` (mode audit).
3. **Écart assumé avec R8 et la règle 6 du §13**, décidé par Yacouba le 12/11/2026 : les scripts ne sont **pas** exécutés sur CHR pendant la phase. Ce conteneur ne peut pas en faire tourner (pas de KVM, téléchargement MikroTik bloqué). Yacouba les exécutera à la fin, sur un CHR vierge et un CHR déjà configuré. **Tant que ce n'est pas fait, aucun script ne doit être lancé sur le routeur d'un tiers**, et l'étiquette `phase-2` n'est pas posée.
4. Revue en deux axes, Standards et Spec.

## 7. Ordre et dépendances

01 → 02 → 03 → 04 ; 05 après 02 ; 06 après 03 et 05 ; 07 après 02. Un seul ticket à la fois.
Livraison : une branche, un commit par ticket ; Yacouba pousse et fusionne.
