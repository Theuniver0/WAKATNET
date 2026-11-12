# ADR 0014 — Contrats de la phase 4 : comptes, rôles, tableau de bord, documents, mode B

- **Statut** : **accepté le 12/11/2026, par délégation de Yacouba** (« continue avec la phase 4 »). Les mentions fiscales de la facture restent **[À CONFIRMER]** avec le comptable.
- **Références** : `docs/SPEC.md` §2, §7.5, §8.3 à §8.5, §10.1 ; ADR 0001, 0002, 0005, 0012 §7, 0013 ; ticket `.scratch/phase-4-exploitation/issues/01-contrats.md`.

## 1. Authentification

Trois formes comparées (§14.4) :

| Forme | Pour | Contre |
|---|---|---|
| A. **Session côté serveur**, cookie opaque `HttpOnly`, empreinte en base | Révocable tout de suite (suspension, vol) ; rien à déchiffrer côté client | Une lecture en base par requête |
| B. Jeton signé (JWT) dans un cookie | Aucune lecture en base | Révocation impossible avant l'expiration ; clé de signature à gérer |
| C. Jeton dans `localStorage` | Simple | Volable par toute faille XSS |

**Retenu : A.**
- **Cookie** `wk_session` : 32 octets aléatoires, `HttpOnly; Secure; SameSite=Strict; Path=/`. La base ne garde que l'empreinte SHA-256 (`app.session_utilisateur`).
- **Durée** : 12 h glissantes, 7 jours au plus. Une suspension du propriétaire ou de l'utilisateur coupe ses sessions à la requête suivante.
- **Mot de passe** : scrypt (`node:crypto`), N = 2^15, r = 8, p = 1, sel de 16 octets, 32 octets de sortie. Forme stockée : `scrypt$N$r$p$sel$empreinte`. Au moins 10 caractères. Comparaison en temps constant.
- **Limites** : 5 échecs par adresse e-mail sur 15 min, puis refus pendant 15 min. Les échecs sont journalisés, avec la même réponse que le compte existe ou non.
- **CSRF** : `SameSite=Strict` **et** en-tête `X-Wakatnet-Requete: 1` exigé sur toute requête qui modifie (POST, PUT, PATCH, DELETE) des routes `/v1` et `/admin`. Un formulaire tiers ne peut pas poser d'en-tête personnalisé sans un préflight CORS, que l'API n'autorise pas.
- **L'en-tête de développement de l'ADR 0012 §7 est retiré.** Les tests ouvrent une vraie session.

## 2. Rôles

| Rôle | Rattachement | Droits |
|---|---|---|
| `super_admin` | Plateforme (aucun propriétaire) | Outils d'administration, après TOTP seulement |
| `proprietaire` | Un propriétaire | Tout sur ses données ; crée gérants et vendeurs |
| `gerant` | Un propriétaire et un point de vente | Lots et tickets de **son** point de vente, statistiques de ce point de vente, forfaits en lecture |
| `vendeur` | Un propriétaire et un point de vente | Tickets de son point de vente en lecture, marquage « remis » ; ses propres statistiques |

- Chaque route déclare son rôle ; un test prouve chaque refus.
- La RLS par propriétaire (ADR 0012 §6) reste la défense en profondeur. Le filtre par point de vente est posé dans le code, et des tests le prouvent.

## 3. Double authentification (super-admin)

- **TOTP** (RFC 6238 : HMAC-SHA-1, 6 chiffres, pas de 30 s, ±1 pas toléré), écrit à la main sur `node:crypto` et vérifié contre les vecteurs de la RFC.
- Le secret est chiffré au repos (AES-256-GCM, même clé que les comptes marchands, donnée associée `totp:ADRESSE`).
- **Une session de super-admin n'ouvre les routes `/admin` qu'une fois le TOTP validé dans cette même session.** Un code déjà utilisé est refusé (pas de rejeu).
- Création du premier super-admin : script `apps/api/src/admin-creer.ts`, lancé à la main sur le nœud. Le mot de passe est lu sur l'entrée standard, jamais passé en argument (S1). Le script affiche une seule fois l'URI `otpauth://`.

## 4. Super-admin et cloisonnement

- Le super-admin n'a pas de propriétaire courant. Ses vues transverses (liste des propriétaires, commissions) passent par des fonctions `SECURITY DEFINER` dédiées, exécutables par `wk_api`. L'API ne les appelle **qu'après** avoir vérifié le rôle et le TOTP.
- Ses actions sur un propriétaire (rechargement, suspension, réglages) sont toutes inscrites au journal d'audit, avec l'identifiant du super-admin.

## 5. Tableau de bord

- `apps/dashboard` : React 18, Vite et TypeScript (pile D10), **sans bibliothèque de routage ni d'interface**. Un petit routeur sur le `#` de l'URL et du CSS écrit à la main suffisent.
- Construit par `vite build`, puis servi par l'API sous `/tableau/` : **même origine** que l'API, d'où `SameSite=Strict` et aucune configuration CORS.
- En-tête CSP stricte : `script-src 'self'`, sans `unsafe-inline`.
- *Précisé à l'implémentation (ticket 08)* :
  - les fichiers construits sont lus **une fois** au démarrage (`WAKATNET_TABLEAU_DIR`, par défaut `apps/dashboard/dist`) ; une requête ne sert que ce qui est en mémoire, et aucun chemin de requête ne touche le disque ;
  - un chemin sans extension renvoie `index.html` (routeur sur le `#`) ; les fichiers de `assets/` sont marqués immuables ;
  - CSP complète : `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.

## 6. Documents

- **PDF écrit à la main, sans dépendance** : PDF 1.4, police standard Helvetica (aucune police embarquée), encodage WinAnsi pour les accents français, texte et cadres seulement.
  - Tickets : 10 par page A4 (2 × 5), avec le code en grand, le forfait, le prix, la validité et le nom du site.
  - Relevé et facture : tableaux simples.
  - Validation : le PDF est ouvert par Chromium dans les tests.
  - Écartés : pdfkit et Puppeteer, des dépendances lourdes pour trois mises en page.
- **CSV** : UTF-8 avec BOM, séparateur `;` (Excel en français), montants en entiers XOF. Les champs commençant par `=`, `+`, `-` ou `@` reçoivent une apostrophe en tête, contre l'injection de formules.

## 7. Facture mensuelle

- Total des commissions et des frais papier d'un mois, lu dans le grand livre ; une ligne par nature.
- Mentions légales et fiscales (numéro IFU, régime, TVA éventuelle, imputation SYSCOHADA) : **[À CONFIRMER]** avec le comptable. La facture porte la mention « document provisoire » tant que `docs/CONFORMITE.md` ne les fixe pas.
- La numérotation séquentielle des factures attend elle aussi la règle comptable : non faite.

## 8. Mode B verrouillé (ADR 0001)

- Table `app.plateforme_parametre`, sans aucun droit d'écriture pour les rôles de connexion. Le drapeau `mode_b_autorise` ne se pose qu'à la main, par l'administrateur de la base, après l'accord écrit consigné dans `docs/CONFORMITE.md`.
- `settlement_mode = 'B'` est refusé par un déclencheur tant que le drapeau est faux.

## 9. Reversements (P10)

- `app.payout` : référence unique (idempotence), montant, statut `CREATED → SENT → SUCCEEDED | FAILED`, et `EN_DOUTE` quand l'envoi a échoué par une coupure.
- **Règle P10** : un reversement `EN_DOUTE` n'est **jamais** renvoyé sans un `verifyPayout()` qui répond « inconnu » ; s'il répond « réussi », il est marqué réussi sans rien renvoyer.
  - *Resserré à l'implémentation (relecture du code d'argent)* : la première rédaction permettait aussi un renvoi sur « échoué ». Retenu : « échoué » est un verdict **définitif** (`FAILED`), et un nouveau versement passe par un nouveau reversement, sous une nouvelle référence, par décision humaine. Un échec annoncé à tort ne peut donc pas mener à un double paiement.
- *Précisé à l'implémentation (ticket 07)*, contre les deux courses qui mènent à un double envoi :
  - **renvoi par comparaison-échange** : `reversement_renvoi_permis(référence, envois_vus)` n'accorde le renvoi que si `envois` n'a pas bougé ; deux traitements partis du même état ne peuvent pas renvoyer tous deux ;
  - **âge minimal** : un reversement `EN_DOUTE` ou `SENT` n'est repris qu'après 120 s sans changement, bien plus que le délai d'un envoi (15 s). Sans cette garde, un traitement pourrait vérifier un ordre encore en route, lire « inconnu » et renvoyer. Ce plancher est posé **en base** : l'appelant ne peut pas le réduire ;
  - **annulation** : à l'expiration du délai, la requête est annulée par un `AbortSignal`, pas seulement abandonnée. Un adaptateur réel (ticket 3.08) devra détruire la requête HTTP sur ce signal, et transmettre la référence comme clé d'idempotence au fournisseur ;
  - **au plus 5 envois** : au-delà, le reversement reste `EN_DOUTE` pour une décision humaine ;
  - un refus du fournisseur à l'envoi donne `FAILED`. Une erreur sur un reversement est rendue avec lui et n'arrête pas les suivants ;
  - le drapeau `mode_b_autorise` est relu à la création et au traitement : le rabaisser **gèle** aussi les reversements en cours.
- **Préalables à la levée du verrou**, non faits en phase 4 :
  - un rôle de connexion dédié à la tâche des reversements (aujourd'hui `wk_api` peut appeler `reversement_verdict` : P10 n'est tenue que par le code de l'API) ;
  - un montant calculé depuis le grand livre, et non fourni par l'appelant ;
  - le plafond par opération, la double validation au-dessus d'un seuil et le gel sur écart de rapprochement (SPEC §8.3) ;
  - une alerte sur un reversement bloqué (`SENT` sans réponse, ou plafond d'envois atteint).
- Écritures du grand livre pour le mode B (dette envers le propriétaire, compte de transit) : **non écrites en phase 4**. Le mode B reste verrouillé, et son plan comptable sera arrêté avec le comptable. La mécanique P10 est prouvée seule, sans argent réel, sur le `MockProvider`.
