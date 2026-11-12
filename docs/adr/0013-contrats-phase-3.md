# ADR 0013 — Contrats de la phase 3 : paiement, grand livre, portail

- **Statut** : **accepté le 12/11/2026, par délégation de Yacouba** (« continue avec la phase 3 »). Les points **[LABO]** et **[À CONFIRMER]** restent ouverts.
- **Références** : `docs/SPEC.md` §4, §7, §8, §9, §10.1, §13 (règle 4) ; ADR 0001, 0002, 0005, 0012 ; `docs/PAYMENT_PROVIDERS.md` §6 et §7 ; ticket `.scratch/phase-3-portail-paiement/issues/01-contrats.md`.

## 1. `PaymentProvider` (§7.3)

- L'interface est reprise du §7.3, en TypeScript (`packages/payments/src/fournisseur.ts`). Montants : entiers XOF de type `number`, avec `Number.isSafeInteger` vérifié à chaque frontière (A1, A8).
- `verify()` **fait foi** pour tous les adaptateurs. Un webhook n'est qu'un **déclencheur** : sa signature est vérifiée, son corps brut conservé, puis `verify()` décide (`PAYMENT_PROVIDERS.md` §6).
- **Mode A** : un adaptateur est instancié **par propriétaire**, avec ses clés. Les webhooks arrivent sur `/webhooks/{fournisseur}/{identifiant_webhook}`, propre au compte marchand ; l'identifiant est aléatoire, pour qu'on ne puisse pas énumérer les propriétaires.
- **Appel de l'adaptateur, trois formes comparées** (§14.4) :

  | Forme | Pour | Contre |
  |---|---|---|
  | A. `charge()` appelé dans la requête du portail, après avoir écrit le paiement en `CREATED` | Le client voit tout de suite le code USSD ou l'attente du push ; aucune file | Une requête lente de l'agrégateur fait attendre le portail (délai borné à 15 s) |
  | B. Table d'envoi (outbox) et tâche | Découplé | Le client attend un tour de tâche avant de voir quoi faire |
  | C. BullMQ | Pile D10 | Ajoute Redis sur le parcours d'achat |

  **Retenu : A.** Le rapprochement (§6) rattrape tout ce qui reste `CREATED` ou `PENDING`.

## 2. États du paiement

`CREATED → PENDING → SUCCEEDED | FAILED | EXPIRED`, ainsi que `MISMATCH` et `REFUNDED`.

- Transitions permises :
  - `CREATED` vers `PENDING`, `FAILED` ;
  - `CREATED`, `PENDING`, `FAILED` et `EXPIRED` vers `SUCCEEDED`, parce que `verify()` fait foi (P7 : succès après expiration) ;
  - `CREATED` et `PENDING` vers `EXPIRED` (délai du portail : 3 min) ;
  - tout état non final vers `MISMATCH` (montant ou devise inattendus) ;
  - `SUCCEEDED` vers `REFUNDED` seulement.
- `MISMATCH` est **final** : une personne tranche (phase 4).
- Une transition vers l'état courant est sans effet (idempotence).
- Toutes les transitions passent par une fonction SQL (`app.paiement_transition`) qui verrouille la ligne du paiement (`FOR UPDATE`).

## 3. Grand livre (§8.1, A2, A3)

Trois formes comparées (§14.4) :

| Forme | Pour | Contre |
|---|---|---|
| A. Une ligne par mouvement signé, sans en-tête | Simple | L'équilibre d'une opération n'a pas de support ; la clé d'idempotence est répétée sur chaque ligne |
| B. **En-tête `transaction` (clé d'idempotence unique, nature, objet, taux figé) et lignes `ecriture` avec débit OU crédit**, équilibre vérifié à la validation | Équilibre et idempotence portés par un objet ; débit et crédit lisibles par un comptable | Deux tables |
| C. Lignes en JSON dans l'en-tête | Une table | Ni index ni contrainte par compte |

**Retenu : B.** Règles :
- Montants en `bigint`, strictement positifs ; débit **ou** crédit sur chaque ligne (`CHECK`).
- Un déclencheur **différé** (`CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`) refuse, à la validation, toute transaction déséquilibrée ou de moins de deux lignes.
- **Ajout seul** :
  - aucun droit `UPDATE`, `DELETE` ni `TRUNCATE` pour aucun rôle de connexion ;
  - un déclencheur refuse `UPDATE` et `DELETE` pour **tous**, propriétaire des tables compris ;
  - `TRUNCATE` est refusé par un déclencheur d'instruction.
- Seule porte d'écriture : `ledger.ecrire(cle, nature, objet, taux, lignes)`. Une clé déjà écrite avec le **même** contenu rend la transaction existante (idempotence) ; avec un contenu différent, elle lève une erreur (conflit, jamais un double comptage).
- Solde d'un compte = Σ crédits − Σ débits, pour un compte au crédit ; l'inverse pour un compte au débit. Le solde n'est jamais stocké : il se recalcule, donc le rejeu reconstruit les soldes (§8.4).

## 4. Comptes du mode A

| Compte | Sens | Rôle |
|---|---|---|
| `plateforme:tresorerie` | débit | Encaissements des rechargements de crédits par Telecom Universel |
| `plateforme:produit:commission` | crédit | Commission sur les ventes en ligne |
| `plateforme:produit:frais_papier` | crédit | Frais sur les tickets papier activés (ADR 0002) |
| `proprietaire:{id}:credits` | crédit | Crédits prépayés du propriétaire. Un solde négatif est un **découvert** |

Opérations :
- **rechargement** : débit de la trésorerie, crédit des crédits du propriétaire ;
- **commission** : débit des crédits, crédit du produit `commission` ;
- **frais papier** : débit des crédits, crédit du produit `frais_papier`.

L'argent de la vente elle-même arrive sur le compte marchand du propriétaire, et **jamais** dans ce grand livre : en mode A, la plateforme ne le détient pas (§8.2). Le paiement en garde la trace (`app.payment`).

## 5. Commission et frais (§8.1, ADR 0002)

- Commission : `(montant × bps + 5000) div 10000`, entiers ≥ 0, soit l'arrondi au franc le plus proche, 0,5 vers le haut. Minimum optionnel (`commission_min`, défaut 0).
- Frais papier : `max((prix × offline_fee_bps + 5000) div 10000, offline_fee_min)`, avec 1000 et 10 F par défaut.
- Taux et plancher sont **figés** dans l'en-tête de la transaction.
- Nouvelles colonnes de `app.tenant` :
  - `settlement_mode` (`A`) ;
  - `commission_bps` (1000) et `commission_min` (0) ;
  - `offline_fee_bps` (1000) et `offline_fee_min` (10) ;
  - `plafond_decouvert` (3000).

## 6. Rapprochement, expiration, frais papier

- **Pas de BullMQ en phase 3. Écart avec D10, assumé** : une seule tâche périodique (`apps/api/src/taches.ts`), lancée toutes les 60 s par une minuterie systemd, comme la coupure (ADR 0006 §17). Redis n'apporterait ici qu'un composant de plus à tenir. BullMQ arrivera quand une vraie file sera nécessaire (notifications, phase 4).
- Rapprochement :
  - `verify()` pour tout paiement `CREATED` ou `PENDING` créé depuis plus de 2 min, puis toutes les 5 min pendant 24 h ;
  - `PENDING` passe en `EXPIRED` à 3 min, mais reste vérifié pendant 24 h (P7).
- Frais papier :
  - un ticket **sans paiement en ligne**, activé, et sans transaction `frais_papier:voucher:{id}`, reçoit son frais ;
  - c'est idempotent par la clé du grand livre, et toujours **hors** du chemin d'authentification (ADR 0002).

## 7. Crédits, découvert, suspension (ADR 0001)

- La vente en ligne est **refusée** à la création d'un paiement si `solde < −plafond_decouvert`, ou si le propriétaire est suspendu, ou s'il n'a pas de compte marchand.
- Un paiement déjà engagé est confirmé même si le solde a franchi le plafond entre-temps : le client a payé. La commission passe alors en découvert.
- Les tickets existants ne sont **jamais** touchés : `radius.authorize` ne lit pas le grand livre (C1).
- Alerte « crédits bas » quand le solde passe sous 20 % du dernier rechargement : une entrée d'audit par rechargement, sans doublon. La notification viendra en phase 4.
- Rechargement : fonction réservée au super-admin, sans route HTTP en phase 3 (`app.credits_recharger`, appelée par `psql` sous un rôle d'administration), avec une clé d'idempotence fournie.

## 8. Clés marchandes (§8.2, §10.1, S3)

- AES-256-GCM, avec une clé de 32 octets détenue par l'API seule (`WAKATNET_CLE_MARCHANDS`, `EnvironmentFile`) et jamais stockée en base. Le format stocké est `version ‖ nonce (12) ‖ chiffré ‖ étiquette (16)`.
- Les clés ne sont **jamais** rendues par l'API après leur saisie, et jamais journalisées.
- Le secret de signature des webhooks fait partie de ces clés.

## 9. Récupération d'un paiement (ADR 0005 §1)

- **Jeton d'appareil** : 32 octets aléatoires dans un cookie `HttpOnly`, `SameSite=Lax`, de 24 h. Seule son empreinte SHA-256 est stockée dans `app.payment`.
- **Repli** : numéro du payeur, plus les 4 derniers caractères de la référence de l'opérateur. Comparaison sur le HMAC du numéro.
- **Limite** : 5 tentatives par numéro (HMAC) et par site sur 15 min, toutes journalisées. Jamais la MAC seule.
- Numéro du payeur sous trois formes :
  - en clair, avec sa date de purge (6 mois) ;
  - HMAC-SHA-256, avec la clé `WAKATNET_CLE_HMAC` hors de la base ;
  - masqué (`70 •• •• 12`).

## 10. Portail

- Servi par **le même processus Fastify** que l'API, sous `/p/…`. En production, il écoute sur l'IP fixe dédiée du portail (§7.1), ce qui sépare réseau et walled garden sans ajouter de composant.
- Pages rendues côté serveur en HTML et CSS en ligne, sans JavaScript obligatoire. Un petit script en ligne interroge l'état toutes les 3 s ; sans script, la page se recharge par `<meta http-equiv="refresh">`. Moins de 100 Ko par page, et un test le mesure.
- Le site est identifié par un **identifiant public aléatoire** (`app.site.public_id`), jamais par son numéro.
- **Auto-connexion** : redirection GET vers `link-login-only?username=CODE&password=CODE` **[LABO-12]**. Contre une redirection ouverte qui livrerait le code à un tiers, `link-login-only` doit être en `http` ou `https`, sans identifiants, et viser une IPv4 privée (RFC 1918, 100.64.0.0/10) ou l'hôte hotspot déclaré pour le site (`app.site.hotspot_hote`). Sinon, le ticket est seulement affiché.
- `login.html` du routeur devient une page de redirection vers le portail. Elle transmet `mac`, `ip`, `link-login-only`, `link-orig`, `error` et l'identifiant public du site.

## 11. Rôles PostgreSQL

- `wk_api` reste le rôle de l'API **et** du portail, et de la tâche périodique. Ce dernier point est un compromis assumé : un seul processus et une seule clé de chiffrement ; un rôle propre à la tâche viendra avec le worker.
- Tout ce qui touche à l'argent passe par des fonctions `SECURITY DEFINER` à `search_path` fixé. `wk_api` n'a **aucun** droit direct sur `ledger.*`, ni en écriture sur `app.payment`.
- Les routes publiques (portail, webhooks) n'ont pas de contexte de propriétaire : leurs fonctions retrouvent le propriétaire par l'identifiant public du site ou par l'identifiant de webhook, jamais par un paramètre fourni par le client.

## 12. Amendements après la relecture de l'argent (règle 4, 12/11/2026)

Un second agent, qui n'a pas écrit le code, a relu le code d'argent. Ses constats et leur traitement :
- **B1, corrigé.** Des requêtes de récupération **parallèles** contournaient la limite de 5 tentatives. Un verrou consultatif par numéro et par site, et un autre par appareil, sérialisent désormais le comptage. Prouvé : 30 requêtes parallèles donnent 5 tentatives et 25 refus.
- **I1, corrigé.** Le §10 admettait toute IPv4 privée comme cible de l'auto-connexion. Un autre client du même Wi-Fi aurait pu recevoir le code. **Nouvelle règle** : seuls les hôtes de connexion du hotspot (`hotspot-address` et `dns-name` de chaque profil) sont admis. L'étape 1 de l'enrôlement les relève, et ils sont rangés dans `app.site.hotspot_hotes`. Faute d'hôte relevé, le code est seulement affiché. **[LABO]** : noms de ces deux propriétés sur CHR.
- **I2, corrigé.** Des tickets à frais nul pouvaient occuper chaque tour de la tâche, au point d'empêcher tout prélèvement (famine). Ils sont maintenant exclus de la recherche.
- **I3, corrigé.** Les frais papier ne sont **jamais rétroactifs** : `app.tenant.frais_papier_depuis` vaut la date de la migration pour les propriétaires existants, puis la date de création. **Taux** : celui du propriétaire au moment du prélèvement, soit 60 s au plus après l'activation, et il est figé dans l'écriture. Un changement de taux dans cette minute est tenu pour négligeable ; c'est un écart assumé avec la lettre de l'ADR 0002.
- **I4, corrigé.** Changer de fournisseur est refusé (409) tant que des paiements restent ouverts : `verify()` serait sinon demandé au mauvais fournisseur.
- **Mineurs corrigés** :
  - M1 : événement unique **par propriétaire** ;
  - M3 : montant du fournisseur normalisé par `versXof`, et un montant illisible donne `MISMATCH` ;
  - M4 : le `MockProvider` exige `WAKATNET_MOCK=1` ;
  - M6 : purge du numéro en clair à 6 mois, par la tâche périodique ;
  - M8 : expiration dans un ordre fixe, et `FAILED` rapproché pendant 24 h.
- **Mineurs acceptés, sans changement** :
  - M2 : A5 repose sur le code de l'API, qui n'appelle `paiement_transition(..., 'SUCCEEDED')` qu'après `verify()`. Un rôle distinct pour le portail public viendra avec le worker ;
  - M5 : une récupération réussie rattache le ticket au nouvel appareil, et l'ancien perd l'accès. C'est voulu : on peut changer de téléphone. L'espace de 4 caractères, limité à 5 essais par 15 min, suppose des références d'opérateur alphanumériques ; **[LABO]** à vérifier sur un vrai paiement (ADR 0005 §1) ;
  - M7 : le propriétaire des tables peut retirer les déclencheurs. L'ajout seul tient contre tout rôle de connexion et contre toute écriture ; contre un administrateur de la base, c'est la sauvegarde chiffrée et son rapprochement (phase 5) qui protègent.
