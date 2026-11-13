# Architecture de WAKATNET, telle que construite

- **Livrable** : SPEC §15, point 4. La revue Spec du 13/11/2026 l'a trouvé absent.
- **Cible** : SPEC §4. Ce document décrit **ce qui est construit** et renvoie à l'ADR de chaque écart.
- **En cas de désaccord** : la SPEC et les ADR font foi. Ce document les résume ; il ne décide rien.

## 1. Vue d'ensemble

```text
Client Wi-Fi ──► MikroTik du propriétaire (hotspot, RouterOS ≥ 7.15)
   │  walled garden : portail joignable avant connexion (IP dédiée, ADR 0023)
   │  WireGuard : un pair par nœud ; script planifié d'entretien toutes les 6 h (ADR 0023)
   ▼
┌──────────────── Nœud A (primaire) ────────────────┐   réplication   ┌──────── Nœud B (réplique) ────────┐
│ wg0 · FreeRADIUS · PostgreSQL 16 (app, radius,     │ ──────────────► │ wg0 · FreeRADIUS · PostgreSQL     │
│ ledger) · nginx · API Node (API, portail, tableau  │   en flux       │ (lecture seule, promotion à la    │
│ de bord, webhooks) · minuteries systemd ·          │                 │ main, ADR 0015) · nginx (certificat│
│ wg-agent · pgBackRest                              │                 │ auto-signé) · wg-agent            │
└───────────────┬────────────────────────────────────┘                 └───────────────────────────────────┘
                │ HTTPS sortant : agrégateurs (pawaPay, CinetPay), Brevo, stockage S3 (Backblaze B2)
```

## 2. Composants

| Composant | Ce qui est construit | Où | Décision |
|---|---|---|---|
| Authentification RADIUS | FreeRADIUS 3.2 (≥ 3.2.10, jamais 3.2.9) ; toute la décision d'accès est dans des fonctions SQL (`radius.authorize`, `radius.client_lookup`) | `infra/freeradius/`, `infra/sql/radius/` | ADR 0006, 0009 |
| Accounting | Découplé : fichier `detail`, puis lecteur vers le primaire, où qu'il soit | `infra/freeradius/`, `radius.acct_*` | ADR 0006, 0015 §2 |
| Base | PostgreSQL 16 ; schémas `app`, `radius` et `ledger` ; migrations SQL immuables, numérotées globalement ; RLS sur `app` | `infra/sql/` | ADR 0008 |
| Grand livre | En SQL (`ledger.ecrire`, `ledger.commission`), sans `UPDATE` ni `DELETE` ; tests de propriétés | `infra/sql/ledger/`, `apps/api/tests/` | ADR 0008, 0013 |
| API | Node 22 et Fastify, en TypeScript exécuté nativement ; Prisma pour `app` ; routes de propriétaire, de super-admin, d'enrôlement, d'entretien et de webhooks | `apps/api/src/` | ADR 0012 à 0016 |
| Portail captif | Rendu serveur par l'API (`/p/…`), sans dépendance externe ; origine propre (`portail.`) | `apps/api/src/portail.ts` | ADR 0013 §9 et §10 |
| Tableau de bord | React, fichiers statiques servis par l'API, CSP stricte | `apps/dashboard/` | ADR 0014 §5 |
| Paiements | Interface `FournisseurPaiement` ; `MockProvider`, pawaPay v2, CinetPay v1 (production verrouillée) ; `verify()` fait foi | `packages/payments/` | ADR 0013, 0020, 0022 |
| Tâches de fond | **Minuteries systemd** au lieu d'un worker BullMQ et de Redis : paiements et frais papier (60 s), coupures CoA et Disconnect (30 s), sessions fantômes (60 s), purges (jour), santé (60 s), sauvegarde (nuit), essai de restauration (mois) | `infra/systemd/`, `apps/api/src/taches.ts` | ADR 0013 §6, 0015 |
| Overlay | WireGuard ; `wg-agent` (Go) aligne les pairs du nœud sur la base, sans redémarrer l'interface | `apps/wg-agent/` | ADR 0012 |
| Enrôlement | Étape 1 (script), étape 2 (configuration, walled garden, activation en dernier), étape 3 (entretien planifié), désinstallation | `apps/api/src/routeros.ts` | ADR 0012, 0023 |
| Frontal | nginx : filtrage par `Host`, limites par source, journaux sans jeton ; pare-feu public avec retour arrière programmé | `infra/ansible/roles/frontal`, `parefeu` | ADR 0016 |
| Exploitation | Ansible ; pgBackRest chiffré vers S3 verrouillé ; CI GitHub Actions | `infra/ansible/`, `infra/noeud/`, `.github/workflows/` | ADR 0015, 0018, 0021 |
| E-mail | Brevo (vérification de l'adresse, avis, alerte crédits bas) | `apps/api/src/courriel.ts` | ADR 0019 |

## 3. Les cinq règles du §4, et ce qui les tient

1. **Chemin critique court.** Routeur, WireGuard, FreeRADIUS, PostgreSQL local : ni Node ni HTTP sur ce chemin. Les tickets vendus s'authentifient même si l'API est arrêtée. Preuve : matrice T (`radius/tests/`), T13 sur la réplique.
2. **L'accounting ne bloque jamais l'authentification.** Fichier `detail` et lecteur découplé, preuves L1 à L6 (`docs/LABO.md`, ADR 0006).
3. **L'argent ne dépend jamais du navigateur.** Seul `verify()`, de serveur à serveur, fait passer un paiement à SUCCEEDED (`app.paiement_transition`) ; le webhook n'est qu'un déclencheur. Montant et devise doivent concorder, sinon MISMATCH (A8).
4. **Cloisonnement.** `tenant_id` partout, RLS (`app.tenant_courant()`), un rôle PostgreSQL par usage avec ses seules fonctions (`radius/tests/test_droits.py`), tests d'isolement.
5. **Une seule horloge.** `now()` de PostgreSQL ; l'heure du routeur n'est jamais utilisée.

## 4. Écarts avec le §4 et le §15

| Prévu | Construit | Pourquoi |
|---|---|---|
| `apps/worker` (BullMQ, Redis) | minuteries systemd | moins de pièces ; une file n'apportait rien à ces volumes (ADR 0013 §6) |
| `apps/portal` | portail servi par l'API | même base, même code d'argent ; origine propre par nginx (ADR 0013 §9, 0016) |
| `packages/ledger/` | grand livre en SQL | invariants tenus par la base (ADR 0008) |
| `routeros/` | `apps/api/src/routeros.ts` | scripts générés par l'API, valeurs validées à la génération (ADR 0012) |
| Table `session` partitionnée (§9) | non partitionnée | reporté tant que le volume ne l'exige pas (ADR 0008 §2) |
| RouterOS 6 (phase 2b) | non codé | condition de G-PILOTE (`docs/PLAN.md`, `docs/PILOTE.md`) |
| Mode B (§8.3) | verrouillé | garde-fous et plan comptable en attente (ADR 0001, 0014 §9) |
