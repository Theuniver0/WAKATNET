# PRD — Phase 1 : cœur RADIUS (un seul propriétaire)

- **Statut** : proposé le 11/11/2026, révisé le même jour après deux relectures adversariales (conformité à la spec ; testabilité et sécurité). À valider par Yacouba, en bloc avec les tickets.
- **Références** : `docs/SPEC.md` §4 (règles 1, 2 et 5), §5 (logique d'accès), §5.6 (matrice T), §9, §12 (phase 1), §13 ; ADR 0001 à 0005 ; `docs/LABO.md` (E-FR-1, E-FR-2, L1–L6) ; `CONTRIBUTING.md` (C1–C7).

## 1. Problème

Un propriétaire doit pouvoir vendre des tickets dont la validité, la durée, le volume et le nombre d'appareils sont contrôlés en temps réel par un serveur RADIUS fiable. Les tickets déjà vendus doivent continuer de s'authentifier même quand l'API, le worker ou l'agrégateur sont tombés.

## 2. Résultat attendu

En fin de phase, sur la pile de dev (`infra/docker-compose.yml`). Le rejeu sur un nœud Debian relève de la phase 5 :
- FreeRADIUS 3.2.10 authentifie des tickets à partir des seules fonctions SQL `radius.*` ;
- l'accounting passe par un fichier `detail` et est rejoué vers PostgreSQL sans bloquer l'authentification ;
- la plateforme peut couper une session ou en changer le débit par Disconnect / CoA ;
- la matrice T1–T12 est automatisée et verte. T6 est testé en SQL avec deux propriétaires (sans RLS ni enrôlement, qui restent en phase 2). La partie routeur de T9 se fait sur CHR (piste B). T13 relève de la phase 5, mais la phase 1 ne doit rien construire qui l'empêche (nœud B sur une réplique en lecture seule).

## 3. Périmètre

**Dedans** :
- un propriétaire, plusieurs sites et plusieurs routeurs, plus un second propriétaire dans les données de test, pour T6 ;
- clients dynamiques sur l'overlay `10.213.0.0/16`, avec un secret propre à chaque routeur et le Message-Authenticator exigé (E-FR-2) ;
- forfaits avec toutes leurs dimensions (§5.3) et copie figée sur le ticket ;
- refus codés (§5.2), accounting idempotent, appareils simultanés, sessions fantômes, anti-devinette ;
- comportement quand la base est arrêtée ;
- émission de CoA / Disconnect ;
- mesure de performance.

**Dehors** :
- cloisonnement applicatif complet : RLS et tests d'isolement de l'API (phase 2) ;
- WireGuard et enrôlement (phase 2) ;
- API, portail et paiement (phase 3) ;
- réplication (phase 5) ;
- RouterOS 6 (phase 2b).

## 4. Architecture retenue

```
radclient / routeur ──UDP 1812/1813──► FreeRADIUS 3.2.10
                                         │  authorize : SELECT radius.authorize(...)   (rôle wk_radius, EXECUTE seul)
                                         │  post-auth : radius.post_auth(...)
                                         │  accounting : fichier detail uniquement
                                         ▼
                                       PostgreSQL 16 (schémas app, radius)
                                         ▲
                     lecteur detail ─────┘  radius.acct_start / acct_interim / acct_stop / acct_on_off
```

- **Instant de référence pour la décision d'accès** : `now()` de PostgreSQL (règle 5). Pour les événements d'accounting rejoués depuis `detail` : instant de **réception** par FreeRADIUS, horloge du nœud, qui est la même machine que la base. On n'utilise jamais l'heure du rejeu ni l'`Event-Timestamp` du routeur. À trancher au ticket 01 (ADR 0006), avec la précision à apporter à la règle C4.
- **Rien sur le chemin d'authentification ne peut transformer un Accept en Reject à cause d'une écriture** : l'échec de `post_auth` est sans effet sur la réponse. L'authentification doit marcher sur une base en **lecture seule** (réplique du nœud B, T13).
- **Rôles PostgreSQL** (C7), chacun avec EXECUTE sur ses seules fonctions `SECURITY DEFINER` à `search_path` fixé :
  - `wk_radius` (FreeRADIUS, authentification) ;
  - `wk_acct` (lecteur `detail`) ;
  - `wk_coa` (émetteur de CoA, seul autorisé à lire le secret d'un routeur par son identifiant) ;
  - `wk_maint` (tâches planifiées : sessions fantômes, purges).
- **Codes de ticket** : 8 caractères au moins, dans un alphabet de 32 symboles sans 0/O ni 1/I/L (§5.5), tirés par un **générateur cryptographique** ; uniques par propriétaire ; jamais écrits en clair dans `auth_log` ni dans les journaux de FreeRADIUS.

## 5. Décisions à prendre avant le code (ticket 01)

Toutes les décisions d'architecture de la phase sont prises au ticket 01, et non dans les tickets de code (§14.3, P4). Leur liste est dans `issues/01-contrats.md`.

Points de labo nouveaux, ajoutés à la piste B :
- **LABO-18** : `Acct-Session-Id` est-il réutilisé par RouterOS après un redémarrage ?
- **LABO-19** : `Acct-Interim-Interval` envoyé dans l'Accept est-il pris en compte ?

## 6. Critères de fin de phase (§12)

1. La matrice T1–T8, T10–T12 et la partie serveur de T9 tournent en une commande (`radius/tests/run.sh`) contre la pile de dev, et elles sont vertes. `run.sh` repart d'une pile neuve et vérifie la version de FreeRADIUS (≥ 3.2.10, jamais 3.2.9).
2. Sur CHR (piste B, Yacouba) : connexion par ticket sur 7.15 et sur la stable courante (ticket 02), coupure au `Session-Timeout` (ticket 05), Disconnect (ticket 09), LABO-09, LABO-16, LABO-18 et LABO-19.
3. Rapport de performance : p95 de `authorize` côté serveur, et authentifications par seconde.
4. Revue en deux axes, Standards (`CONTRIBUTING.md`) et Spec (ce PRD et `docs/SPEC.md`), sans réserve.
5. Étiquette Git `phase-1`, avec une entrée dans `docs/JOURNAL.md`.

## 7. Ordre, dépendances et livraison

- Ordre : 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 ; le ticket 10 suit 07 (il mesure `post_auth` et `auth_log`) et peut passer avant 08 et 09.
- Un seul ticket à la fois, parce que tous touchent le chemin critique (règle 3).
- Livraison décidée par Yacouba le 11/11/2026 : une branche et une PR par ticket ; Yacouba fusionne.
- Un commit qui touche à la fois `infra/freeradius/` et `infra/sql/radius/` justifie ce couplage dans son message (C6).
- Correspondance avec `docs/PLAN.md` : le ticket NN correspond à la ligne 1.(NN − 1).
