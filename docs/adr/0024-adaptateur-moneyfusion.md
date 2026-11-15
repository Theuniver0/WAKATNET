# ADR 0024 — MoneyFusion, seul agrégateur réel ; pawaPay et CinetPay retirés

- **Statut** : décidé le 14/11/2026 par Yacouba (« SUPPRIME COMPLETTEMENT PAWAPAY ET CINETPAY ET INTEGRE MONEYFUSION »). **Remplace l'ADR 0020 (pawaPay) et l'ADR 0022 (CinetPay)**, gardés comme historique. **G-ARGENT reste fermée.**
- **Références** :
  - SPEC §7.2, §7.3 ;
  - ADR 0013 (mode A, contrat `FournisseurPaiement`) ;
  - documentation officielle `https://docs.moneyfusion.net/fr/webapi` et `/fr/payout`, lues le 14/11/2026 ;
  - liste publique `GET https://pay.moneyfusion.net/api/v1/withdraw/methods`, lue le 14/11/2026 : Burkina Faso, XOF, `orange-money-burkina` et `moov-burkina-faso`.

## Contrat de MoneyFusion (documentation officielle)

| Sujet | Fait |
|---|---|
| Compte | « Compte Money Fusion Enterprise ». Une application est créée dans « API de paiement ». Après validation, un **lien API** est généré : il vaut clé. |
| Sécurité de l'API | « Seules les adresses IP enregistrées pourront consommer l'API. » Le site de l'application doit être public, et la page de retour lui appartenir. |
| Paiement | `POST <lien API>` `{totalPrice, article, personal_Info, numeroSend, nomclient, return_url, webhook_url}` → `{statut, token, message, url}`. Le client paie sur la **page hébergée** `url` (`payin.moneyfusion.net`). |
| Statut | `GET https://pay.moneyfusion.net/paiementNotif/{token}`, **sans authentification** → `data.statut` ∈ `pending`, `failure`, `no paid`, `paid` ; `Montant`, `frais`, `moyen`, `numeroTransaction`, `personal_Info`. |
| Webhook | `payin.session.pending`, `.completed` et `.cancelled`, parfois répétés. **Aucune signature documentée.** |
| Bac à sable | **Aucun** n'est documenté. |
| Retraits (payout) | `POST /api/v1/withdraw`, en-tête `moneyfusion-private-key`. Non branché : le mode B reste verrouillé (ADR 0001). |

## Décisions

1. **Flux « redirect »**.
   - Le portail ne demande plus de code OTP. Il crée le paiement, puis redirige le client vers la page de MoneyFusion.
   - Le client revient ensuite à la page de suivi de l'achat (`return_url`), qui attend la confirmation comme avant.
   - L'adaptateur n'accepte qu'une page `https://payin.moneyfusion.net/…` : jamais de redirection ouverte.
2. **Jeton = référence du fournisseur**.
   - Le statut ne se lit que par le jeton. Il est noté au passage à PENDING, avant que le client ne reçoive la page.
   - `verify(reference, referenceFournisseur)` le reçoit, lu en base par `app.paiement_reference_fournisseur_lire` (migration 0053).
   - Notre référence voyage dans `personal_Info[0].reference`. Au statut, une référence étrangère est refusée.
3. **A5 inchangé**.
   - Le webhook, non signé, n'est qu'un déclencheur. Seul le statut lu chez MoneyFusion fait passer un paiement à SUCCEEDED.
   - Un corps illisible est refusé (401) sans effet.
4. **Statuts**.
   - `paid` donne SUCCEEDED, `failure` donne FAILED.
   - `pending` et `no paid` restent PENDING : « non effectué » peut désigner un paiement pas encore validé, et l'expiration le clôt.
   - Tout autre statut rend le fournisseur indisponible : réessai, jamais un échec à tort.
5. **A8, montant et devise** :
   - `Montant` est lu comme le montant payé. **[À CONFIRMER au premier paiement réel]** : est-il brut, ou net de `frais` ? L'exemple du statut donne 200 pour 200 ; celui du webhook donne 194 + 6. S'il était net, chaque vente finirait en MISMATCH : aucun ticket, alerte. Ce n'est jamais un ticket non payé.
   - La devise n'est pas rendue. « XOF » est posé : le compte du marchand doit être au Burkina **[À CONFIRMER]**.
6. **Argent réel**.
   - Sans bac à sable, un compte MoneyFusion encaisse de l'argent réel. Il est refusé à l'enregistrement **et** à l'usage tant que `WAKATNET_ARGENT_REEL=1` n'est pas posée (G-ARGENT).
   - Les tests passent par un faux serveur local (`WAKATNET_MONEYFUSION_URL`, 127.0.0.1 seulement, jamais en production).
7. **Mise en place chez le propriétaire**. Le tableau de bord rappelle ce qu'il faut saisir dans l'application MoneyFusion :
   - les IP publiques des nœuds A et B, d'où partent les appels ;
   - l'adresse du portail, d'où viennent les pages de retour.
8. **Walled garden**.
   - `payin.moneyfusion.net` est ouvert avant connexion, en HTTPS (`walled-garden ip dst-host`, nom résolu par le routeur) et en HTTP. L'ajout est additif, posé par l'étape 2 et l'entretien, et retiré à la désinstallation.
   - Accepté par RouterOS 7.15.3 et 7.19.4 (banc CHR).
   - **[LABO]** :
     - un téléphone non connecté atteint-il la page, ressources tierces comprises ? Sinon, les ajouter ;
     - ce domaine ouvre-t-il un accès Internet gratuit ?
9. **Retraits** : non branchés (mode B verrouillé). L'API existe ; elle exigerait une IP fixe et une clé privée.

## Risques acceptés par Yacouba, à lever avant G-ARGENT

- **Statut réglementaire**.
  - MoneyFusion est installée à Abidjan (Côte d'Ivoire).
  - Son site dit seulement : « Partenaire reconnu par plusieurs institutions agréées BCEAO ». Elle ne se dit pas elle-même établissement de paiement agréé.
  - pawaPay, lui, passait par Kerry Payments Burkina, agréée EP.BF.002/2025.
  - Agrément, contrat et entité au Burkina : à obtenir par écrit (`docs/CONFORMITE.md` §3 et §4 ; courriel à MoneyFusion).
- **Aucun bac à sable** : le premier essai sera réel. Il se fera avec de petits montants, après G-ARGENT, et tranchera la question brut ou net du `Montant`.
- **Webhook non signé, statut sans authentification**.
  - Un tiers qui connaît un jeton peut lire le statut du paiement.
  - Le jeton n'est remis qu'au client, dans l'adresse de la page de paiement.
  - Le webhook ne déclenche qu'une lecture du statut.
- **IP déclarées** : toute nouvelle IP de nœud (bascule vers B, changement d'hébergeur) doit être ajoutée par **chaque** propriétaire dans son application MoneyFusion. Sinon, ses ventes s'arrêtent : refus « IP non autorisée », sans argent perdu.
- **Format du relevé** pour le rapprochement quotidien : non documenté. Les colonnes se règlent par options sur le premier export réel.

## Relecture de sécurité (second agent, règle 4) : corrigé

1. **Bloquant, jeton perdu.**
   - Défaut : un webhook « pending » arrivé pendant `charge()` faisait passer le paiement à PENDING sans jeton. Le jeton noté ensuite était perdu, puisque `paiement_transition` ne réécrit pas un statut identique. Le client était débité sans recevoir de ticket.
   - Correction : `verify()` sans jeton lève « indisponible » et ne rend jamais PENDING. Le webhook répond 200 sans rien changer. Le paiement reste CREATED, et `charge()` y note le jeton.
2. **Devise non contrôlée.**
   - Défaut : « XOF » était posé d'office. Un paiement réglé dans une autre monnaie (GNF, XAF) aurait pu valoir un ticket.
   - Correction : « XOF » n'est posé que si `moyen` est un moyen du Burkina (`orange-money-burkina`, `moov-burkina-faso`). Sinon la devise vaut « ? », et le paiement passe en MISMATCH (A8).
   - **[À CONFIRMER au premier paiement réel]** : la documentation montre « orange » sans pays. Si c'est la forme réelle, le premier paiement finira en MISMATCH, sans ticket, et la liste sera corrigée.
3. **Webhook non signé.**
   - Défauts : des POST inventés remplissaient la base, et un faux événement pouvait occuper la clé du vrai.
   - Correction :
     - le paiement est cherché **avant** de conserver l'événement : rien n'est stocké pour un paiement inconnu ;
     - un événement qui porte un autre jeton que celui noté est refusé (401), et rien n'est conservé ;
     - le débit est déjà limité par nginx (`wk_general`, 20 requêtes par seconde et par source).
4. **Walled garden trop large.**
   - Défaut : derrière un CDN, les IP sont partagées. Ouvrir tous les ports donnerait accès à d'autres services sans ticket.
   - Correction : l'entrée `walled-garden ip` est limitée à **tcp/443**.
5. **Portail non exigé.** `WAKATNET_PORTAIL_URL_PUBLIQUE` est maintenant exigée en production : c'est la page de retour du client.

Aussi corrigé : un compte inutilisable (argent réel avant G-ARGENT) donne « vente indisponible » au lieu d'une erreur 500.

**Non traité, consigné** :
- **Double clic sur « Payer ».** La seconde réponse « déjà » ne porte pas l'URL de paiement : le client attend sur la page de suivi.
- **Récupération du ticket sans cookie.** La migration 0045 la réserve au simulateur. Si le navigateur captif perd le cookie en passant par la page de MoneyFusion, le ticket payé n'est retrouvable que par le support. À vérifier en labo (LABO-10 à 13) avant le pilote.
- **Lien d'auto-connexion.** Le paramètre `l` voyage dans `return_url`.

## Retraits du dépôt

Supprimés :
- `packages/payments/src/pawapay.ts` et `cinetpay.ts`, avec leurs tests et faux serveurs ;
- l'outil `packages/payments/essais/cinetpay-bac-a-sable.ts`.

Le portail perd le code OTP.

Les ADR 0020 et 0022, ainsi que les migrations qui les citent, restent comme historique : une migration appliquée ne se réécrit pas.

## Preuves

- `apps/api/tests/moneyfusion.test.ts` contre un faux serveur aux formes de la documentation officielle :
  - le corps de la demande ;
  - les refus, dont IP non déclarée et redirection ouverte ;
  - les statuts ;
  - le webhook ;
  - le refus de l'argent réel avant G-ARGENT ;
  - un parcours de bout en bout : portail, page MoneyFusion, webhook sans effet tant que le statut est `pending`, ticket une fois `paid`, écart de montant, rapprochement sans webhook.
- Suites API et e2e vertes.
- Banc CHR : le walled garden de paiement est accepté et retiré.
