# 07 — Anti-devinette et journal des tentatives

**PRD** : `../PRD.md` · **Matrice** : T11 · **Dépend de** : 06

> **11/11/2026** : `post_auth` et `auth_log` livrés au ticket 06 (décision de Yacouba), avec les critères « `post_auth` en échec » et « T6 journalisée ». Il reste ici : la limitation anti-devinette, l'alerte, la purge à 90 jours, et la base en lecture seule de bout en bout.

## À livrer
- ~~`post_auth` (ADR 0006, point 10) : journalise Accept et Reject dans `auth_log`.~~ **Livré au ticket 06.**
- Limitation (point 11) :
  - seuils distincts par MAC et par routeur ;
  - un refus `trop_de_tentatives` n'est pas compté comme échec ;
  - contrôle avant la recherche du ticket ;
  - signal d'alerte inscrit pour le futur worker ;
  - index (routeur, MAC, instant).
- Purge de `auth_log` à 90 jours (ADR 0005) : rôle `wk_maint`, tâche idempotente et journalisée.

## Critères d'acceptation
- **T11** : 10 échecs en 1 minute depuis la même MAC → `trop_de_tentatives` et signal d'alerte. Après la fenêtre, un code valide est de nouveau accepté.
- N échecs depuis des **MAC différentes** sur un même routeur → comportement par routeur conforme à l'ADR (alerte, ou limite).
- ~~**`post_auth` en échec** : l'Accept reste un Accept.~~ **Prouvé au ticket 06** (REVOKE temporaire).
- **Base en lecture seule** : l'authentification fonctionne (préparation de T13).
- `auth_log` et les journaux de FreeRADIUS ne contiennent aucun code de ticket en clair (recherche automatique).
- ~~**T6, partie « tentative journalisée »**~~ **Prouvé au ticket 06.** (reporté du ticket 03) : un code du propriétaire A présenté sur r7 (propriétaire B) → une ligne `auth_log` avec le `router_id` de r7, le résultat Reject, la cause `ticket_inconnu`, **`voucher_id` NULL** (jamais le ticket de A), et aucun code en clair.
