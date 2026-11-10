# ADR 0005 — Identité du client final et données personnelles (décision D9)

- **Statut** : accepté par Yacouba le 10/11/2026, porte G0. Les durées sont des valeurs par défaut, à remplacer dès qu'un avis juridique, la CIL ou l'ARCEP auront répondu.
- **Références** : `docs/SPEC.md` §3 (D9), §7.2 (page fermée pendant `PENDING`), §8.5, §10.1 ; `docs/CONFORMITE.md` (registre des traitements) ; ADR 0004 (hébergement hors du Burkina).

## Principe conservé

Aucune inscription du client final. Identité réduite au **numéro du payeur** ; pas de SMS en v1 (D9 de la spec).

## Décisions

### 1. Récupération d'un paiement après fermeture de la page (§7.2)

- **D'abord un jeton d'appareil.** À la création du paiement, le portail stocke sur l'appareil un jeton aléatoire, lié au paiement côté serveur (cookie et/ou stockage local). Au retour, s'il est présent, le ticket est proposé sans rien demander.
- **Repli : numéro du payeur + extrait de la référence de transaction**, c'est-à-dire les 4 derniers caractères de la référence que l'opérateur envoie par SMS au payeur.
- **Jamais la MAC seule** (spec §7.2) : elle est visible de tous sur un Wi-Fi ouvert.
- **Anti-devinette** : les tentatives de récupération sont limitées par appareil, par numéro et par site, et journalisées (même logique que le §5.5).
- **[LABO] à ajouter** :
  - le jeton survit-il dans les mini-navigateurs de portail captif d'iOS et d'Android (fermeture puis réouverture, changement d'application pour composer l'USSD) ?
  - la référence reçue par SMS correspond-elle à celle que l'agrégateur transmet, pour Orange BF et pour Moov BF ? À vérifier sur un vrai paiement en bac à sable.
  - Si l'une des deux réponses est négative, cet ADR est révisé.

### 2. Durées de conservation (valeurs par défaut, réglables)

| Donnée | Forme et durée |
|---|---|
| Numéro du payeur | **En clair 6 mois** (litiges, remboursements, rapprochement). Ensuite, remplacé par un **HMAC** et une forme masquée (`70 •• •• 12`), conservés aussi longtemps que l'écriture comptable qui les porte. |
| Écritures du grand livre | Durée comptable légale (10 ans sous SYSCOHADA, **à confirmer** avec le comptable). Après 6 mois, elles ne contiennent plus le numéro en clair : seulement la référence du paiement et le HMAC. |
| MAC et sessions | **12 mois**, puis suppression, sauf obligation légale contraire. |
| Journal des tentatives d'authentification (`auth_log`) | **90 jours**, puis suppression. |

- **HMAC et non simple hachage.** Un numéro burkinabè compte 8 chiffres : un hachage simple se retrouve par force brute en quelques secondes. On utilise un HMAC-SHA-256 avec une **clé secrète gardée hors de la base** (même régime que les autres secrets, §10.1). Cela corrige la formulation « numéro haché » de la première version de `docs/G0.md`.
- **Rotation de la clé HMAC** : prévue, mais elle oblige à recalculer les HMAC. La procédure est à écrire dans `docs/RUNBOOK.md`.
- **Purge** : tâche planifiée du worker, idempotente, journalisée. Les purges du grand livre sont **interdites** (ajout seul, §8.1) : la pseudonymisation passe par la séparation entre la table qui porte le numéro et le grand livre, qui ne contient que des références.

### 3. Qui voit le numéro

- **Propriétaire, gérant, vendeur** : forme masquée uniquement, limitée à leur périmètre (gérant et vendeur : leur point de vente).
- **Recherche par numéro** pour le support au guichet : le propriétaire saisit le numéro que le client lui donne, et la plateforme retrouve le paiement en comparant les HMAC. Aucune liste de numéros n'est exportable par le propriétaire.
- **Numéro complet** : super-admin seul, pour un litige ; chaque consultation est inscrite au journal d'audit (§10.1).

## Conséquences

- **Modèle de données** : le numéro est stocké dans `payment` sous trois formes (clair avec date de purge, HMAC, masqué). `ledger_entry` ne porte jamais le numéro.
- **Export** : les relevés propriétaire (CSV, PDF, §8.5) montrent la forme masquée.
- **Conformité** : à reporter dans le registre des traitements de `docs/CONFORMITE.md` (T2, numéro du payeur), avec la question de l'hébergement en Europe (ADR 0004).

## Incertitudes à lever (à confirmer, ce n'est pas un avis juridique)

1. Loi burkinabè sur les données personnelles (probablement la loi n°001-2021/AN) : durées maximales et formalités auprès de la CIL.
2. **Obligation éventuelle de conserver les journaux de connexion** pour un accès public à Internet (ARCEP, réquisitions judiciaires). Elle pourrait imposer des durées **plus longues** que les 12 mois retenus pour les MAC et les sessions.
3. Durée légale de conservation des pièces comptables (SYSCOHADA).
4. Transfert de données hors du Burkina (hébergement Hetzner en Europe).
