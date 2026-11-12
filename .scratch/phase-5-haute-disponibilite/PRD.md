# PRD — Phase 5 : haute disponibilité et durcissement

- **Statut** : rédigé le 12/11/2026 par l'agent. **Validé par délégation** : Yacouba a demandé de « continuer avec la phase 5 ».
- **Références** : `docs/SPEC.md` §0 (exigences 1 et 2), §4, §5.6 (T13), §10, §12 (phase 5, G-PILOTE) ; ADR 0004, 0006, 0009, 0010, 0013, 0015 ; `docs/PLAN.md` (phase 5).

## 1. Problème

Un seul nœud porte l'authentification de tous les propriétaires. Une panne de PostgreSQL rend le parc muet (ADR 0009). Aucune sauvegarde, aucune alerte : une perte de disque efface le grand livre, et une panne n'est vue que par les clients.

## 2. Résultat attendu

- **T13** : PostgreSQL de A arrêté, les tickets déjà vendus authentifient sur B, dont la base est une réplique. L'accounting reçu pendant la panne est rejoué sans perte.
- Promotion de B **manuelle**, gardée contre le double primaire, et chronométrée. A revient en réplique.
- Sauvegardes chiffrées hors site ; restauration **chronométrée** ; essai mensuel automatisé, qui détecte aussi une altération du grand livre.
- Supervision des métriques du §10.3, alertes Telegram, page d'état.
- Nœud déployable de façon reproductible (Ansible), avec une mise à jour sans interruption.
- Rapport de charge sur la pile à deux nœuds.
- Rapport de revue de sécurité par un agent qui n'a pas écrit le code, et corrections faites.

## 3. Périmètre

**Dedans** : réplication physique asynchrone A → B ; `post_auth` muet sur une réplique ; rejeu de l'accounting vers le primaire où qu'il soit ; scripts de promotion et de retour ; pgBackRest ; collecteur de santé et alertes ; `logrotate` ; rôles Ansible ; `docs/RUNBOOK.md` ; test de charge RADIUS et HTTP ; `docs/REVUE_SECURITE.md`.

**Dehors** :
- achat des VPS et mesures de latence (LABO-17) ;
- bascule réelle d'un routeur sur CHR (LABO-16, LABO-09) ;
- second hébergeur pour B (condition de G-PILOTE) ;
- choix du stockage S3 hors site ;
- rejeu de la matrice T sur la stable RouterOS courante (CHR).
Tout cela revient à Yacouba (piste B).

## 4. Critères de fin de phase (§12)

1. T13 automatisé dans la matrice, vert.
2. Restauration chronométrée, avec sa durée au journal ; essai de restauration automatisé, vert, y compris la détection d'une écriture du grand livre modifiée.
3. Rapport de charge (`docs/CHARGE.md`).
4. `docs/REVUE_SECURITE.md`, corrections faites et testées.
5. Matrice T, tests de l'API et e2e verts.

## 5. Ordre

01 → 02 → 03 → 04 → 05 → 06 → 07 → 08. La revue de sécurité (08) se fait en dernier, sur le code de toute la phase.
