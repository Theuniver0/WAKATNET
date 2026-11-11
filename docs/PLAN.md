# WAKATNET — Plan du reste du travail (phases 1 à 6)

## Contexte

La phase 0 est faite et fusionnée dans `main` : mise en place, labo FreeRADIUS serveur, pile de dev, matrice des agrégateurs, protocoles de labo, ADR 0001 à 0005 (D1, D4, D5, D6, D9), protocole de latence, courriels aux agrégateurs. Ce qui reste ouvert :
- **D2 / D3** : attendent les réponses écrites des agrégateurs ;
- **[LABO] RouterOS** : 0 sur 10 tranchés (pas de CHR dans le conteneur cloud) ;
- **G0** n'est pas formellement franchie.

Yacouba veut un plan complet de A à Z et répondre **une seule fois** à toutes les questions qui bloquent. Ce plan suit le §12 de la spec (phases 1 à 6, portes G0, G-ARGENT, G-PILOTE), en tranches verticales (§14.3) : chaque ticket traverse les couches et correspond, autant que possible, à une ligne des matrices T ou P.

Principe de découpage : **deux pistes en parallèle**.
- **Piste A (agent, dans le dépôt)** : tout ce qui se prouve dans un conteneur Linux (FreeRADIUS, PostgreSQL, Node, Docker, radclient).
- **Piste B (Yacouba, sur le terrain)** : tout ce qui exige un CHR, un vrai routeur, un téléphone, un agrégateur, un juriste ou un achat.

Chaque ticket de la piste A précise la preuve de la piste B qui le ferme, quand il y en a une.

---

## Réponses de Yacouba (11/11/2026, une seule fois)

1. **G0 franchie sous réserve.** La phase 1 démarre. D2 garde sa valeur par défaut jusqu'à la phase 3 ; D3 = 10 % ; chaque [LABO] RouterOS est rattaché à la porte qui en a besoin.
2. **Mode de travail.** Je rédige le PRD et les tickets de chaque phase, et **Yacouba les valide en bloc**. Ensuite je réalise chaque ticket moi-même, avec une branche et une PR par ticket ; Yacouba fusionne. Relecture par un second agent. Aucun sous-agent ne réalise de code sur le chemin critique ni sur l'argent.
3. **Valeurs par défaut acceptées :**
   - 300 connexions par jour et par routeur ;
   - W = 5 s ;
   - seuils du §7 du protocole de latence ;
   - plafond de découvert initial : 3 000 F ;
   - arbitrage en cas d'objectif 99,9 % manqué : Yacouba ;
   - captures de latence archivées hors dépôt (Google Drive).
4. **Charge à 12 mois : moins de 50 routeurs au début.**
   - Dimensionnement : deux petits VPS (2 vCPU suffisent probablement ; c'est la mesure de la phase 5 qui tranche).
   - Pas de partitionnement de `session` en phase 1 : le schéma le prévoit (§9), il sera activé plus tard.
   - Les objectifs de performance de la spec (p95 < 50 ms, 200 auth/s) restent mesurés au ticket 1.9, puisque ce sont des seuils de la spec et non des besoins de dimensionnement.

## Premières actions après approbation

1. Consigner G0 dans `docs/G0.md`, `docs/JOURNAL.md` et `CONTEXT.md` (glossaire initial) ; poser l'étiquette Git `g0`.
2. Rédiger `.scratch/phase-1-coeur-radius/PRD.md` et les tickets 1.0 à 1.9 (`issues/NN-titre.md`), puis les soumettre à Yacouba pour une validation en bloc.
3. Après validation : ticket 1.0 (ADR des contrats), puis 1.1 (T2 de bout en bout), et la suite dans l'ordre.

---

## Porte G0 (actée sous réserve)

- D1, D4, D5, D6, D9 : tranchées (ADR 0001 à 0005).
- D2 : défaut de la spec maintenu (`PaymentProvider` + `MockProvider`) ; le vrai adaptateur reste en phase 3 et attend les réponses.
- D3 : 10 % (cohérent avec ADR 0002).
- [LABO] RouterOS : menés **en parallèle** par Yacouba ; chacun est rattaché à la porte qui en a besoin (voir piste B).
- → **Proposition : G0 franchie sous réserve**, ce qui ouvre la phase 1. Étiquette Git `g0`.

---

## Phase 1 — Cœur RADIUS (un propriétaire ; un second dans les données de test pour T6)

Détail : `.scratch/phase-1-coeur-radius/` (PRD et tickets 01 à 10, où le ticket NN correspond à la ligne 1.(NN − 1)).

Fichiers principaux : `infra/sql/radius/` (migrations SQL versionnées), `infra/freeradius/` (configuration de production), `radius/tests/` (matrice T automatisée). Pile de test : la pile de dev existante `infra/docker-compose.yml` (FreeRADIUS 3.2.10, PostgreSQL 16.15). On réutilise les acquis du labo `infra/lab/freeradius/` : `client_lookup` SQL, rôle EXECUTE seul, `&FreeRADIUS-Client-Require-MA`, `radreq.py` pour T10, lecteur `detail`.

| Ticket | Contenu | Preuve |
|---|---|---|
| 1.0 Contrats (ADR) | Signatures SQL de `radius.*` (§5.2) ; schéma minimal (tenant, site, router, plan, voucher, session) ; injection de l'instant de référence en test, avec 3 formes comparées (§14.4) ; outil de migration SQL | ADR accepté par Yacouba |
| 1.1 T2 de bout en bout | radclient → FreeRADIUS → `radius.authorize` → Accept avec `Session-Timeout` exact ; clients dynamiques + MA par attribut (E-FR-2) | T2, T10 |
| 1.2 Refus codés | `ticket_inconnu`, `expire`, `mauvais_site` (scope), `proprietaire_suspendu` ; recherche par propriétaire + code | T1, T4, T6 |
| 1.3 Accounting découplé | `detail` → lecteur → `radius.acct_*` idempotents ; activation au premier Start | T7, T2 (activation) |
| 1.4 Compteurs | Temps restant, validité, volume restant recalculés à chaque login ; `epuise` | T3, T12 |
| 1.5 Sessions | Appareils simultanés côté serveur, sessions fantômes, `acct_on_off` | T5, T8 |
| 1.6 Anti-devinette | `post_auth`, limitation par MAC et par routeur, alerte | T11 |
| 1.7 Base arrêtée | Variante `do_not_respond` (ADR) | L6e rejoué ; LABO-16 (piste B) |
| 1.8 CoA / Disconnect | Émission depuis le nœud avec le secret du routeur | Test serveur ici ; T9 sur CHR (piste B) |
| 1.9 Performance | p95 de `authorize` < 50 ms, 200 auth/s sur 4 vCPU (radclient / radperf) | Rapport chiffré |

**Fin de phase 1** : matrice T1–T12 verte, T9 côté serveur seulement (le reste de T9 se fait sur CHR) ; revue en deux axes, Standards et Spec ; étiquette `phase-1`.

---

## Phase 2 — Multi-propriétaires et enrôlement

| Ticket | Contenu | Preuve |
|---|---|---|
| 2.0 Contrats (ADR) | API de `wg-agent` (Go ou TS), plan d'adressage overlay, jeton d'enrôlement, OpenAPI de l'enrôlement | ADR |
| 2.1 Socle applicatif | Monorepo TS (pile D10 : Fastify, Prisma, Vite), schéma `app` Prisma, RLS, tests d'isolement | T6, test d'isolement |
| 2.2 API d'enrôlement | Jeton à usage unique, 30 min ; réception de la clé publique et de l'inventaire | Tests HTTP |
| 2.3 Scripts RouterOS v7 | Générateur `wakatnet-enroll.rsc` et `wakatnet-uninstall.rsc`, `login.html` ; audit par `mikrotik-routeros-config` | **CHR vierge et CHR déjà configuré, par Yacouba** (règle 6) |
| 2.4 `wg-agent` | Réconciliation des pairs sans redémarrer l'interface ; nftables sans transfert `wg0 → wg0` | Tests sur netns |
| 2.5 Révocation | Pair supprimé et routeur désactivé | Test : effet immédiat, puis `lifetime` |
| 2.6 Migration Mikhmon | Import CSV / export Mikhmon (§6.3), comportement selon LABO-08 | Tests d'import |
| 2b RouterOS 6 | Tunnel choisi par le labo, script v6, matrice T sur 6.49.x (ADR 0003) | CHR 6.49 (Yacouba) |

**Fin de phase 2** : preuves du §12 (enrôlement en une commande, désinstallation propre, isolement, révocation). La phase 2b doit être finie avant G-PILOTE, pas avant la phase 3.

---

## Phase 3 — Portail et paiement (mode A)

| Ticket | Contenu | Preuve |
|---|---|---|
| 3.0 Contrat `PaymentProvider` | Confronté aux réponses de 2 agrégateurs (§14.4) | ADR — **attend les réponses** |
| 3.1 Grand livre | `packages/ledger` : ajout seul, BIGINT, idempotence, tests de propriétés ; relecture par un second agent (règle 4) | Invariants du §8.4 |
| 3.2 `MockProvider` | Scénarios scriptables | P1–P9 |
| 3.3 Portail captif | Rendu serveur, < 100 Ko, sans dépendance externe ; récupération par jeton + référence (ADR 0005) | P6 ; mesure du poids |
| 3.4 Crédits et frais | Mode A : crédits prépayés, découvert plafonné, suspension (ADR 0001) ; frais papier (ADR 0002) | Tests de propriétés ; **test de bout en bout dû depuis le ticket 1.2 (ticket 03)** : un propriétaire au plafond de découvert voit ses tickets acceptés (`radius/tests/test_t03.py` n'en est qu'une garde partielle) |
| 3.5 Adaptateur réel | Celui de D2, en bac à sable | P1–P9 sur le bac à sable — **attend les clés** |
| 3.6 Achat de bout en bout | Navigateur sans interface derrière le hotspot | Partiel ici ; CHR et téléphone par Yacouba |

**Porte G-ARGENT** : phase 3 verte **et** `docs/CONFORMITE.md` rempli (piste B). Aucun franc réel avant.

---

## Phase 4 — Exploitation commerciale

Tableau de bord React (propriétaire, super-admin, gérant / vendeur) ; tickets papier en PDF, lots, points de vente ; relevés CSV / PDF et facture mensuelle (mentions SYSCOHADA : comptable) ; numéro masqué et recherche par numéro (ADR 0005) ; mode B derrière un drapeau, verrouillé (ADR 0001).

**Preuves** : parcours 1 à 5 du §2.2 joués de bout en bout, P10, audit d'accessibilité.

---

## Phase 5 — Haute disponibilité et durcissement

- Achat des nœuds Hetzner (ADR 0004), après les mesures LABO-17 ; FreeRADIUS par les paquets officiels (ADR à confirmer sur une VM Debian 13).
- Réplication A → B, promotion manuelle documentée (`docs/RUNBOOK.md`).
- Supervision et alertes Telegram, sauvegardes chiffrées avec test de restauration chronométré.
- Test de charge ; revue de sécurité par un agent qui n'a pas écrit le code (`docs/REVUE_SECURITE.md`).
- Rejeu de la matrice T sur la stable RouterOS courante (ADR 0003).
- **Avant G-PILOTE** : B migré chez un autre hébergeur, T13 rejoué (ADR 0004).

---

## Phase 6 — Pilote

Un site de Telecom Universel pendant 2 semaines, avec de petits montants et un rapprochement quotidien. Puis 3 propriétaires pilotes, après G-PILOTE. Suivi dans `docs/PILOTE.md`.

---

## Piste B — Yacouba (terrain, tiers), rattachée aux portes

| Action | Débloque | Avant |
|---|---|---|
| LABO-00 (versions), LABO-09 (timeout), LABO-16 (bascule A → B), LABO-18 (`Acct-Session-Id` après redémarrage), LABO-19 (`Acct-Interim-Interval`) sur CHR | Tickets 02, 04, 05, 08 et 09 ; réglage du `timeout` | Fin de phase 1 |
| LABO-08 (utilisateurs locaux), LABO-14 (walled garden HTTPS), tests des scripts 2.3 sur CHR | Phase 2, ticket 3.3 | Fin de phase 2 |
| Réponses des agrégateurs, clés de bac à sable | D2, D3, tickets 3.0 et 3.5 | Phase 3 |
| Juriste, CIL, ARCEP, comptable → `docs/CONFORMITE.md` | G-ARGENT | Fin de phase 3 |
| LABO-17 (latence), achat Hetzner, nom de domaine | Phase 5 | Phase 5 |
| Choix du second hébergeur, tests téléphone et mini-navigateur | G-PILOTE | Phase 5 |

---

## Méthode de travail (§13, §14.3)

- Pour chaque phase : PRD et tickets dans `.scratch/phase-N-titre/`, rédigés par l'agent (les skills [Y] sont absents ici) et validés par Yacouba.
- Une branche et une PR par ticket ; je relance moi-même les tests (règle 9) ; revue en deux axes en fin de ticket et en fin de phase.
- Chemin critique et argent : **jamais** délégués à un sous-agent (§14.3) ; seulement une relecture par un second agent.
- Journal mis à jour à chaque session ; un ADR par décision.

## Vérification

À chaque ticket :
- la ligne T ou P visée passe en rouge, puis en vert, avec la commande rejouable dans la PR ;
- `radius/tests/` complet est rejoué avant chaque fusion ;
- à chaque porte : étiquette Git, preuves du §12 listées dans le journal, revue sans réserve.
