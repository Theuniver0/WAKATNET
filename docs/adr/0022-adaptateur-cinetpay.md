# ADR 0022 — Second adaptateur réel : CinetPay, API v1 « paiement direct » (D2)

- **Statut** : décidé le 13/11/2026, sur demande de Yacouba (« Ajoute cinetpay »). **G-ARGENT reste fermée** : comme pour pawaPay, l'environnement de production n'est accepté qu'avec `WAKATNET_ARGENT_REEL=1`, que Yacouba pose lui-même (SPEC §12).
- **Références** :
  - SPEC §7.2, §7.3, D2 ;
  - `docs/PAYMENT_PROVIDERS.md` §2.2 (CinetPay, deuxième du classement de D2) ;
  - ADR 0013 et ADR 0020 (même contrat, mêmes gardes) ;
  - SDK officiel `cinetpay-js` 0.1.1 (npm, auteur « CinetPay », dépôt `github.com/cinetpay/cinetpay-js`), lu le 13/11/2026.

## Source, et sa limite

- La v1 n'est décrite sur **aucune** page de `docs.cinetpay.com`, ce que `PAYMENT_PROVIDERS.md` §2.2 avait déjà relevé. Cette page est d'ailleurs bloquée par le réseau de la session de développement.
- L'adaptateur suit donc **le code du SDK officiel**, et non une documentation. Tout ce que le SDK ne montre pas est marqué **[À CONFIRMER]**, et se tranche au bac à sable avec les clés de Yacouba.

## Pourquoi la v1 (paiement direct) et non la v2 (page hébergée)

| | v1 `direct_pay` | v2 page hébergée |
|---|---|---|
| Parcours du portail (§7.2) | identique à pawaPay : code Orange saisi sur le portail, code secret Moov sur le téléphone | redirection vers une page CinetPay depuis le portail captif : domaines CinetPay à ouvrir dans le walled garden de chaque routeur, retour au portail à gérer |
| Contrat `FournisseurPaiement` | inchangé | flux `redirect`, à concevoir |
| Webhook | `notify_token` par transaction, sans signature | HMAC `x-token` (champs et ordre contradictoires selon les pages) |
| Documentation | SDK seulement | pages officielles |

La v1 entre dans l'architecture sans la changer, et la sécurité ne repose pas sur le webhook : `verify()` fait foi pour tous les adaptateurs (A5). La v2 demanderait un ADR d'architecture, consacré au portail et au walled garden.

## Faits retenus du SDK (`dist/index.js`)

| Sujet | Fait |
|---|---|
| URL | bac à sable `https://api.cinetpay.net`, production `https://api.cinetpay.co` ; clés `sk_test_…` et `sk_live_…` |
| Connexion | `POST /v1/oauth/login` `{api_key, api_password}` → `access_token` (Bearer). Durée gardée par le SDK : 23 h. Jeton périmé : code 1003 `EXPIRED_TOKEN`, d'où une reconnexion et un seul nouvel essai |
| Paiement | `POST /v1/payment` : `currency`, `merchant_transaction_id` (1 à 30 caractères), `amount` (entier, 100 à 2 500 000), `lang`, `designation`, `client_email`, `client_first_name`, `client_last_name`, `success_url`, `failed_url`, `notify_url` (1 à 120), `channel` (PUSH, OTP, QRCODE), `payment_method` (`OM_BF`, `MOOV_BF`), `client_phone_number` (`+226…`), `direct_pay`, `otp_code` (4 à 6 chiffres) |
| Réponse | `code`, `status`, `transaction_id`, `notify_token`, `details.must_be_redirected`. Codes d'appel réussi : 200, 100, 2001, 2002 ; 1200 `TRANSACTION_EXIST` (même référence) |
| Statut | `GET /v1/payment/{identifiant}`, avec identifiant = `payment_token`, `transaction_id` ou `merchant_transaction_id` → `status` : `SUCCESS` ; `FAILED`, `EXPIRED`, `OTP_ERROR`, `OTP_EXPIRED`, `INSUFFICIENT_BALANCE`, `USER_NOT_FOUND`, `USER_IS_BLOCKED` ; `INITIATED`, `PENDING` ; 404 `NOT_FOUND` |
| Webhook | corps JSON : `notify_token`, `transaction_id`, `merchant_transaction_id`, `user`. Aucune signature |

## Décisions

1. **Notre référence est le `merchant_transaction_id`** (`wk_` suivi de 22 caractères, soit 25 au total). `charge()` est idempotent : un second envoi rend `TRANSACTION_EXIST`, lu « en attente », et `verify()` interroge par cette même référence.
2. **Classement des réponses (P8)** :
   - refus du payeur ou de l'opérateur (`OTP_ERROR`, `INSUFFICIENT_BALANCE`, `FAILED`…) et `INVALID_PARAMS` → refus ;
   - tout le reste (`OPERATION_ERROR`, 5xx, `NOT_ALLOWED`, identifiants refusés, réponse inattendue) → fournisseur indisponible : le paiement reste ouvert et `verify()` tranche ;
   - un **statut inconnu au `verify()`** n'est **jamais** lu comme un échec : il est réessayé au tour suivant.
3. **A8, montant confirmé.**
   - La réponse de statut, telle que le SDK la lit, ne contient **ni montant ni devise**. L'adaptateur les lit s'ils sont présents (`amount`, `currency`).
   - S'ils sont absents, il rend un montant de -1 et le service classe le paiement **en écart (MISMATCH), sans ticket**. Aucune règle d'argent n'est affaiblie.
   - **Conséquence** : si le bac à sable montre que la v1 ne rend jamais le montant, aucune vente CinetPay ne délivrera de ticket. Il faudra alors une décision de Yacouba, à consigner dans un nouvel ADR : soit une autre source du montant, soit une règle A8 adaptée et argumentée.
   - **Verrou** (relecture, n° 1) : `MONTANT_AU_STATUT_CONFIRME = false` dans `cinetpay.ts`. Tant qu'il vaut `false`, l'environnement de production CinetPay est refusé, **même G-ARGENT franchie** : sans ce verrou, chaque client payé finirait en écart. Il ne passe à `true` que par un ADR, preuve du bac à sable à l'appui.
4. **Webhook = déclencheur.**
   - Pas de signature : le corps est contrôlé dans sa forme seulement, sans appel sortant.
   - Le service ne lance `verify()` que pour un paiement **réel de ce propriétaire**, retrouvé par notre référence ou par l'identifiant CinetPay noté à `charge()`. Une référence inventée ne provoque aucun appel à CinetPay (prouvé par un test).
   - Le `notify_token` n'est pas conservé. Le comparer exigerait de le garder par paiement (migration) : c'est un durcissement possible, non nécessaire à la sûreté de l'argent.
5. **URL de notification.** Elle est transmise à chaque paiement (`notify_url` = `WAKATNET_API_URL_PUBLIQUE/webhooks/cinetpay/<id du compte>`) ; le propriétaire n'a rien à recopier. `success_url` et `failed_url`, exigés par le SDK, valent l'adresse publique.
6. **Aucune donnée du client vers CinetPay au-delà du numéro.** Les champs nominatifs exigés par le SDK reçoivent des valeurs neutres (`Client`, `WAKATNET`, `client@wakatnet.invalid`) **[À CONFIRMER : acceptés par l'API ?]**.
7. **Mêmes gardes que pawaPay** :
   - clé `sk_test_` seulement en bac à sable, `sk_live_` seulement en production ;
   - production refusée avant G-ARGENT ;
   - bac à sable refusé sur la plateforme de production ;
   - URL de test (`WAKATNET_CINETPAY_URL`) limitée à `127.0.0.1` ;
   - compte vérifié à l'enregistrement (connexion OAuth) ;
   - jetons d'accès en cache par empreinte de clé, jamais par la clé elle-même.
8. **Montant multiple de 5** exigé avant tout appel. Selon des extraits cohérents, une transaction CinetPay au Burkina échoue sinon : un forfait de 102 F est donc refusé avec un message clair.

## [À CONFIRMER] au bac à sable (clés de Yacouba)

| Point | Effet si faux |
|---|---|
| `amount` et `currency` présents dans `GET /v1/payment/{id}` | toutes les ventes CinetPay en écart (décision 3) |
| Canal `PUSH` pour Moov BF, `OTP` pour Orange BF | paiement refusé (`INVALID_PARAMS`) |
| `direct_pay` disponible pour `OM_BF` et `MOOV_BF`, sans redirection | refus « redirection exigée » |
| Champs nominatifs neutres acceptés (adresse en `.invalid`) | `INVALID_PARAMS` à chaque paiement |
| Code 606 « débit répété » (Orange) sur deux tickets de 100 F à la suite | second achat refusé (R6) |
| Numéros de test du Burkina (le SDK n'en cite qu'en +225) | bac à sable inutilisable pour le BF |
| Le statut se lit en tête du JSON (`status`), et non sous `details.status` comme à l'initialisation (relecture, n° 5) | `verify()` rend « statut inattendu » : jamais d'échec à tort, mais aucun paiement tranché |
| `NOT_FOUND` juste après un paiement parti au délai (relecture, n° 4) | passage à FAILED, repris toutes les 5 min : le portail affiche un échec un temps |

## Conséquences

- Le propriétaire choisit pawaPay ou CinetPay dans le tableau de bord. Les deux comptes partagent le même service, les mêmes transitions SQL et le même rapprochement.
- **Rapprochement quotidien** (`rapprochement.ts`) : le format du relevé CinetPay est inconnu. Les colonnes se déclarent en ligne de commande, comme pour pawaPay ; à régler sur un vrai export.
- **Agrément** : CinetPay Africa est agréé en Côte d'Ivoire, pas au Burkina (`PAYMENT_PROVIDERS.md` §2.2). La question relève de `docs/CONFORMITE.md` §4 avant G-ARGENT.
- **Réseau** : `api.cinetpay.net` et `api.cinetpay.co` ne sont pas joignables depuis la session de développement. Aucun appel réel n'a été fait.

## Preuves

- `apps/api/tests/cinetpay.test.ts`, sur un faux serveur aux formes du SDK, couvre :
  - les propriétés du montant ;
  - le corps de la requête champ par champ ;
  - l'idempotence ;
  - le classement des refus et des pannes ;
  - les contrôles faits avant tout appel ;
  - la reconnexion sur jeton périmé ;
  - `verify()`, statut par statut ;
  - le webhook, sans appel sortant ;
  - les gardes de clés et d'environnement ;
  - le parcours de bout en bout par l'API : enregistrement, achat, notification, ticket, puis montant absent → MISMATCH sans ticket.
- **Relecture par un second agent** (règle 4, 13/11/2026). Aucun chemin vers un ticket sans paiement confirmé. Dix constats, tous du côté « client payé sans ticket » ou « payé deux fois ».
  - **Corrigés, chacun avec son test** :
    - n° 1 : verrou sur la production ;
    - n° 2 : faux serveur à la forme du SDK par défaut, le montant au statut devient une hypothèse nommée ;
    - n° 3 : budget total de 12 s pour `charge()`, connexion comprise, et 9 s pour `verify()`, requêtes annulées. Le paiement n'est pas envoyé s'il reste moins de 6 s : sinon il partirait après la réponse « réessayez » du portail ;
    - n° 4 : un 404 sans corps JSON `NOT_FOUND` compte comme une panne ;
    - n° 6 : une seule reconnexion par jeton refusé ;
    - n° 7 : clé du cache sur la clé ET le mot de passe ; `verifierCompte` ouvre sa propre connexion ;
    - n° 8, en partie : un webhook sur un paiement en état final n'appelle plus le fournisseur, et ce pour tous les adaptateurs ;
    - n° 9 : un rejeu n'écrase plus l'identifiant CinetPay ;
    - n° 10 : `null` est traité comme une référence absente.
  - **Reportés** : n° 5 (statut au bon niveau du JSON) et la conservation du `notify_token` (n° 8, migration) rejoignent la liste du bac à sable ci-dessus.
