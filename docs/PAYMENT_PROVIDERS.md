# Prestataires de paiement Mobile Money — matrice de vérification (phase 0)

> **Date : 10/11/2026.** Livrable du §12 (phase 0) et du §15 item 3 du SPEC.
> Méthode : recherche documentaire, puis contre-vérification adverse par un second agent. **Quand le contre-vérificateur dit qu'une valeur n'est pas dans la source, c'est lui qui l'emporte** : la valeur est rétrogradée en « non vérifié ».
> Règle 2 du §13 : comportement observé en labo > doc officielle de la version visée > journal des modifications > forums. Un blog tiers n'est qu'un **indice**, jamais une preuve.
> **Aucune valeur n'a été remplie de mémoire.** Ce document n'est pas un avis juridique.

---

## 0. À lire d'abord : limite majeure de cette vérification

Depuis le conteneur de travail, **aucune page de documentation officielle d'agrégateur n'a pu être chargée directement** : les domaines sont refusés par le proxy (curl : 403 CONNECT) ou ne se résolvent pas (WebFetch : ENOTFOUND). La liste complète est en §9.

Les valeurs ci-dessous viennent donc de deux canaux, de fiabilité très différente :

| Canal | Ce que c'est | Statut dans ce document |
|---|---|---|
| Code de SDK ou de plugin **officiel**, lu en entier (GitHub de l'éditeur, paquet npm de l'éditeur) | Preuve de ce que le client officiel envoie et attend. Ce n'est pas un engagement contractuel, mais c'est une lecture directe. | **vérifié (code SDK)** |
| Extrait renvoyé par un moteur de recherche pour une URL officielle | Résumé produit par le moteur ; la page n'a pas été lue. Plusieurs extraits se sont contredits entre eux. | **non vérifié (extrait)** |
| Source tierce (blog, presse, client non officiel, LinkedIn) | Indice seulement | **non vérifié (tiers)** |
| Rien trouvé | — | **non trouvé** |
| La source ne contient pas la valeur, ou la valeur est une déduction | — | **non vérifié** |

Conséquence directe : **aucun coût de vente à 100 F n'est établi chez aucun prestataire**, et **aucun montant minimum n'est confirmé par lecture directe**. Tous les chiffres de frais sont des indices à faire confirmer par écrit (voir `docs/QUESTIONS_AGREGATEURS.md`) et à mesurer en bac à sable.

---

## 1. Synthèse

### 1.1 Matrice résumée

Légende des cellules : valeur suivie de son statut. « nv » = non vérifié.

| Prestataire | Opérateurs BF | Flux sans redirection (portail) | Minimum | Frais encaissement | Signature webhook | Bac à sable | Agrément BCEAO |
|---|---|---|---|---|---|---|---|
| **pawaPay** (Kerry Payments Burkina) | Orange, Moov — nv (extrait) ; pas de Wave BF | Oui : Orange PREAUTH (OTP), Moov PROVIDER_AUTH (PIN) — nv (extrait) | nv (exposé par `GET /v2/active-conf`) | Moov : 3 % (2 % MMO + 1 %) — nv (extrait) ; Orange : non trouvé | RFC 9421, ECDSA P-256 — nv (extrait) | Oui, sans onboarding — nv (extrait) | Kerry Payments Burkina EP.BF.002/2025 — nv (extrait liste BCEAO 28/02/2026) |
| **CinetPay** | Orange, Moov — nv (extrait) ; `OM_BF`, `MOOV_BF`, `WAVE_BF` dans le SDK — vérifié (code SDK) | API v1 `direct_pay` — vérifié (code SDK), **non testé pour le BF** | 100 XOF, multiple de 5 — nv (extrait) | 3 % ou 4,5 % (pages contradictoires) — nv (extrait) | v2 : HMAC `x-token` — nv (extrait) ; v1 : `notify_token`, pas de HMAC — vérifié (code SDK) | v1 : `api.cinetpay.net` — vérifié (code SDK) | CinetPay Africa EP.CI.007/2025 (CI) — nv (extrait) ; absent des EP du BF |
| **YengaPay** (Kreezus) | Orange, Moov, Coris, Sank, Telecel — vérifié (code SDK) ; pas de Wave | Oui : `direct-payment/*` — vérifié (code SDK) | nv (renvoyé par `init()` ; l'exemple du README montre 200) | 2,5 % — nv (extrait) | HMAC-SHA256 hex, `X-Webhook-Hash` — vérifié (code du plugin officiel), à confirmer par l'API | Staging `api.staging.yengapay.com` — vérifié (code SDK) | non trouvé |
| **LigdiCash** | Orange, Moov — nv (extrait) | Oui : `straight/checkout-invoice/create` — vérifié (code SDK) | nv (extrait : Orange 10, Moov 100, non reproduit) | non trouvé (contractuel) | non trouvé (doc : « re-vérifier par confirm ») — nv (extrait) | URL `test.ligdicash.com` dans le SDK — vérifié (code SDK) ; statut réel nv | non trouvé |
| **FedaPay** | Orange, Moov — nv (extrait) | **Non documenté pour le BF** (redirection hébergée) — nv | 100 XOF — nv (ancienne doc v1) | 4 % — nv (extrait d'une page d'environ 1 an) | HMAC-SHA256 horodaté, tolérance 300 s — vérifié (code SDK) | `sandbox-api.fedapay.com` — vérifié (code SDK) | EP.BN.004/2026 (Bénin) — nv (extrait) ; rien au BF |
| **Flutterwave** | Orange, Mobicash — nv (extrait) ; **contredit** par le SDK officiel (BF absent, pas de MOBICASH en XOF) | Orange `authorization_code` — nv (extrait) ; champ absent du SDK officiel | « 100 » (unité, pays non précisés) — nv (extrait) | non trouvé (+ TVA 18 % sur les frais — nv (extrait)) | `verif-hash` secret statique (v3) — nv (extrait) | Oui (OTP 123456) — nv (extrait) | Flutterwave Sénégal EP.SN.004/2025 — nv (extrait) ; rien au BF |
| **InTouch** (InTouch Burkina) | non trouvé | non trouvé (Web Payment = redirection) | non trouvé | non trouvé | non trouvé | annoncé, simulateur « en développement » — nv (extrait) | INTOUCH Burkina EP.BF.001/2025 — nv (extrait) |
| **PayDunya** | Orange, Moov — nv (extrait) | Oui : SoftPay — nv (extrait) | non trouvé | **3 % + 100 FCFA** (tarif général) — nv (extrait) | hash statique SHA-512 de la master key — nv (extrait) | Oui (route générique) — nv (extrait) | Dunya Digital Payment CI / SN — nv (extrait) ; rien au BF ; lien avec PayDunya non sourcé |
| **Moneroo** (orchestrateur) | `orange_bf`, `moov_bf`, `mobi_cash_bf` — nv (extrait) | Non : redirection seule (SDK confirme l'absence de flux direct) | non trouvé | 0,01 USD + frais de la passerelle sous-jacente (inconnus) — nv (extrait) | HMAC-SHA256 `X-Moneroo-Signature` — nv (extrait) | Oui — nv (extrait) | se déclare non-PSP — nv (extrait) |
| **KkiaPay** | **Burkina non trouvé** | Non : widget JS seulement | non trouvé | sans objet (pas de BF) | `x-kkiapay-secret`, schéma indéterminé — nv (extrait) | `api-sandbox.kkiapay.me` — vérifié (code SDK) | Open SI EP.BN.002/2025 (Bénin) — nv (extrait) ; lien avec KkiaPay non sourcé |
| **Wave Business** | Wave seulement ; ouverture des API au BF non confirmée | **Non** : redirection vers l'appli (voir §7) | non trouvé | 1 % au-delà de 20 000 F/jour — nv (extrait, pays et API non précisés) | `Wave-Signature` HMAC-SHA256 + anti-rejeu 5 min — nv (extrait) | non trouvé | émetteur UBA Burkina — nv (extrait) |

### 1.2 Coût complet d'une vente à 100 F

Hypothèses de calcul, toutes tirées du SPEC :

- Commission de la plateforme (D3) : `commission_bps` = 1000, soit 100 × 1000 / 10 000 = **10 F**. Le résultat est un entier, la règle d'arrondi du §8.1 ne joue pas.
- Les frais de l'agrégateur sont **à la charge du propriétaire** (D3).
- Mode A : le propriétaire reçoit `100 − frais` sur son compte marchand, et les 10 F de commission sont débités de son solde de crédits. **Net propriétaire = 100 − frais − 10 = 90 − frais.**
- La TVA éventuelle sur les frais n'est intégrée que lorsqu'une source la mentionne (voir la colonne « remarque »).

**Valeur retenue : le coût est « inconnu » chez tous les prestataires, car aucun taux, aucun frais fixe et aucun minimum n'a été lu directement.** Le tableau suivant est un **calcul de sensibilité** sur les indices disponibles. Il ne doit **pas** servir à trancher D2 tant que les taux n'ont pas été confirmés par écrit.

| Prestataire | Indice de frais (statut) | Frais sur 100 F | Commission D3 | Net propriétaire | Remarque |
|---|---|---|---|---|---|
| Wave Business | 0 % sous 20 000 F/jour cumulés, 1 % au-delà (nv) | 0 F ou 1 F | 10 F | 90 F ou 89 F | Barème non confirmé pour l'API ni pour le BF ; flux incompatible avec le portail (§7) |
| pawaPay — Moov BF | 3 % (nv) | 3 F | 10 F | **87 F** | Paliers « tiered » non détaillés ; frais HT (nv), TVA éventuelle en plus ; Orange BF : inconnu |
| CinetPay — page principale | 3 % (nv) | 3 F | 10 F | **87 F** | Frais « généralement HT » (nv). Avec une TVA de 18 %, si elle s'applique : 3 × 1,18 = 3,54 F, net 86,46 F (arrondi inconnu) |
| CinetPay — fourchette | 1,5 % à 3,5 % (nv) | 1,5 F à 3,5 F | 10 F | 88,5 F à 86,5 F | Arrondi d'un frais fractionnaire : non trouvé |
| CinetPay — page `elixir` (Orange) | 4,5 % (nv) | 4,5 F | 10 F | 85,5 F | Contredit la page principale |
| YengaPay | 2,5 % (nv) | 2,5 F (2 F ou 3 F selon l'arrondi) | 10 F | 87,5 F (87 ou 88 F) | **Peut être impossible** : l'exemple du README montre un minimum de 200 F pour Orange |
| FedaPay | 4 % (nv, page d'environ 1 an) | 4 F | 10 F | **86 F** | Minimum 100 XOF non reconfirmé ; flux BF par redirection |
| PayDunya — Classic, frais au marchand | 3 % + 100 F (nv) | 103 F | 10 F | **−13 F** | Vente déficitaire |
| PayDunya — frais reportés sur le payeur (`support_fees`) | 3 % + 100 F (nv) | 0 F pour le propriétaire | 10 F | 90 F | Mais le client paie **203 F** pour un ticket de 100 F : invendable |
| Flutterwave | non trouvé ; TVA 18 % sur les frais (nv) | inconnu | 10 F | inconnu | — |
| Moneroo | 0,01 USD au-delà de 150 ventes/mois (nv) + frais de la passerelle (inconnus) | inconnu | 10 F | inconnu | Conversion USD→XOF non sourcée ici, donc non calculée |
| LigdiCash | non trouvé (contractuel) | inconnu | 10 F | inconnu | — |
| InTouch | non trouvé | inconnu | 10 F | inconnu | — |
| KkiaPay | sans objet (BF non couvert) | — | — | — | — |

**Lecture.** Avec 10 % de commission, un agrégateur à 3 % laisse 87 F au propriétaire, contre 90 F en théorie. Chaque point de frais coûte 1 F par ticket de 100 F. **Un frais fixe, même modeste, détruit l'économie du ticket à 100 F** : un frais fixe de 25 F laisserait 65 F, et celui de PayDunya (100 F) rend la vente déficitaire. Le premier critère de négociation est donc **zéro frais fixe et un minimum ≤ 100 F**.

### 1.3 Classement pour D2 (agrégateur de lancement)

D2 demande **un** vrai adaptateur en phase 3, celui dont Yacouba fournit les clés de bac à sable. Le classement pèse, dans cet ordre : (1) flux en API directe compatible avec le portail captif (§7.1), (2) ticket à 100 F possible (minimum ≤ 100, pas de frais fixe), (3) sécurité des webhooks et vérification serveur à serveur (Règle 3 du §4), (4) accès rapide à un bac à sable, (5) statut réglementaire au Burkina (important pour le mode A, décisif pour B et C), (6) payout BF (mode B, phase 4).

| Critère | pawaPay | CinetPay | YengaPay | LigdiCash | FedaPay | InTouch | Flutterwave |
|---|---|---|---|---|---|---|---|
| Flux direct Orange + Moov | ++ (nv) | + (SDK oui, BF non testé) | ++ (SDK) | ++ (SDK) | − (redirection) | ? | ± (contradictions) |
| Ticket 100 F possible | ? (minimum exposé par l'API, inconnu) | + (100 XOF, nv) | − ? (exemple à 200) | ? | + ? (100, ancienne doc) | ? | ? |
| Frais connus | Moov 3 % (nv) | 3 % / 4,5 % (nv) | 2,5 % (nv) | ? | 4 % (nv) | ? | ? |
| Webhooks | ++ (signature asymétrique) | ± (v1 jeton ; v2 HMAC) | + (HMAC, sans anti-rejeu) | − (non signé) | ++ (HMAC horodaté, SDK) | ? | − (secret statique) |
| Idempotence | ++ (`DUPLICATE_IGNORED`, nv) | ? | − (payout sans clé) | ? | ? | ? | ? |
| Bac à sable | ++ (sans onboarding, nv) | + (SDK) | + (staging, SDK) | ± (flou) | + (SDK) | − (simulateur en développement) | + (nv) |
| Agrément au BF | ++ (EP.BF.002/2025, nv) | − (CI seulement) | ? | ? | − (Bénin seulement) | ++ (EP.BF.001/2025, nv) | − (Sénégal seulement) |
| Payout BF | ± (Moov probable, Orange non confirmé) | + (min 500, nv) | + (5 opérateurs, SDK) | + (SDK, conditions inconnues) | ? (codes BF non retrouvés) | ? | − (rien pour le BF) |

**Classement proposé (incertitude forte, à réviser après les réponses écrites et les essais en bac à sable) :**

1. **pawaPay (entité locale Kerry Payments Burkina)** — Le seul candidat qui combine, sur le papier, un flux direct conçu exactement comme le §7.2 (OTP Orange transmis par le serveur, PIN Moov poussé), la meilleure sécurité de webhooks (signature RFC 9421 en ECDSA, clés publiques publiées), l'idempotence par identifiant fourni par le marchand, un bac à sable riche (numéros de test qui simulent succès, échec et « jamais de callback », utiles pour P3) et une entité locale qui figure dans la liste BCEAO des établissements de paiement agréés au Burkina. **Incertitudes** : tout vient d'extraits non relus ; frais Orange BF inconnus ; minimum BFA inconnu ; payout Orange BF absent au lancement selon le blog officiel ; les CGU interdisent d'ouvrir un compte pour un tiers, et l'accès d'un petit propriétaire de WiFi Zone à un compte marchand pawaPay (KYC, volume minimum) n'est pas documenté. Or c'est la condition du mode A.
2. **CinetPay** — Le seul à afficher un minimum de 100 XOF cohérent entre plusieurs pages officielles, et un tarif d'environ 3 % sans frais fixe trouvé. Le SDK officiel expose un « paiement direct (sans redirection) » et un bac à sable. **Incertitudes** : cette API v1 n'est décrite sur aucune page de `docs.cinetpay.com` ; le seul exemple `direct_pay` est en Côte d'Ivoire (`OM_CI`) ; le canal pour Orange BF et Moov BF est une déduction ; le webhook v1 ne porte qu'un jeton (pas de HMAC) ; le code d'erreur 606 pourrait refuser deux tickets de 100 F achetés à la suite par le même numéro ; CinetPay Africa est agréé en Côte d'Ivoire, pas au Burkina ; les tarifs se contredisent (3 % ou 4,5 %).
3. **YengaPay (Kreezus)** — Acteur local. Le SDK officiel documente l'API directe pour les cinq portefeuilles burkinabè (Orange, Moov, Coris, Sank, Telecel), le plugin officiel vérifie un HMAC-SHA256, et un environnement de staging existe. **Incertitudes bloquantes** : le minimum par opérateur (l'exemple du README montre 200 F pour Orange, ce qui interdirait le ticket à 100 F), le taux réel (2,5 % vu seulement en extrait), l'absence de clé d'idempotence sur les payouts et un statut BCEAO inconnu.

Suivent, dans l'ordre :

4. **LigdiCash** — Techniquement proche de YengaPay (API sans redirection dans le SDK officiel) et déjà utilisé par un concurrent (Mon-Mikrotik, §1.5 du SPEC), ce qui suggère un onboarding accessible aux petits propriétaires. Recalé à cause des callbacks non signés, d'aucune grille publique, d'une liste blanche IP obligatoire, d'un bac à sable flou, d'un statut BCEAO inconnu et d'un bug dans le SDK JS officiel. Peut remonter à la 2e ou 3e place si les réponses écrites sont bonnes.
5. **FedaPay** — Bons webhooks, frais indicatifs de 4 %, minimum de 100. Mais le paiement sans redirection n'est pas documenté pour le Burkina : il faudrait ouvrir le walled garden à une page hébergée.
6. **InTouch (InTouch Burkina)** — Atout réglementaire réel (établissement de paiement agréé au Burkina, d'après la liste BCEAO vue en extrait), mais la doc publique ne permet pas d'écrire un adaptateur. À traiter **uniquement** par le questionnaire. Remonte fortement si InTouch fournit une API directe Orange/Moov et un bac à sable, surtout pour les modes B et C.
7. **Flutterwave** — Sources officielles contradictoires sur le Burkina, pas de payout BF, webhook à secret statique, ouverture d'un compte par une société burkinabè non documentée.

**Écartés pour le lancement :**

- **PayDunya** : frais fixe publié de 100 FCFA, donc ticket à 100 F déficitaire ; IPN authentifié par un hash statique. Seul intérêt : l'API PER (redistribution), piste pour le mode C.
- **KkiaPay** : Burkina non couvert d'après les sources officielles ; widget JS tiers incompatible avec le §7.1.
- **Moneroo** : orchestrateur non-PSP, redirection seule, couche de frais supplémentaire au-dessus d'une passerelle qu'il faut de toute façon contracter.
- **Wave Business** : incompatible avec le portail captif en v1 (§7). À garder pour **la recharge des crédits des propriétaires** (mode A, hors hotspot), sous réserve de l'ouverture des API au Burkina.

**Recommandation opérationnelle.** Envoyer le questionnaire **en parallèle** à pawaPay, CinetPay, YengaPay, LigdiCash et InTouch. Demander les clés de bac à sable aux trois premiers. Choisir l'adaptateur de phase 3 sur trois tests mesurés en bac à sable : (a) un paiement de 100 F accepté sur Orange BF et sur Moov BF, (b) les frais réellement prélevés sur ce paiement, (c) un webhook dont la signature est vérifiable. Le code reste indépendant du choix grâce à `PaymentProvider` et à `MockProvider` (D2).

---

## 2. Matrices détaillées par prestataire

Chaque ligne indique la valeur et son statut. Les sources sont listées en §8.

### 2.1 pawaPay — entité locale Kerry Payments Burkina

| Critère | Valeur | Statut |
|---|---|---|
| Opérateurs BF | `ORANGE_BFA`, `MOOV_BFA`, en XOF. Pas de Wave, Telecel, Sank ni Coris au BF (Wave seulement en CI et au SN) | non vérifié (extrait de la page Providers v2 + changelog) |
| Flux | Orange : `PREAUTH`, l'OTP généré par le client est passé dans `preAuthorisationCode` (1 à 36 caractères alphanumériques). Moov : `PROVIDER_AUTH`, confirmation par PIN sur le téléphone. Page de paiement hébergée également disponible | non vérifié (extrait) |
| API directe sans redirection | Oui : `POST /v2/deposits` de serveur à serveur ; réponse `ACCEPTED` / `REJECTED` / `DUPLICATE_IGNORED` ; statut par `GET /v2/deposits/{depositId}`. Aucun domaine pawaPay dans le walled garden. Comportement Orange BF sans data : [LABO] | non vérifié (extrait) |
| Code USSD Orange | Non donné dans les extraits ; les instructions client seraient fournies par `active-conf` | non trouvé |
| Payout | API Payouts v2 (unitaire, en masse, remboursements). Moov BF : probable (ligne de frais de décaissement à 2 %). **Orange BF : pas de décaissement au lancement** selon le blog officiel, activation actuelle non confirmée. La colonne « Not supported » de la page Providers concerne les décimales, pas le payout | non vérifié (extraits) |
| Frais d'encaissement | Moov BF, tarif standard : « tiered » 3 % = 2 % MMO + 1 % pawaPay. Orange BF : non trouvé. Plan Standard : 1 % pawaPay + frais MMO refacturés, sans frais d'installation ni mensualité, hors taxes, hausse notifiée un mois avant | non vérifié (extraits de /fees, /plans, CGU) |
| Frais fixe | non trouvé | non trouvé |
| Minimum | Exposé par provider et par opération dans `GET /v2/active-conf` ; valeurs BFA non trouvées. L'exemple « Bénin minAmount 100 / maxAmount 2000000 » n'a pas été retrouvé : il est écarté | non trouvé |
| Coût d'une vente à 100 F | **inconnu**. Indice Moov : 3 F de frais + 10 F de commission, net propriétaire 87 F | non vérifié |
| Bac à sable | `https://api.sandbox.pawapay.io`, jeton Bearer, compte ouvert sans onboarding, numéros de test par pays et par issue (COMPLETED, FAILED, SUBMITTED sans callback) | non vérifié (extrait) |
| Signature des webhooks | Optionnelle, à activer. RFC 9421 (en-têtes `Signature`, `Signature-Input`, `Signature-Date`, `Content-Digest`), `ecdsa-p256-sha256`, clés publiques fournies par un endpoint. Composants signés des callbacks probablement `@status`, `signature-date`, `content-digest` (à relire). Encodage de la signature et règle anti-rejeu : non documentés | non vérifié (extrait) |
| Unités de montant | XOF sans décimales (`decimalsInAmount` = `NONE`) ; montant en chaîne d'unités majeures (« 100 ») à vérifier en bac à sable | non vérifié (extrait) |
| Sous-marchands / split (mode C) | Pas de split natif trouvé. Les CGU contiennent une annexe « sous-marchands » (liste, KYC sous 3 jours ouvrés, approbation de la conformité pawaPay) | non vérifié (extrait) |
| Encaissement pour tiers | CGU : interdiction de créer un compte pour un tiers ou en son nom ; montage plateforme possible seulement avec l'accord écrit de la conformité. Mode B non autorisé par défaut | non vérifié (extrait) |
| Agrément BCEAO | Page officielle « Local Partners » : Kerry Payments = entité locale de traitement, dont une au Burkina. Liste BCEAO au 28/02/2026 : **KERRY Payments Burkina EP.BF.002/2025**. PDF non ouvert, date d'agrément non lue | non vérifié (extraits) |
| Délai de règlement | BF : T+5 (local) / T+7 (transfrontalier) selon un extrait, **contredit** par un autre extrait (T+6 / T+8) ; préfinancement T+2 / T+4 ; jours ouvrés | contradictoire, non vérifié |

### 2.2 CinetPay

| Critère | Valeur | Statut |
|---|---|---|
| Opérateurs BF | SDK v1 : `OM_BF`, `MOOV_BF`, `WAVE_BF`. Le SDK PHP précise que « la présence d'un pays dans l'énumération ne garantit pas qu'un opérateur soit déjà activé sur votre compte ». Doc 1.0 : OMBF et MOOVBF | vérifié (code SDK) pour l'énumération ; activation réelle et Wave BF : non vérifié |
| Flux | Deux API coexistent. **v2** (documentée sur `docs.cinetpay.com`) : `api-checkout.cinetpay.com/v2/payment`, page hébergée (redirection). Orange BF `*144*4*6*100#` « paiement par code OTP » ; Moov BF `*555*6#`, code secret après un SMS push. **v1** (visible seulement dans les SDK GitHub) : `api.cinetpay.co`, JWT via `/v1/oauth/login`, `POST /v1/payment` avec `direct_pay`, `payment_method`, `otp_code` (4 à 6 chiffres), `channel` PUSH / OTP / QRCODE | v1 : vérifié (code SDK) ; v2 et codes USSD : non vérifié (extrait) |
| API directe sans redirection | Annoncée par le README officiel (« Paiement direct (sans redirection) »). **Non vérifié pour OM_BF / MOOV_BF** : seul exemple en `OM_CI`, avec `channel: PUSH` ET un OTP. Le choix « PUSH pour Moov BF » est une déduction | vérifié (code SDK) pour l'existence ; BF : non vérifié, [LABO] |
| Payout | v1 : `POST /v1/transfer`, statut PENDING / SUCCESS, `GET /v1/balances`. Annexe transfert : BF minimum **500**, maximum 1 000 000 XOF. Règle de multiple (5 ou 50) et arrondi (inférieur, plus proche, ou échec) : contradictoires | endpoints : vérifié (code SDK) ; bornes et règles : non vérifié (extrait) |
| Frais d'encaissement | Orange BF et Moov BF 3 % (`cinetpay.com/pricing`) **contre** Orange 4,5 % / Moov 3,5 % (`elixir.cinetpay.com/pricing`). Fourchette « 1,5 % à 3,5 % » selon le volume, généralement HT | non vérifié (extraits contradictoires) |
| Frais de payout | 1,5 % (une page), Moov BF absent (autre page), « frais fixe de 2 % » (FAQ) | contradictoire, non vérifié |
| Frais fixe | Aucun frais fixe en francs trouvé | non trouvé |
| Minimum | 100 XOF pour le BF (tableau des codes : 100 à 1 500 000) ; montant multiple de 5, sinon « the transaction will fail ». Les bornes du SDK (100 à 2 500 000) sont une validation locale, non contractuelle | non vérifié (extraits cohérents entre eux) |
| Coût d'une vente à 100 F | **inconnu** ; indice 3 F, net propriétaire 87 F (voir §1.2) | non vérifié |
| Bac à sable | v1 : `https://api.cinetpay.net`, clés `sk_test_…` ; numéros de test en +225 (CI) uniquement ; aucun numéro BF | vérifié (code SDK) |
| Signature des webhooks | **v2** : en-tête `x-token` = HMAC-SHA256 d'une concaténation de champs `cpm_*` ; liste et ordre contradictoires (FR, EN, page SDK-PHP qui fait `implode($_POST)`). **v1** : pas de HMAC, un `notify_token` rendu à l'initialisation et renvoyé dans le webhook, à comparer en temps constant ; le SDK PHP ignore le statut du webhook et interroge `GET /v1/payment/{id}` ; réponse 200 en moins de 10 s. Anti-rejeu natif : non trouvé (le README conseille de stocker les `transaction_id` traités) | v1 : vérifié (code SDK) ; v2 : non vérifié (extrait) |
| Unités de montant | XOF entier, multiple de 5. Solde rendu en chaîne décimale (« 249711.74 ») : parser sans flottant | vérifié (code SDK) pour l'entier ; multiple de 5 : non vérifié (extrait) |
| Sous-marchands / split (mode C) | Split natif : non trouvé. Les CGU prévoient une offre « marque blanche » permettant à un partenaire d'agréger des marchands et d'encaisser sous ses identifiants, avec des API de reversement pour leur compte. C'est plus proche du mode B que du mode C | non vérifié (extrait des CGU) |
| Encaissement pour tiers | Offre partenaire en marque blanche (voir ci-dessus). Compte marchand réservé à une entreprise établie dans le pays d'encaissement ; « un compte = un pays » | marque blanche : non vérifié (extrait) ; « un compte = un pays » : vérifié (code SDK, README PHP) |
| Agrément BCEAO | Liste BCEAO au 28/02/2026 : **CINETPAY AFRICA EP.CI.007/2025** (Côte d'Ivoire). Absent des établissements de paiement du Burkina. Régime d'exercice au BF : inconnu | non vérifié (extrait) |
| Délai de règlement | 8 jours (CGU, back-office) **contre** 7 jours (tableaux de paliers des mêmes CGU). Cartes : 45 % retenus jusqu'au 181e jour (hors v1) | contradictoire, non vérifié |
| Point de vigilance | Code 606 `INCORRECT_SETTINGS` (Orange) : inclut, selon une reformulation d'extrait, « débit répété pour le même numéro et le même montant sur une courte période ». Deux tickets de 100 F achetés à la suite pourraient être refusés. À citer mot pour mot et à tester en [LABO] | non vérifié (extrait) |

### 2.3 YengaPay (Kreezus)

| Critère | Valeur | Statut |
|---|---|---|
| Opérateurs BF | `ORANGE`, `MOOV`, `CORISM` (Coris Money), `SANKM` (Sank Money), `TELECEL`. Pas de Wave dans le SDK. La liste réelle est renvoyée par `init()` (`availableOperators`) | vérifié (code SDK `@yengapay/nodejs-sdk` 0.1.0) |
| Flux | Orange : ONE_STEP (OTP généré par le client, envoyé avec le numéro dans `pay()`). Moov : TWO_STEP (Push), « No OTP needed - customer approves on their phone ». Coris et Sank : TWO_STEP (OTP), envoyé par SMS via `send-otp`. Telecel : TWO_STEP, détail non documenté. Redirection possible (`payment-intent` → `checkoutPageUrlWithPaymentToken`) | vérifié (code SDK et plugin) |
| API directe sans redirection | Oui : `POST …/direct-payment/init`, `…/send-otp`, `…/pay`, `GET …/direct-payment/status/{id}`, en-tête `x-api-key`. Base `https://api.yengapay.com/api/v1` avec `withEnvironment()`. **Piège** : sans `withEnvironment()`, le constructeur du SDK vise `/api` sans `/v1`. Base canonique à confirmer | vérifié (code SDK), ambiguïté à lever |
| Payout | `POST /groups/{g}/project/{p}/payout` (`ORANGE_MONEY`, `MOOV_MONEY`, `TELECEL_MONEY`, `CORIS_MONEY`, `SANK_MONEY`), `GET …/payout/{id}` (PENDING, PROCESSING, SUCCESS, FAILED, CANCELLED), `POST …/payout/{id}/retry`. **Aucune clé d'idempotence visible** (risque pour P10). Paiement en masse : promis par le README, **absent du code** v0.1.0. Pas de Wave. Statut des payouts par webhook : probablement non (FAQ tronquée) → polling | unitaire : vérifié (code SDK) ; masse : non vérifié ; webhook payout : non vérifié |
| Frais d'encaissement | 2,5 % sur les PayIns, 1,5 % sur les Payouts, « commission par transaction uniquement » | non vérifié (extrait non reproduit) — **ne pas utiliser pour chiffrer D2** |
| Frais fixe | non trouvé | non trouvé |
| Minimum | Renvoyé dynamiquement par opérateur (`minAmount`). Le README montre `minAmount 200` pour Orange BF, **dans un exemple commenté** | non vérifié — risque direct sur le ticket à 100 F |
| Coût d'une vente à 100 F | **inconnu** (taux non confirmé ; le minimum peut dépasser 100 F) | non vérifié |
| Bac à sable | Environnement `staging` : `https://api.staging.yengapay.com/api/v1`. Création automatique d'un projet Sandbox à l'ouverture du compte : non confirmée | staging : vérifié (code SDK) ; sandbox automatique : non vérifié (extrait) |
| Signature des webhooks | HMAC-SHA256 du corps brut avec le « Webhook Secret », en hexadécimal, en-tête `X-Webhook-Hash`, comparaison `hash_equals`. Constaté dans le code du plugin WooCommerce officiel, **pas dans une spécification d'API** ; le README du SDK n'en parle pas. Anti-rejeu : non trouvé. Le plugin officiel désactive la vérification TLS (`sslverify => false`) : **à ne pas reproduire** | vérifié (code du plugin officiel), à confirmer par la doc ou en bac à sable |
| Unités de montant | XOF entier (« Amount in XOF »). Le plugin envoie un `floatval` : ne pas l'imiter | vérifié (code SDK) |
| Sous-marchands / split (mode C) | Modèle groupe → projets ; rien n'indique des projets de marchands tiers ni un partage de paiement | non trouvé |
| Encaissement pour tiers | non trouvé (CGU inaccessibles) | non trouvé |
| Agrément BCEAO | Kreezus / YengaPay n'apparaît pas parmi les 2 établissements de paiement du Burkina ; une absence de la liste EP ne prouve rien (catégories EME, banques, agents) | non trouvé |
| Délai de règlement | Fonds disponibles « en temps réel » sur le compte YengaPay ; virement bancaire 24 à 72 h ouvrées | non vérifié (extrait) |

### 2.4 LigdiCash

| Critère | Valeur | Statut |
|---|---|---|
| Opérateurs BF | Orange Money BF et Moov Africa BF probables. Identifiants 11 / 12, Wave « Sénégal seulement » et l'anomalie de libellé « VODACOM RDC CONGO » : vus en extrait non reproduit. Aucune table d'opérateurs dans les SDK officiels | non vérifié |
| Flux | Le SDK accepte un champ `otp` générique dans `commande.invoice`. Code USSD Orange (`*144*4*6#` sans montant selon un extrait, contre `*144*4*6*MONTANT#` au SPEC §1.3) et mode exact de Moov (push, repli guidé ou OTP SMS, contradictoire) : **le SPEC est conservé jusqu'au labo** | champ `otp` : vérifié (code SDK) ; le reste : non vérifié, [LABO] |
| API directe sans redirection | Oui : `POST https://app.ligdicash.com/pay/v01/straight/checkout-invoice/create` (en-têtes `Apikey` + `Authorization: Bearer`), corps `commande.{invoice, store, actions, custom_data}`. Statut : `GET redirect/checkout-invoice/confirm/?invoiceToken=`. **Bug du SDK JS officiel** : `payWithoutRedirection` appelle `formatPayload(customer, callback_url, null, null, custom_data)`, si bien que `callback_url` se retrouve dans `cancel_url` et que `actions.callback_url` vaut `null`. Écrire l'appel HTTP soi-même | vérifié (code SDK, `src/payin.ts`) |
| Payout | Deux API : vers un wallet LigdiCash (`withdrawal/create`) et vers un numéro mobile money (`straight/payout`, statut `straight/payout/confirm/?payoutToken=`). Erreurs révélatrices : `IpDeniedError` (liste blanche IP), `NoHashError` / `InvalidHashError` (hash exigé, calcul non documenté), `AmountOutOfRangeError`, `MerchantBalanceLowError`, `NoPendProcPayout24HError`, `NoDeposit3MError`. Destinations BF, frais, plafonds : « définis dans votre contrat » ; délai « de quelques secondes à plusieurs jours » | endpoints et erreurs : vérifié (code SDK) ; délais et conditions : non vérifié (extrait) |
| Frais d'encaissement | Négociés avec le Partner Manager avant signature ; aucune grille publique | non trouvé |
| Frais fixe | non trouvé | non trouvé |
| Minimum | Orange 10 XOF, Moov 100 XOF, maximum 2 000 000 XOF : extrait non reproduit, rien dans les SDK | non vérifié [À CONFIRMER] |
| Coût d'une vente à 100 F | **inconnu** ; l'acceptation même d'un ticket à 100 F n'est pas établie | non vérifié, [LABO] |
| Bac à sable | Le SDK déclare `https://test.ligdicash.com/pay/v01/` (JS et Python). La FAQ (extrait) dit au contraire : pas de bac à sable séparé, compte temporaire réel sur `app.ligdicash.com` | URL test : vérifié (code SDK) ; fonctionnement réel : non vérifié |
| Signature des webhooks | Aucune signature documentée. La doc (extrait) dit de ne jamais faire confiance au payload et de re-vérifier par `confirm` avec le jeton **de création**. Champs `hash` et `logfile` dans `custom_data` sans procédure. **Règle de conception** retenue par précaution : le callback n'est qu'un déclencheur, `verify()` fait foi ; P5 ne peut pas reposer sur une signature | non vérifié |
| Unités de montant | XOF entier (`total_amount`, `devise: "xof"`) | vérifié (code SDK) |
| Sous-marchands / split (mode C) | Sous-comptes **par opérateur** à l'intérieur d'un compte marchand ; « chaque projet API demande son propre contrat » ; pas de sous-marchands | non vérifié (extrait) |
| Encaissement pour tiers | non trouvé (CGU inaccessibles) | non trouvé |
| Agrément BCEAO | Ne figure sous ce nom dans aucune liste vue en extrait ; une absence ne prouve rien | non trouvé [À CONFIRMER] par écrit |
| Délai de règlement | Fixé par le contrat de partenariat. La mention « Visa jusqu'à 14 jours » n'a **aucune source** : retirée | non vérifié |
| Exigence d'exploitation | IP des serveurs en liste blanche (au moins pour le payout ; pour le payin à confirmer) : déclarer les 2 VPS (D6) | erreur `IpDeniedError` : vérifié (code SDK) |

### 2.5 FedaPay

| Critère | Valeur | Statut |
|---|---|---|
| Opérateurs BF | Moov, Orange | non vérifié (extrait) |
| Flux | `Transaction.create` → `POST /transactions/{id}/token` → `POST /{mode}` (`sendNowWithToken`) | vérifié (code SDK `fedapay-node`) |
| API directe sans redirection | **Non documentée pour le Burkina.** La liste des opérateurs éligibles n'a pas été reconfirmée (l'ancienne doc v1 dit « MTN seulement »). Pour le BF, on n'a qu'une page hébergée, dont les domaines ne sont pas documentés. À tester en bac à sable | non vérifié |
| Payout | `Payout.create` + `start` (immédiat ou programmé). **Codes BF `orange-bf` / `moov_bf` non retrouvés** : l'extrait actuel ne liste que MTN BJ/CI, Moov BJ/TG, Togocel, « sur demande ». Retrait du solde entre 1 000 et 500 000 XOF | API : vérifié (code SDK) ; BF : non vérifié |
| Frais d'encaissement | 4 % (Moov / Orange BF), page d'environ un an, contredite par d'autres sources. Mesurable par `Transaction.getFees` (`GET /transactions/fees`) | non vérifié (extrait) |
| Frais de payout | Barème 150 à 2 500 XOF : sans source, retiré. Article support : retrait Mobile Money « gratuit » | non vérifié |
| Frais fixe | non trouvé | non trouvé |
| Minimum | 100 XOF (ancienne doc v1) ; plafonds par type de compte sans source | non vérifié |
| Coût d'une vente à 100 F | **inconnu** ; hypothèse 4 F, net propriétaire 86 F | non vérifié |
| Bac à sable | `https://sandbox-api.fedapay.com`, clés `sk_sandbox_…` ; numéros de test BF non trouvés | vérifié (code SDK) |
| Signature des webhooks | En-tête `t=<unix>,s=<hex>`, HMAC-SHA256(secret, `t.corpsBrut`), comparaison en temps constant, tolérance 300 s **sur l'âge seulement** (les horodatages futurs ne sont pas rejetés, la tolérance peut être désactivée) : stocker les identifiants d'événements traités. Nom d'en-tête `X-FEDAPAY-SIGNATURE` : extrait. Vérification serveur : `GET /transactions/{id}` | vérifié (code SDK `Webhook.ts`) ; nom d'en-tête : non vérifié |
| Unités de montant | XOF entier | vérifié (tests du SDK PHP) |
| Sous-marchands / split (mode C) | Compte « Marketplace » (commission plateforme prélevée, reste au vendeur) ; sous-comptes avec split dans l'ancienne doc v1, peut-être obsolète | non vérifié |
| Encaissement pour tiers | Prévu par le compte Marketplace ; texte des CGU non récupéré | non vérifié |
| Agrément BCEAO | FEDAPAY EP.BN.004/2026 sur la liste BCEAO Bénin 2026 (extrait) ; site FedaPay incohérent sur la catégorie (« Établissement de Paiement » / « agrégateur de paiement ») ; rien au Burkina | non vérifié (extrait) |
| Délai de règlement | 72 h avant qu'une transaction approuvée arrive sur la balance ; « 3 jours ouvrés » sans source | 72 h : non vérifié (extraits) |

### 2.6 Flutterwave

| Critère | Valeur | Statut |
|---|---|---|
| Opérateurs BF | Tableau de la page Francophone : BF, XOF, ORANGEMONEY, MOBICASH. **Contredit** par une page de référence (CM, CI, ML, SN) et par le SDK officiel Node v3 (réseaux XOF limités à WAVE, MTN, ORANGEMONEY ; doc des collectes sans le BF) | contradictoire ; SDK : vérifié (code SDK) |
| Flux | `POST /v3/charges?type=mobile_money_franco`, `country`. Orange BF : `authorization_code` obtenu par `*144*4*6*montant*code_secret#` (extrait, contredit le SPEC). Réponse `meta.authorization.mode` = `callback` ou `redirect` | endpoint et `mode: callback` : vérifié (code SDK) ; `authorization_code` et formule : non vérifié |
| API directe sans redirection | **Non confirmée** : le schéma joi du SDK officiel ne déclare pas `authorization_code` et le refuserait | non vérifié, [LABO] |
| Payout | Transferts mobile money XOF : seule la Côte d'Ivoire est listée ; rien pour le Burkina | non trouvé |
| Frais d'encaissement | non trouvé pour le BF ; TVA 18 % sur les frais au BF | non vérifié (extrait) |
| Frais fixe | non trouvé | non trouvé |
| Minimum | « The amount should not be less than 100 » (unité et pays non précisés) | non vérifié |
| Coût d'une vente à 100 F | **inconnu** | — |
| Bac à sable | OTP de test 123456, 5548 = mauvais OTP. « 6648 » : sans source, retiré | non vérifié (extrait) |
| Signature des webhooks | v3 : secret statique renvoyé dans `verif-hash`, pas de HMAC, pas d'anti-rejeu ; schéma d'une version plus récente non vérifié. Vérifier toute transaction par l'endpoint verify | non vérifié (extrait) |
| Unités de montant | non trouvé | non trouvé |
| Sous-marchands / split | Split par sous-comptes existe ; éligibilité XOF/BF et compatibilité `mobile_money_franco` non trouvées | non vérifié (extrait) |
| Encaissement pour tiers | « Payment Facilitators (unless Registered & Licensed) » soumis à pré-approbation (CGU US) ; contrat UEMOA non lu | non vérifié (extrait) |
| Agrément BCEAO | FLUTTERWAVE Sénégal EP.SN.004/2025 (liste au 28/02/2026, extrait) ; rien au BF | non vérifié (extrait) |
| Délai de règlement | « 24 heures » sur une page d'environ 5 ans (périmée) ; seuil de règlement XOF 300 | non vérifié |

### 2.7 InTouch (InTouch Burkina, Touch Pay)

| Critère | Valeur | Statut |
|---|---|---|
| Opérateurs BF | non trouvé (« Orange Money » et « Wave » cités sans pays) | non trouvé |
| Flux | Web Payment : page hébergée (redirection). API Touch Pay : transaction serveur à serveur (`partner_id`, `login_api`, `password_api`, `call_back_url`) ; flux OTP Orange et push Moov non documentés | non vérifié (extrait) |
| API directe sans redirection | Non confirmée pour le BF | non trouvé |
| Payout | « Paiement de masse » ; destinations, frais, plafonds, délais : non trouvés | non trouvé |
| Frais / frais fixe / minimum | non trouvés | non trouvé |
| Coût d'une vente à 100 F | **inconnu** | — |
| Bac à sable | Annoncé ; simulateur du portail développeur « en développement » ; accès après KYA et contrat | non vérifié (extrait) |
| Signature des webhooks | Callback vers `call_back_url` + requête de statut ; statut 300 = échec clos ; algorithme de signature non trouvé | non trouvé |
| Unités / split / encaissement pour tiers / délai | non trouvés | non trouvé |
| Agrément BCEAO | INTOUCH Burkina EP.BF.001/2025 (listes BCEAO 15/09/2025 et 28/02/2026, extraits). Date « 9 mai 2025 » : presse seulement, contredite | numéro : non vérifié (extrait) ; date : non vérifié (tiers) |

### 2.8 PayDunya

| Critère | Valeur | Statut |
|---|---|---|
| Opérateurs BF | Orange Money Burkina, Moov Burkina (SoftPay) ; Wave BF non trouvé | non vérifié (extrait) |
| Flux | Facture `POST /api/v1/checkout-invoice/create`, puis SoftPay. Orange BF : OTP (`*144*4*6*500#` dans l'exemple). Moov BF : la réponse invite le client à composer `*555*6#` ; statut final par IPN ou `confirm/{token}` | non vérifié (extraits) |
| API directe sans redirection | Oui (SoftPay) ; routes BF probablement non testables en sandbox | non vérifié (extrait) |
| Payout | API PUSH `/api/v2/disburse/*`, `orange-money-burkina`, `moov-burkina-faso` ; frais, plafonds, délais non trouvés | non vérifié (extrait) |
| Frais d'encaissement | **3 % + 100 FCFA** : tarif général publié, non spécifique au BF ni aux API ; frais reportables sur le payeur (`support_fees`) ; frais mensuel de 20 000 FCFA dans les CGU, contradictoire | non vérifié (extraits) |
| Frais fixe | 100 FCFA par transaction | non vérifié (extrait) |
| Minimum | non trouvé | non trouvé |
| Coût d'une vente à 100 F | **inconnu** ; au tarif général : 103 F de frais, net propriétaire −13 F ; ou 203 F payés par le client | non vérifié |
| Bac à sable | `sandbox-api/v1/…`, route générique `softpay/checkout/make-payment` | non vérifié (extrait) |
| Signature des webhooks | Champ `hash` = SHA-512 de la master key : **valeur statique**, aucune intégrité du corps, pas d'anti-rejeu. Vérification par `confirm/{token}` obligatoire | non vérifié (extrait) |
| Unités de montant | XOF non décimal (payout) ; montants des factures affichés « 200.00 FCFA » | non vérifié (extrait) |
| Sous-marchands / split (mode C) | API PER (Paiement Et Redistribution) vers d'autres comptes PayDunya, « service non facturé » ; WebPay annonce un partage automatique : meilleure piste concrète de mode C | non vérifié (extrait) |
| Encaissement pour tiers | Cession de compte interdite sans accord écrit ; blocage des fonds jusqu'à 120 jours en cas de fraude ; PER prévu pour les intermédiaires | non vérifié (extrait) |
| Agrément BCEAO | Dunya Digital Payment CI EP.CI.008/2025, Sénégal EP.SN.001/2025 ; rien au BF ; lien avec la marque PayDunya non sourcé | non vérifié (extrait) |
| Délai de règlement | non trouvé | non trouvé |

### 2.9 Moneroo (orchestrateur)

| Critère | Valeur | Statut |
|---|---|---|
| Opérateurs BF | `orange_bf`, `moov_bf`, `mobi_cash_bf` (doc FR) ; Wave BF seulement sur une page marketing ; chaque méthode passe par une passerelle tierce à brancher soi-même | non vérifié (extrait) |
| Flux / API directe | Redirection seule (`POST /v1/payments/initialize` → `checkout_url`). Le SDK officiel PHP n'expose aucun flux direct (`process` = « mark as processed ») | vérifié (code SDK) pour l'absence de flux direct dans le SDK |
| Payout | `POST /v1/payouts/initialize`, `GET /v1/payouts/{id}/verify` ; destinations BF contradictoires (FR / EN) | endpoints : vérifié (code SDK) ; BF : non vérifié |
| Frais | 0,01 USD par paiement réussi (150 gratuits/mois), 0,01 USD par payout (100 gratuits/mois), **plus** les frais de la passerelle sous-jacente (inconnus) | non vérifié (extrait) |
| Minimum / frais fixe passerelle | non trouvés | non trouvé |
| Coût d'une vente à 100 F | **inconnu** | — |
| Bac à sable | Passerelle de test Moneroo ; rétention de 90 jours et code `moneroo_payment_demo` sans source | non vérifié |
| Signature des webhooks | `X-Moneroo-Signature`, HMAC-SHA256 ; encodage, délai d'attente et liste d'événements sans source ; pas d'anti-rejeu documenté | non vérifié (extrait) |
| Unités / split / agrément / délai | `amount` entier (extrait) ; split non trouvé ; se déclare non-PSP ; délai dépendant de la passerelle | non vérifié |

### 2.10 KkiaPay

| Critère | Valeur | Statut |
|---|---|---|
| Opérateurs BF | **Burkina Faso non trouvé** dans les sources officielles | non trouvé |
| Flux / API directe | Widget JS côté client uniquement ; les SDK serveur officiels n'exposent que `verify`, `refund` et `setup_payout` | vérifié (code SDK) |
| Payout | Reversement programmé du solde (`roof` / `rate`) vers un seul destinataire, pas de transfert à la demande | vérifié (code SDK) |
| Frais | Sans objet pour le BF ; grilles d'autres pays contradictoires | non vérifié (extrait) |
| Bac à sable | `https://api-sandbox.kkiapay.me` | vérifié (code SDK) |
| Signature des webhooks | `x-kkiapay-secret` (secret du tableau de bord), schéma indéterminé ; 5 relances | non vérifié (extrait) |
| Agrément BCEAO | OPEN SI EP.BN.002/2025 (Bénin, extrait) ; lien Open SI ↔ KkiaPay non sourcé | non vérifié |

### 2.11 Wave Business API

| Critère | Valeur | Statut |
|---|---|---|
| Opérateurs BF | Portefeuille Wave seulement. Wave opère au BF (CGU : émis par UBA Burkina, en partenariat avec Wave Mobile Money SA). **Ouverture des API Checkout / Payout / Aggregated Merchants aux marchands burkinabè : non confirmée.** Le préfixe de clé `wave_sn_prod_` n'est attesté que par un client tiers | non vérifié |
| Flux | Redirection vers l'appli : `POST /v1/checkout/sessions` → `wave_launch_url` | non vérifié (extrait) |
| API directe sans redirection | **Non** (voir §7) | non vérifié (extrait) |
| Payout | `POST /v1/payout`, clé d'idempotence obligatoire, `receive_amount` net de frais, même pays, portefeuilles Wave seulement ; B2B `fee_payment_method` | non vérifié (extrait) |
| Frais | 20 000 premiers FCFA par jour gratuits, 1 % au-delà (page non datée, sans pays) ; frais API contractuels (« fee structures » par agrégé) | non vérifié (extrait) |
| Minimum / frais fixe | non trouvés | non trouvé |
| Bac à sable | non trouvé | non trouvé |
| Signature des webhooks | `Wave-Signature: t=…,v1=…` (plusieurs `v1` pendant une rotation), HMAC-SHA256(secret, horodatage + corps brut), rejet au-delà de 5 min. Existence possible d'un second mode (secret en Bearer) : à relire | non vérifié (extrait) |
| Unités de montant | Chaînes d'entiers XOF, sans décimales | non vérifié (extrait) |
| Sous-marchands | Aggregated Merchants (identité et frais propres, réservé à certaines entreprises) ; fonds sur le portefeuille de l'agrégateur, donc variante du mode B, pas un mode C | non vérifié (extrait) |
| Agrément | UBA Burkina, émetteur de monnaie électronique (CGU Wave BF, extrait) | non vérifié (extrait) |

### 2.12 Côté opérateurs (pour l'affichage du portail, §7.2)

| Sujet | Orange Money BF | Moov Money BF |
|---|---|---|
| Flux | Pré-OTP USSD : `*144*4*6*montant#` (orange.bf, extrait ; CinetPay `*144*4*6*100#`). Variantes contradictoires : `*144*4*6#` (LigdiCash, e-Timbres orange.bf), `*144*4*6*montant*code_secret#` (Flutterwave). **Le SPEC §1.3 est conservé jusqu'au test sur SIM réelle** | Push : `*555*6#`, code secret après réception du SMS push (CinetPay, PayDunya) ; repli exact contradictoire chez LigdiCash |
| Longueur de l'OTP | Le « code à 6 chiffres » du SPEC §1.3 n'est sourcé nulle part ; le SDK CinetPay accepte 4 à 6 chiffres, pawaPay 1 à 36 caractères | — |
| Validité de l'OTP | non publiée par orange.bf ; tiers : 3 min et 30 min (contradictoires) | délai d'expiration du push non documenté |
| Minimum opérateur | La grille de **frais client** de 2018 (« biens et services » de 500 à 500 000 F gratuits) n'est **pas** un minimum d'achat ; minimum réel inconnu | non trouvé |
| API marchande directe | Orange Developer « OM Web Payment » ne listerait pas le Burkina (extrait) : accès par agrégateur | aucune API publique trouvée : accès par agrégateur |
| Statut | tout : non vérifié (extraits d'agrégateurs, officiels pour eux mais tiers vis-à-vis de l'opérateur), [LABO] | idem |

---

## 3. Écarts constatés avec le SPEC (§1.3 et §1.4)

| # | SPEC | Constat | Statut |
|---|---|---|---|
| E1 | LigdiCash : « facture → redirection → callback » | Le SDK officiel propose aussi un payin **sans redirection** | vérifié (code SDK) |
| E2 | Orange BF : `*144*4*6*MONTANT#`, code à 6 chiffres | Syntaxe confirmée par orange.bf et CinetPay (extraits), contredite par LigdiCash et Flutterwave ; longueur de l'OTP non sourcée | non vérifié, [LABO] |
| E3 | YengaPay « annonce aussi Telecel, Sank, Coris » | Confirmé par le SDK officiel ; pas de Wave | vérifié (code SDK) |
| E4 | CinetPay Burkina : 1,5 à 3,5 % ; minimum non trouvé | Fourchette retrouvée, mais une page concurrente donne 4,5 % pour Orange BF ; minimum de 100 XOF + multiple de 5 (extraits cohérents) ; CinetPay a deux API distinctes (v2 hébergée, v1 directe) ; `WAVE_BF` dans le SDK | non vérifié (extraits) / SDK vérifié |
| E5 | Wave : problème de data | Plus grave : la doc Checkout dit que `wave_launch_url` échoue dans une webview intégrée, ce qu'est le mini-navigateur de portail captif | non vérifié (extrait) |
| E6 | pawaPay : Orange + Moov | Confirmé ; Orange en PREAUTH, Moov en PROVIDER_AUTH ; **Kerry Payments Burkina, l'un des 2 EP agréés au BF, est l'entité locale de pawaPay** | non vérifié (extraits) |
| E7 | FedaPay : Moov, Orange | Confirmé, mais flux sans redirection non documenté pour le BF | non vérifié (extrait) |
| E8 | KkiaPay annonce le Burkina | Non trouvé dans les sources officielles | non trouvé |
| E9 | Flutterwave : Orange, Mobicash | Contredit par le SDK officiel et une page de référence | contradictoire |
| E10 | Moneroo : orchestrateur | Confirmé ; se déclare non-PSP ; liste aussi `mobi_cash_bf` | non vérifié (extrait) |
| E11 | §1.4 : 34 EP, 2 au BF au 31/08/2026 ; « vérifiés le 10/11/2026 » | Aucun texte BCEAO lu directement ; les deux noms BF ne sont attestés que pour la liste au 28/02/2026 ; voir `docs/CONFORMITE.md` | non vérifiable |
| E12 | §1.4 : PI-SPI « rail futur ; hors v1 » | Selon des sources secondaires, PI-SPI est **obligatoire depuis le 02/11/2026** pour les transactions de monnaie électronique interopérables ; Wave en serait absent | non vérifié (tiers) |
| E13 | §16 : Payfonte cité pour le pré-OTP Orange | Page d'exemples non retrouvée ; Payfonte se contredit sur le flux Orange BF ; non évalué comme candidat | non vérifié |

---

## 4. Risques

| # | Risque | Probabilité | Impact | Atténuation |
|---|---|---|---|---|
| R1 | Le minimum réel d'un agrégateur dépasse 100 F (exemple YengaPay à 200) | moyenne | élevé : le produit phare n'est plus vendable en ligne | Exiger par écrit un minimum ≤ 100 F ; tester un paiement de 100 F en bac à sable avant de choisir |
| R2 | Frais fixe par transaction | moyenne | élevé (PayDunya : vente déficitaire) | Clause « zéro frais fixe » ; écarter tout prestataire qui l'impose |
| R3 | Frais réels supérieurs aux indices (3 % vs 4,5 %, TVA 18 % en plus) | élevée | moyen : 1 à 2 F par ticket | Grille TTC écrite, par opérateur ; mesurer avec l'API de frais quand elle existe |
| R4 | Webhook falsifiable (LigdiCash non signé ; secrets statiques PayDunya, Flutterwave, CinetPay v1) | élevée | élevé : ticket sans paiement | Règle 3 du §4 : `verify()` serveur à serveur avant tout ticket, pour **tous** les adaptateurs ; dédoublonnage par identifiant d'événement |
| R5 | Rejeu des webhooks (aucun anti-rejeu, ou fenêtre partielle chez FedaPay) | moyenne | moyen | Table des événements traités (§10.1), idempotence du grand livre (P1) |
| R6 | Refus d'un second achat identique (CinetPay 606, « débit répété ») | inconnue | moyen : clients bloqués | [LABO] ; message clair au portail ; question écrite |
| R7 | Ambiguïté sur le code USSD Orange | moyenne | moyen : échecs de paiement | Test sur SIM réelle ; texte du portail paramétrable par adaptateur |
| R8 | Mode B pratiqué sans autorisation (encaissement pour tiers) | — | **critique** (réglementaire) | Mode B désactivé en production tant que `docs/CONFORMITE.md` n'a pas l'accord écrit et l'avis juridique (D1) |
| R9 | Petits propriétaires incapables d'ouvrir un compte marchand (KYC, société exigée, « un compte = un pays ») | élevée | élevé pour le mode A | Question écrite ; contrat-cadre plateforme avec onboarding simplifié des propriétaires |
| R10 | Payout BF indisponible ou non idempotent (Orange pawaPay, YengaPay sans clé) | moyenne | élevé en mode B (P10) | `verifyPayout()` avant toute relance ; ne jamais utiliser un `retry` aveugle |
| R11 | Blocage ou retard des fonds (7 à 8 jours CinetPay, 120 jours de blocage possible PayDunya) | moyenne | moyen (trésorerie des propriétaires) | Délai de règlement contractuel ; afficher le délai au propriétaire |
| R12 | Dépendance à un seul agrégateur ; panne (P8) | moyenne | élevé | `PaymentProvider` multi-adaptateurs ; RADIUS indépendant de l'agrégateur (Règle 1) ; second adaptateur après la phase 3 |
| R13 | Bugs des SDK officiels (LigdiCash JS, TLS désactivé dans le plugin YengaPay, base `/api` sans `/v1`) | avérée | moyen | Appels HTTP écrits à la main dans `packages/payments/`, tests contre le bac à sable |
| R14 | Changement de règles par PI-SPI depuis le 02/11/2026 (frais, interopérabilité) | inconnue | moyen | Question écrite ; veille réglementaire dans `docs/CONFORMITE.md` |
| R15 | Liste blanche IP (LigdiCash) et 2 nœuds (D6) | avérée | faible | Déclarer les IP des 2 VPS dès l'onboarding ; tester depuis le nœud B |

---

## 5. Coût total de possession (TCO) et points à négocier

### 5.1 Formule de TCO, par propriétaire et par mois

```
Coût agrégateur = Σ ventes × (taux d'encaissement TTC) + N_ventes × frais fixe
                + (mode B) Σ reversements × taux de payout + N_reversements × frais fixe de payout
                + abonnement éventuel + coût de trésorerie (délai de règlement)
Net propriétaire (mode A) = Σ ventes − coût agrégateur − commission WAKATNET (10 %)
```

Illustration, **avec des taux hypothétiques non vérifiés** : 1 000 tickets de 100 F par mois (100 000 F).

| Hypothèse | Frais agrégateur | Commission WAKATNET | Net propriétaire |
|---|---|---|---|
| 0 % (borne théorique) | 0 F | 10 000 F | 90 000 F |
| 3 % HT sans frais fixe | 3 000 F | 10 000 F | 87 000 F |
| 3 % + TVA 18 % sur les frais | 3 540 F | 10 000 F | 86 460 F |
| 4,5 % sans frais fixe | 4 500 F | 10 000 F | 85 500 F |
| 3 % + 25 F de frais fixe (exemple de sensibilité) | 28 000 F | 10 000 F | 62 000 F |
| 3 % + 100 F de frais fixe (grille générale PayDunya) | 103 000 F | 10 000 F | −13 000 F |

Coûts hors frais à intégrer à la décision D2 : temps d'intégration (un adaptateur bien documenté avec bac à sable contre une doc à reconstituer), coût d'exploitation (liste blanche IP, rotation des secrets, rapprochement quotidien en mode B), coût du risque (webhooks non signés, statut réglementaire inconnu).

### 5.2 Leviers de négociation

1. **Zéro frais fixe** par transaction, encaissement comme payout. C'est non négociable pour le ticket à 100 F.
2. **Minimum ≤ 100 F** confirmé par écrit, pour Orange BF et Moov BF.
3. **Grille TTC écrite**, par opérateur, avec la règle d'arrondi d'un frais fractionnaire (2,5 F sur 100 F ?) et l'indication de qui paie (marchand ou client).
4. **Tarif plateforme agrégé** : WAKATNET apporte le volume cumulé de tous les propriétaires. Demander que la grille dégressive s'applique au volume total de la plateforme, même en mode A où chaque propriétaire a son propre compte (contrat-cadre partenaire).
5. **Onboarding simplifié des propriétaires** apportés par la plateforme (liste des pièces, délai, personne physique ou société).
6. **Bac à sable complet pour le Burkina** (numéros de test +226, simulation d'un OTP Orange, d'un push Moov, d'un webhook tardif ou absent).
7. **Webhooks signés** par message (HMAC du corps + horodatage), liste d'IP sources, politique de relance.
8. **Idempotence** côté prestataire (clé fournie par le marchand) sur l'encaissement et le payout.
9. **Délai de règlement court** (cible J+1) et absence de seuil minimal de règlement pénalisant.
10. **Préavis de hausse de tarif** d'au moins 30 jours (pawaPay l'annonce déjà) et clause de sortie sans pénalité.
11. **Pas d'abonnement mensuel** (vérifier les 20 000 FCFA/mois des CGU PayDunya), pas de frais d'installation.
12. **Accord écrit sur le mode B ou C** (marque blanche CinetPay, annexe sous-marchands pawaPay, PER PayDunya), avec le statut réglementaire sous lequel il s'exerce au Burkina.
13. **Engagement de disponibilité** et page d'état, cohérents avec l'objectif de 99,9 % de la plateforme (même si l'authentification RADIUS n'en dépend pas).

---

## 6. Conséquences pour `packages/payments/` (déjà actées, quel que soit D2)

- `verify()` fait foi pour **tous** les adaptateurs. `parseWebhook()` vérifie la signature quand elle existe ; quand il n'y en a pas (LigdiCash) ou qu'elle est statique, le webhook n'est qu'un déclencheur de `verify()`, et P5 se teste sur la vérification du jeton ou du secret disponible.
- Normalisation des montants XOF par adaptateur, avec un test (entier, chaîne d'entier, refus des décimales, multiple de 5 chez CinetPay).
- `capabilities().minAmount` lu dynamiquement quand l'API l'expose (pawaPay `active-conf`, YengaPay `init()`), jamais codé en dur.
- Appels HTTP écrits à la main (bugs constatés dans les SDK officiels) ; TLS toujours vérifié.
- Identifiant d'événement unique et corps brut conservés (`payment_event`), conformément au §10.1.

---

## 7. Wave depuis un hotspot non authentifié

**Le problème.** Le seul flux documenté par Wave Business est une redirection vers l'application : l'API crée une session Checkout et renvoie un `wave_launch_url`, qui ouvre l'appli Wave (ou affiche des instructions si elle n'est pas installée). Le client valide le paiement **dans l'appli**. Aucun flux USSD ni push serveur n'a été trouvé.

Trois obstacles s'additionnent :

1. **La data.** Le client est sur un hotspot qui ne l'a pas encore authentifié. L'appli Wave doit joindre ses serveurs : sans data mobile, elle ne le peut pas, sauf à ouvrir ses domaines dans le walled garden.
2. **La webview.** D'après un extrait de la doc Checkout, `wave_launch_url` doit être ouverte dans le navigateur de l'utilisateur ; ouverte dans une webview intégrée, la redirection vers Wave échoue. Or le mini-navigateur de portail captif d'iOS et d'Android (CNA) est précisément une webview restreinte. C'est plus grave que la seule question de la data relevée au §1.3 du SPEC.
3. **Le walled garden.** Ouvrir les domaines et IP de l'appli Wave est contraire au §7.1 (une seule entrée si possible, jamais de joker large) ; la liste n'est pas documentée, elle peut changer, et elle peut ouvrir un accès gratuit à d'autres services.

À cela s'ajoutent : l'ouverture des API Wave aux marchands burkinabè n'est pas confirmée ; aucun bac à sable n'a été trouvé ; Wave serait absent de PI-SPI (presse, non vérifié).

**Pistes à tester en [LABO], dans cet ordre :**

1. Le client a de la data mobile : désactiver le Wi-Fi n'est pas acceptable ; vérifier si l'appli Wave utilise la data mobile alors que le téléphone est associé au hotspot (comportement Android / iOS différent).
2. Lien « ouvrir dans le navigateur » depuis le CNA vers une page de paiement servie par la plateforme, puis `wave_launch_url` depuis le vrai navigateur.
3. Session d'essai très bridée via `login-by=trial` limitée aux domaines Wave (attention aux abus par MAC aléatoire, §11).
4. Entrées précises de walled garden pour l'appli, mesurées par capture réseau, documentées et tenues à jour depuis la plateforme.

**Conclusion.** Wave n'est **pas** proposé sur le portail en v1 tant que le [LABO] n'est pas concluant (§7.2, §11 « Garantir un paiement Wave à un téléphone qui n'a pas Internet »). Wave reste un bon candidat pour la **recharge des crédits des propriétaires** en mode A (hors hotspot, depuis un téléphone qui a de la data), sous réserve de l'ouverture des API au Burkina. Un client Wave peut aussi acheter un **ticket papier** auprès d'un vendeur.

---

## 8. Sources

Toutes consultées (ou tentées) le 10/11/2026. « officiel » = domaine de l'éditeur ; le statut de lecture est indiqué.

**Lues directement (code officiel)**
- LigdiCash : https://github.com/Ligdicash/ligdicash-javascript (`src/defaults.ts`, `src/payin.ts`, `src/payout.ts`, `src/providers.ts`, `src/errors.ts`, README), https://github.com/Ligdicash/ligdicash-php, https://github.com/Ligdicash/ligdicash-python, https://github.com/Ligdicash/ligdicash-dart
- YengaPay : https://registry.npmjs.org/@yengapay/nodejs-sdk/-/nodejs-sdk-0.1.0.tgz (README, `index.js`, `lib/types.d.ts`) ; https://github.com/kreezus/wordpress-yengapay (`includes/class-wc-yengapay-gateway.php`) ; https://github.com/kreezus/prestashop-yengapay
- CinetPay : https://github.com/cinetpay/cinetpay-js, https://github.com/cinetpay/cinetpay-php-sdk (également cités : cinetpay-python, cinetpay-mcp)
- FedaPay : https://github.com/fedapay/fedapay-node (commit cdc4f71 : `Webhook.ts`, `Requestor.ts`, `Transaction.ts`, `Payout.ts`), https://github.com/fedapay/fedapay-php (commit c96ba2d)
- KkiaPay : https://github.com/kkiapay/nodejs-sdk (commit 0c7ee9e), https://github.com/kkiapay/php-sdk (commit 39ebb35)
- Moneroo : https://github.com/MonerooHQ/moneroo-php (commit 04ce1d8)
- Flutterwave : https://github.com/Flutterwave/Flutterwave-node-v3 (commit 537f9f4 : `services/schema/create.js`, `documentation/collections.md`, `services/mobile-money/rave.francophone.js`)

**Vues seulement en extrait de moteur de recherche (pages non chargées)**
- pawaPay : https://docs.pawapay.io/v2/docs/providers, …/api-reference/deposits/initiate-deposit, …/deposits/check-deposit-status, …/toolkit/active-configuration, …/docs/upgrade_from_v1, …/docs/payouts, …/docs/signatures, https://docs.pawapay.io/v1/api-reference/toolkit/public-keys, …/v2/docs/test_numbers, https://www.pawapay.io/fees, /plans, /settlement-timelines, /merchant-terms-of-service, /local-partners, /gaming-fees, https://pawapay.io/blog/pawapay-live-in-burkina-faso
- CinetPay : https://docs.cinetpay.com/api/1.0-fr/checkout/initialisation, …/1.0-en/checkout/hmac, …/1.0-fr/checkout/notification, …/1.0-en/checkout/tableau, …/1.0-fr/transfert/utilisation, …/1.0-en/transfert/annexe, …/1.0-en/airtime/utilisation, …/1.0-fr/BO/finance, …/1.0-en/sdk/php, https://cinetpay.com/pricing, https://elixir.cinetpay.com/pricing, https://cinetpay.com/legal/cgu-services, https://cinetpay.com/products/mass-payout
- YengaPay : https://yengapay.com/, https://yengapay.com/aggregation-paiement, https://yengapay.com/paiement-en-masse
- LigdiCash : https://developers.ligdicash.com/api-paiement/payin-sans-redirect/operateurs/orange-burkina, …/moov-burkina, …/modes-validation, …/reference/operateurs-supportes, …/api-paiement/callback/payload-payin, …/api1/callback, …/api-paiement/payout/vers-mobile-money, …/concepts/compte-marchand, …/concepts/environnements, …/en/resources/faq, …/en/guides/production-checklist
- PayDunya : https://developers.paydunya.com/doc/FR/softpay, …/EN/sandbox_softpay, …/EN/http_json, …/En/php, …/EN/api_deboursement, …/EN/dmp, …/EN/psr_plugins/api_psr, https://paydunya.com/faq, https://paydunya.com/how-it-works, https://paydunya.com/webpay, https://paydunya.com/terms-of-service, https://ecommerce.paydunya.com/pricing (page du produit « Social Shop »)
- InTouch : https://developers.intouchgroup.net/documentation, https://en.intouchgroup.net/touch-pay-api/, https://www.intouchgroup.net/en/solutions/paiement-en-ligne, https://www.intouchgroup.net/en/solutions/api-intouch
- FedaPay : https://docs.fedapay.com/payment-methods/en/payment-methods-en, …/integration-api/fr/collects-management-fr, …/integration-api/en/payouts-management-en, …/integration-api/en/webhooks-en, …/fr/introduction/compte, …/dashboard/en/funds-en, https://docs-v1.fedapay.com/sub-accounts, https://docs-v1.fedapay.com/compte/votre-compte, https://docs-v1.fedapay.com/payments/payment-methods, https://www.fedapay.com/tarifications/, https://support.fedapay.com (article tarification)
- KkiaPay : https://docs.kkiapay.me/v1/paiements/methodes-de-paiement, …/v1/en-1.0.0/tableau-de-bord/webhook, https://kkiapay.me/pricing/?lang=en
- Moneroo : https://docs.moneroo.io/fr/payments/methodes-disponibles, …/fr/payments/integration-standard, …/introduction/webhooks, …/payments/testing, …/payouts/initialize-payout, https://moneroo.io/en/pricing, /payment, /coverage, /terms
- Flutterwave : https://developer.flutterwave.com/docs/francophone, …/reference/charge-via-francophone-mobile-money, …/docs/webhooks, …/docs/testing, …/docs/mobile-money, …/docs/split-payments, https://flutterwave.com/us/support/pricing/value-added-tax-vat-for-flutterwave-merchants, https://flutterwave.com/ci/support/payments/minimum-settlement-threshold, https://flutterwave.com/us/terms
- Wave : https://docs.wave.com/checkout, /payout, /b2b/payout/index.html, /webhook, /aggregated-merchants, /balance-api, https://www.wave.com/fr/business/, https://www.wave.com/fr/terms_uba_bf/
- Opérateurs : https://www.orange.bf/fr/assistance/assistance-acheter-en-ligne.html, …/assistance-paiement-boutique-en-ligne.html, https://www.orange.bf/fr/tarifs-orange-money.html, https://developer.orange.com/apis/om-webpay, https://moov-africa.bf/moov-money-particuliers/, https://docs.payfonte.com/en/guides/introductions/supported-providers, https://docs.payfonte.com/fr/guides/introductions/faq
- BCEAO : voir `docs/CONFORMITE.md` §4

**Tierces (indices seulement, aucune valeur reprise comme fait)**
- https://kolonell.com/fr/blog/ligdicash-burkina-faso-paiement-orange-moov-ouagadougou-2026, https://kolonell.com/fr/blog/cinetpay-integration-tarifs-commissions-cote-ivoire-2026, https://kreezus.notion.site/DOCUMENTATION-API-YENGAPAY-KREEZUS-e9de95e48d504110aa048261a200292a, https://kreezus.com/blog/agregateurs-paiement-burkina-faso, https://github.com/diddifreecmr-droid/diddi-pay-backend/pull/1, LinkedIn (repost pawaPay sur l'agrément de Kerry Payments), https://packagist.org/packages/andydefer/laravel-pawapay, https://launchbaseafrica.com/2025/05/30/flutterwave-intouch-licensed-but-most-waemu-fintechs-still-frozen/, https://leconomistedufaso.com/2025/07/09/paiement-digital-intouch-burkina-entre-dans-la-cour-des-grands/, https://alldotpy.github.io/EasySwitch/integrations/fedapay, https://moneroo.io/en/coverage (pour KkiaPay), https://fr.wikipedia.org/wiki/KKiaPay, https://github.com/api-evangelist/wave-mobile-money, https://github.com/flrxnt/wave-api-client, https://www.sonatur.org/wp-content/uploads/procedure-orange-money.pdf, https://campusfaso.bf/memoOrangeMoney.pdf, https://boldrails.com/payments/moov-money-api, https://github.com/mzeba/bf-mobilemoney

---

## 9. Sources inaccessibles depuis ce conteneur (le 10/11/2026)

À rouvrir directement, soit par Yacouba depuis son poste, soit après autorisation des domaines dans le réseau de la session :

| Domaine | Erreur constatée |
|---|---|
| `developers.ligdicash.com`, `ligdicash.com`, `app.ligdicash.com` | proxy 403 / DNS refusé (ENOTFOUND) |
| `yengapay.com` (dont `/docs`), `api.yengapay.com`, `checkout.yengapay.com` | 403 / ENOTFOUND |
| `kreezus.com`, `kreezus.notion.site` | 403 |
| `gitlab.com/kreezus/yengapay` (source du SDK) | dépôt privé (404) |
| `docs.cinetpay.com`, `cinetpay.com`, `elixir.cinetpay.com` | ENOTFOUND / pas de réponse |
| `developers.paydunya.com`, `paydunya.com`, `ecommerce.paydunya.com` | ENOTFOUND / pas de réponse |
| `github.com/paydunya/*` | aucun SDK officiel trouvé (dépôts inexistants ou privés) |
| `docs.pawapay.io`, `www.pawapay.io`, `pawapay.io` | ENOTFOUND / 403 |
| `developers.intouchgroup.net`, `intouchgroup.net` | ENOTFOUND / 403 |
| `docs.fedapay.com`, `www.fedapay.com`, `support.fedapay.com`, `fedapay.mintlify.app`, `docs-v1.fedapay.com` | ENOTFOUND |
| `docs.kkiapay.me`, `kkiapay.me` | ENOTFOUND |
| `docs.moneroo.io`, `moneroo.io`, `api.moneroo.io` | ENOTFOUND / 403 |
| `developer.flutterwave.com`, `flutterwave.com` | ENOTFOUND / 403 |
| dépôts `MonerooHQ/docs`, `Flutterwave/Flutterwave-Docs` | inexistants ou privés |
| `docs.wave.com`, `www.wave.com` | ENOTFOUND / 403 |
| `www.orange.bf`, `developer.orange.com`, `moov-africa.bf` | 403 / non tenté après blocage |
| `docs.payfonte.com` | 403 ; page d'exemples du §16 du SPEC non retrouvée |
| `www.bceao.int`, `bceao.int`, `downloads.bceao.int`, `www.cb-umoa.org` | 403 / ENOTFOUND |
| API GitHub au niveau organisation (`gh api orgs/…`) | bloquée dans la session (les clones directs ont fonctionné) |

Par ailleurs, le quota de recherche web a été épuisé pendant la contre-vérification de Flutterwave, Moneroo, Wave et des opérateurs : ces entrées n'ont pas pu être recontrôlées par une nouvelle recherche.
