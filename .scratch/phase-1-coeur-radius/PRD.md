# PRD — Phase 1 : cœur RADIUS (un seul propriétaire)

- **Statut** : proposé le 11/11/2026, à valider par Yacouba (validation en bloc avec les tickets).
- **Références** : `docs/SPEC.md` §4 (règles 1, 2 et 5), §5 (logique d'accès), §5.6 (matrice T), §9, §12 (phase 1), §13 ; ADR 0001 à 0005 ; `docs/LABO.md` (E-FR-1, E-FR-2, L1–L6) ; `CONTRIBUTING.md` (C1–C7).

## 1. Problème

Un propriétaire doit pouvoir vendre des tickets dont la validité, la durée, le volume et le nombre d'appareils sont contrôlés en temps réel par un serveur RADIUS fiable. Les tickets déjà vendus doivent continuer de s'authentifier même quand l'API, le worker ou l'agrégateur sont tombés.

## 2. Résultat attendu

En fin de phase, sur la pile de dev (`infra/docker-compose.yml`) puis rejouable sur un nœud Debian :
- FreeRADIUS 3.2.10 authentifie des tickets à partir des seules fonctions SQL `radius.*` ;
- l'accounting passe par un fichier `detail` et est rejoué vers PostgreSQL sans bloquer l'authentification ;
- la plateforme peut couper une session ou en changer le débit par Disconnect / CoA ;
- la matrice T1–T12 est automatisée et verte, sauf T6 (phase 2) et T9 (CHR, piste B). T13 relève de la phase 5.

## 3. Périmètre

**Dedans** :
- un seul propriétaire, plusieurs routeurs ;
- clients dynamiques sur l'overlay `10.213.0.0/16`, avec un secret propre à chaque routeur et le Message-Authenticator exigé (E-FR-2) ;
- forfaits avec toutes leurs dimensions (§5.3) et copie figée sur le ticket ;
- refus codés (§5.2), accounting idempotent, appareils simultanés, sessions fantômes, anti-devinette ;
- comportement quand la base est arrêtée ;
- émission de CoA / Disconnect ;
- mesure de performance.

**Dehors** :
- plusieurs propriétaires et RLS (phase 2) ;
- WireGuard et enrôlement (phase 2) ;
- API, portail et paiement (phase 3) ;
- réplication (phase 5) ;
- RouterOS 6 (phase 2b).

## 4. Architecture retenue (rappel de la spec, sans nouvelle décision)

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

- **Instant de référence** : `now()` de PostgreSQL en production (règle 5). La façon de l'injecter en test est tranchée par le ticket 01.
- **Rôles PostgreSQL** :
  - `wk_radius` (FreeRADIUS) : EXECUTE sur `radius.*`, rien d'autre (C7) ;
  - `wk_acct` (lecteur `detail`) : EXECUTE sur `radius.acct_*` seulement.
- **Codes de ticket** : 8 caractères au moins, dans un alphabet de 32 symboles sans 0/O ni 1/I/L (§5.5) ; uniques par propriétaire.

## 5. Questions ouvertes, tranchées par les tickets

| Question | Ticket |
|---|---|
| Outil de migration SQL, et place des tables `app` avant Prisma | 01 |
| Injection de l'instant de référence en test : 3 formes comparées | 01 |
| Sens entrée / sortie des octets de l'accounting MikroTik ([LABO]) | 04 : les deux sens sont paramétrables ; la valeur par défaut sera confirmée sur CHR |
| `Mikrotik-Total-Limit` ([LABO]) | 05 : on n'en dépend pas ; contrôle du volume côté serveur, puis coupure par Disconnect |
| Variante « base arrêtée » : Reject ou silence | 08 : ADR, à confirmer avec LABO-16 |

## 6. Critères de fin de phase (§12)

1. La matrice T1–T5, T7, T8, T10–T12 tourne en une commande (`radius/tests/run.sh`) contre la pile de dev, et elle est verte.
2. Sur CHR (piste B, Yacouba) : connexion par ticket, coupure à l'échéance, Disconnect (T9). La partie serveur est prête ici.
3. Rapport de performance : p95 de `authorize` côté serveur, et authentifications par seconde.
4. Revue en deux axes, Standards (`CONTRIBUTING.md`) et Spec (ce PRD et `docs/SPEC.md`), sans réserve.
5. Étiquette Git `phase-1`, avec une entrée dans `docs/JOURNAL.md`.

## 7. Ordre et dépendances

01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10. Les tickets passent l'un après l'autre : ils touchent tous le chemin critique (règle 3 : un seul changement à la fois). Une branche `ticket/NN-titre` et une PR par ticket.
