# Rapport de charge — phase 5

- **Date** : 12/11/2026. **Ticket** : `.scratch/phase-5-haute-disponibilite/issues/07-charge.md`.
- **Complète** `radius/tests/perf/RAPPORT.md` (phase 1, ticket 10 : un seul nœud, 200 auth/s sans perte sur 3 vCPU, p95 d'`authorize` de 1,7 ms côté serveur, plafond entre 400 et 800 auth/s).
- Tous les chiffres sont **mesurés** ; ce qui ne l'est pas est dit.

## 1. Matériel et méthode

- **Machine** : 4 vCPU Intel Xeon à 2,10 GHz, 16 Go, Docker 29.9.2. C'est un conteneur de session cloud, **pas un nœud de production**.
- **RADIUS** :
  - `radius/tests/perf/perf.sh`, phase `ha` (`PHASES=ha`) ;
  - A et B sur le même hôte, cœurs 0 à 2 partagés, le générateur sur le cœur 3 ;
  - configuration de production, durée de vie des clients de 300 s ;
  - jeu de données de la phase 1 : 50 routeurs, 100 000 tickets, 1 000 sessions, 1,35 million de lignes d'`auth_log` ;
  - résultats bruts dans `radius/tests/perf/resultats/2026-11-12-phase5-ha/`.
- **HTTP** :
  - `apps/api/tests/charge.sh` ;
  - l'API de production (`src/serveur.ts`) tourne dans son propre processus, avec le journal d'accès actif, le générateur dans un autre ;
  - PostgreSQL 16.15 dans un conteneur ; MockProvider (aucun argent réel) ;
  - résultats bruts dans `apps/api/tests/charge/resultats-2026-11-12.txt`.

## 2. RADIUS sur deux nœuds

| Situation | Débit visé | Obtenu | Perdus | p50 / p95 / p99 (ms, vus du routeur) |
|---|---|---|---|---|
| A, réplication en flux vers B | 200/s | 199,9/s | 0 | 3,1 / 4,5 / 6,9 |
| B seul, PostgreSQL de A arrêté (T13), sur sa réplique | 200/s | 199,9/s | 0 | 2,3 / 3,3 / 4,5 |
| B seul, idem | 400/s | 399,9/s | 0 | 2,0 / 2,8 / 4,1 |

- **Retard de réplication** pendant 20 s à 200 auth/s (chaque Accept écrit dans `auth_log` par `post_auth`) : **8 ms au plus**, et 7 712 octets de WAL au plus en attente, sur 22 relevés (un par seconde).
- **Copie de base** de la réplique (base de 349 Mo) : réplique prête en 3 s, sur le même hôte. Sur deux hébergeurs, la copie passera par Internet : non mesurée.
- **B en mode dégradé** est un peu plus rapide que A : `post_auth` n'y écrit rien (ADR 0015 §2). C'est le comportement voulu, pas un gain à exploiter.
- 2 refus `trop_d_appareils` par mesure : artefact du jeu de données, déjà expliqué dans `RAPPORT.md` §3.

## 3. HTTP : portail et paiement

Concurrence 20, 20 s par palier.

| Palier | Débit | Erreurs | p50 / p95 / p99 (ms) |
|---|---|---|---|
| `GET /p/:site` (accueil du portail) | 2 170/s | 0 | 8,2 / 17 / 24,6 |
| `GET /p/:site/forfaits` | 1 715/s | 0 | 11 / 18,8 / 23,5 |
| `POST /p/:site/payer`, 300 sites, débit fixe de 100/s | 100/s (2 001 achats) | 0 | 9 / 12,5 / 17 |
| `POST /p/:site/payer`, un seul site, concurrence pleine | 950/s | — | 20,1 / 32 / 40,1 |

- **Les 2 001 paiements** créés à débit fixe sont tous passés à `SUCCEEDED` par leur webhook signé. Aucune erreur interne n'a été journalisée par l'API.
- **Un seul site sous rafale** : 31 achats acceptés, puis 18 973 refus 429 rapides (p95 de 32 ms). C'est la garde anti-abus de 30 créations par minute et par site (migration 0022). La capacité du portail se compte donc par site, et sur le parc.

## 4. Lecture

- Les objectifs du §5.6 (200 auth/s, p95 d'`authorize` < 50 ms) tiennent sur A pendant la réplication, et sur B en mode dégradé, jusqu'à 400 auth/s mesurés.
- Le portail sert plus de 2 000 pages par seconde sur un cœur Node. Un parc de 1 000 sites qui vendrait chacun un ticket par minute représente environ 17 achats par seconde, très loin de ces chiffres.

## 5. Limites, non mesuré

- **Une seule machine** : A, B et le générateur partagent l'hôte. La latence réseau entre deux hébergeurs, et entre le Burkina et l'Europe (LABO-17), n'entre dans aucun de ces chiffres.
- **Le retard de réplication à travers Internet** (WireGuard entre deux hébergeurs) reste à mesurer sur les nœuds réels. Le collecteur de santé le relève chaque minute (`replication_retard_s`).
- **Le fournisseur réel de paiement** n'est pas mesuré (MockProvider) : son délai dominera la durée d'un achat.
- **Le tableau de bord** n'est pas mesuré sous charge : c'est un usage de propriétaires, peu fréquent.
