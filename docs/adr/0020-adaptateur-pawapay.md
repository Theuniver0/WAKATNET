# ADR 0020 — Adaptateur réel : pawaPay, API v2 (D2, ticket 3.08, préparation de G-ARGENT)

- **Statut** : décidé le 12/11/2026, par délégation de Yacouba (« tranche G-ARGENT : prépare l'adaptateur réel »). **G-ARGENT reste fermée** : la porte exige aussi `docs/CONFORMITE.md` rempli (contrat, avis juridique, autorisations), ce qui revient à Yacouba (SPEC §12).
- **Références** : SPEC §7.2, §7.3, §12 (G-ARGENT), D2 ; `docs/PAYMENT_PROVIDERS.md` §1.3 et §2.1 ; ADR 0013 ; documentation officielle de pawaPay v2, lue le 12/11/2026 : `https://docs.pawapay.io/v2/` (initiate-deposit, check-deposit-status, deposit-callback, signatures, public-keys, providers, test_numbers, failure_codes, what_to_know, deposits, active-configuration).

## Pourquoi pawaPay

- C'est le premier du classement de D2 (`PAYMENT_PROVIDERS.md` §1.3) :
  - flux direct conforme au portail (§7.2) : le code Orange est transmis par le serveur, le PIN Moov est demandé sur le téléphone ;
  - callbacks signés RFC 9421 ;
  - idempotence par identifiant fourni par le marchand ;
  - bac à sable ouvert **sans inscription préalable** ;
  - entité locale agréée au Burkina (Kerry Payments Burkina, EP.BF.002/2025, liste BCEAO vue en extrait).
- Sa documentation est complète et lisible en Markdown : l'adaptateur s'écrit sur des faits, et non sur des extraits.
- **Réserves de D2, inchangées** : frais Orange et montant minimum au Burkina inconnus ; ouverture d'un compte marchand par un petit propriétaire (mode A) non documentée. À lever par le questionnaire et le bac à sable.

## Faits retenus de la documentation

| Sujet | Fait |
|---|---|
| URL | bac à sable `https://api.sandbox.pawapay.io`, production `https://api.pawapay.io` ; `Authorization: Bearer <jeton>` |
| Dépôt | `POST /v2/deposits` : `depositId` (**UUID v4**), `payer.type = "MMO"`, `payer.accountDetails.phoneNumber` (indicatif, chiffres seuls : `226XXXXXXXX`), `payer.accountDetails.provider`, `amount` (chaîne), `currency`, `preAuthorisationCode` (Orange), `clientReferenceId`, `customerMessage` (4 à 22 caractères alphanumériques) |
| Réponse | `ACCEPTED`, `DUPLICATE_IGNORED` (même `depositId`), `REJECTED` + `failureReason.failureCode` |
| Statut | `GET /v2/deposits/{depositId}` → `FOUND` + `data`, ou `NOT_FOUND` ; `data.status` : `ACCEPTED`, `PROCESSING`, `IN_RECONCILIATION`, `COMPLETED`, `FAILED` |
| Montant rendu | « 100.00 » pour « 100 » demandé |
| Burkina | `ORANGE_BFA` (`PREAUTH` : code obtenu par `*144*4*6#`), `MOOV_BFA` (`PROVIDER_AUTH` : PIN sur le téléphone), XOF sans décimales |
| Callback | `POST` à l'URL déclarée dans le tableau de bord pawaPay, au statut final ; 8 tentatives sur 25 min ; 200 attendu |
| Signature | RFC 9421, ECDSA P-256 / SHA-256, composants `@method @authority @path signature-date content-digest content-type`, Content-Digest sha-256 ou sha-512, signature DER dans l'exemple ; clés publiques `GET /v2/public-key/http` ; **à activer** (« signed callbacks ») |

## Décision : l'adaptateur (`packages/payments/src/pawapay.ts`)

1. **`depositId` dérivé de notre référence.** La référence est `wk_` suivi de 16 octets aléatoires ; on y impose les bits de version et de variante, ce qui laisse 122 bits aléatoires.
   - `charge()` et `verify()` sont ainsi idempotents sur la référence, sans table de correspondance.
   - La référence voyage aussi dans `clientReferenceId`. Un callback dont `depositId` ne correspond pas à sa référence est refusé.
2. **Classement des réponses** (P8 : une issue inconnue ne vaut jamais un refus) :
   - `ACCEPTED` ou `DUPLICATE_IGNORED` : en attente ;
   - `REJECTED` : refus, sauf `PROVIDER_TEMPORARILY_UNAVAILABLE`, qui vaut indisponibilité ;
   - HTTP 400 : refus (aucun dépôt créé) ;
   - 401, 403, 5xx, réseau, délai : indisponibilité. Le paiement reste ouvert, et `verify()` tranchera.
3. **`verify()` fait foi** :
   - `COMPLETED` : réussi, avec le montant normalisé (« 100.00 » → 100 ; toute décimale non nulle devient un écart) ;
   - `FAILED` : échec ;
   - tout autre statut, `IN_RECONCILIATION` compris : en attente ;
   - `NOT_FOUND` : échec, comme le recommande la documentation (le dépôt n'a jamais été reçu).
4. **Callbacks**, refusés s'ils ne sont pas signés (*fail closed*) :
   - on vérifie la signature RFC 9421, sur la méthode, l'hôte et le chemin reçus, plus le Content-Digest ;
   - sont exigés les composants `@method`, `@authority`, `@path` et `content-digest`, et l'algorithme `ecdsa-p256-sha256` ;
   - la signature est acceptée en DER comme en r‖s ;
   - les clés publiques sont lues avec le jeton du propriétaire, gardées une heure, et relues une fois si aucune ne vérifie (rotation) ;
   - **fenêtre de date** : un jour en arrière, 5 minutes en avance. Un rejeu dans la fenêtre est sans effet : le callback ne fait que déclencher `verify()`, et les événements sont dédoublonnés (P1) ;
   - un callback refusé n'empêche rien : la vérification périodique (ADR 0013) conclut le paiement.
5. **Argent réel verrouillé** :
   - le compte marchand accepte l'environnement `production` seulement si `WAKATNET_ARGENT_REEL=1`. Yacouba ne pose cette variable qu'après avoir franchi G-ARGENT ;
   - jusque-là, seul le bac à sable est accepté.
6. **Secrets** :
   - le jeton est chiffré en base (ADR 0013 §8), jamais rendu ni journalisé ;
   - aucune redirection n'est suivie, et les corps d'erreur ne sont ni journalisés ni renvoyés ;
   - `WAKATNET_PAWAPAY_URL`, réservée aux tests, est refusée en production.
7. **Écran « Compte marchand »** : environnement et jeton ; il affiche ensuite l'adresse des callbacks à recopier chez pawaPay, avec la consigne d'activer les callbacks signés.

## Relecture par un second agent (règle 4) : corrigé

- **Élevé, bac à sable en production** : sur la vraie plateforme (`NODE_ENV=production`), un compte de bac à sable aurait délivré de vrais tickets à quiconque saisit un numéro de test public de pawaPay. Il y est désormais refusé, à l'enregistrement comme à l'usage.
  - Les essais en bac à sable se font sur une plateforme d'essai ;
  - la vraie plateforme n'accepte que la production, et seulement après G-ARGENT.
- **Changement de compte marchand** : avec des paiements encore vérifiables, il est refusé, quel que soit le fournisseur (migration 0035). Sinon, `verify()` aurait interrogé un compte qui ignore ces dépôts, et ils auraient été encaissés sans ticket.
- **Compte vérifié à l'enregistrement** (`GET /v2/active-conf`) : jeton valable pour l'environnement choisi, callbacks signés activés, un opérateur du Burkina ouvert aux dépôts.
- **Relecture des clés publiques** : seulement si le `keyid` est inconnu, au plus une fois toutes les 5 minutes, une seule requête à la fois. Sinon, de faux callbacks auraient fait appeler pawaPay à volonté avec le jeton du propriétaire.
- **Callback sans `clientReferenceId`** : la documentation ne garantit pas ce champ. Le paiement est alors retrouvé par `depositId` (migration 0035).
- **`UNKNOWN_ERROR`**, même en HTTP 200 : traité comme une indisponibilité, et jamais comme un refus, sinon le client repaierait.
- **`WAKATNET_PAWAPAY_URL`** : faux serveur local seulement, et jamais pour un compte de production.
- **Accepté** : le paramètre `expires` de la signature n'est pas appliqué, puisqu'un rejeu ne fait que relancer `verify()`. À revoir quand on saura si pawaPay signe à nouveau ses renvois.

## Preuves

`apps/api/tests/pawapay.test.ts`, contre un faux serveur aux formes de la documentation :
- tests de propriétés : `depositId` est un UUID v4 idempotent ; montants ;
- corps de la requête conforme ;
- classement des réponses ;
- `verify()` pour chaque statut ;
- signature RFC 9421 valide ou falsifiée, avec une vraie paire de clés ECDSA ;
- rotation des clés ;
- achat de bout en bout jusqu'au callback signé : ticket délivré, callback non signé refusé (401), argent réel refusé avant G-ARGENT.

## Non prouvé ici

**Le bac à sable réel de pawaPay** : il faut le jeton de Yacouba. À jouer avec les numéros de test du Burkina :

| Opérateur | Numéro | Issue |
|---|---|---|
| Orange | 22607345678 | réussi |
| Orange | 22607345148 | refusé (`PAYMENT_NOT_APPROVED`) |
| Orange | 22607345128 | jamais conclu |
| Moov | 22602345678 | réussi |
| Moov | 22602345048 | solde insuffisant |
| Moov | 22602345138 | jamais conclu |

Le bac à sable se joue sur une **plateforme d'essai** (sans `NODE_ENV=production`), jamais sur la vraie.

Restent aussi à vérifier :
- la valeur du code Orange en bac à sable ;
- le minimum et le maximum du Burkina (`GET /v2/active-conf`), aujourd'hui fixés à 100 F faute de valeur publiée ;
- le format réel des callbacks signés (étiquette, `keyid`) ;
- le relevé du compte pour le rapprochement (`docs/PILOTE.md` §4).
