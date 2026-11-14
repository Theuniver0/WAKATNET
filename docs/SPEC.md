# MEGA PROMPT — WAKATNET
### SaaS RADIUS hotspot MikroTik multi-propriétaires · paiement Mobile Money · commission plateforme

> À donner tel quel à Claude Code (fichier joint ou texte collé), dans un dépôt Git vide dédié. La mise en place, les skills à employer et les commandes que Yacouba tape lui-même sont au §14.
> Version 1.4 — 10 novembre 2026. Nom du produit : **WAKATNET** ; identifiants techniques en minuscules (`wakatnet`).
> Les faits du §1 ont été vérifiés le 10/11/2026 (sources au §16). **[LABO]** = à prouver en laboratoire avant de s'en servir. **[À CONFIRMER]** = dépend d'un tiers (agrégateur, juriste, comptable) : ne jamais le supposer acquis.

---

## 0. RÔLE

Tu es l'**architecte et lead technique** de **WAKATNET**, une plateforme SaaS de Telecom Universel (Ouagadougou, Burkina Faso). Des propriétaires de WiFi Zone y raccordent leurs routeurs MikroTik, vendent leurs forfaits par Mobile Money depuis le portail captif, et Telecom Universel perçoit une commission sur chaque vente.

Le nom vient du mooré « wakato », le temps : la plateforme vend du temps de connexion. Garde cette idée dans les textes du portail et du tableau de bord. Le mot « RADIUS » n'apparaît jamais devant un propriétaire ni devant son client ; il reste dans les noms techniques.

Tu travailles pour Yacouba, ingénieur réseau certifié MTCINE, développeur (TypeScript/Node, Python, Go) et lui-même exploitant de WiFi Zones. Il relira tes scripts RouterOS et ta configuration FreeRADIUS ligne par ligne : ne lui explique pas RADIUS, justifie tes choix.

Tu produis **des fichiers et des procédures testées** que Yacouba exécute lui-même. Tu ne te connectes à aucun serveur ni routeur de production. Tu ne dis jamais qu'une étape fonctionne sans preuve (sortie de test, log `radiusd -X`, capture d'écran).

Deux exigences passent avant toute fonctionnalité, parce que la plateforme porte le chiffre d'affaires d'autres entreprises :

1. **L'authentification ne tombe pas.** Une panne coupe les ventes de tous les propriétaires en même temps.
2. **Les comptes sont exacts au franc près et reconstructibles.** Un écart dans le grand livre, c'est un litige avec un client.

---

## 1. FAITS ÉTABLIS (ne pas rediscuter ; vérifier, et signaler tout écart)

### 1.1 RouterOS 7 — doc officielle `manual.mikrotik.com`, version 7.25

| Sujet | Fait |
|---|---|
| Client `/radius` | `service=hotspot` ; `timeout` par défaut 1100 ms ; `src-address` ; `protocol` = `udp` ou `radsec` ; **l'ordre des entrées compte** (serveur 1, puis 2). |
| Message-Authenticator | Depuis la 7.15, RouterOS l'ajoute à tous ses messages RADIUS sauf l'accounting, et `require-message-auth` vaut `yes-for-request-resp` par défaut : si le serveur ne le renvoie pas dans Access-Accept / Reject, le login échoue. |
| `/radius incoming` | Désactivé par défaut (`accept=no`). Port par défaut **1700** d'après la doc officielle (des docs tierces annoncent 3799) : fixer le port explicitement des deux côtés. Disconnect-Message pris en charge. Un CoA peut changer `Mikrotik-Rate-Limit`, `Session-Timeout`, `Idle-Timeout`, `Port-Limit`, `Mikrotik-Group`, `Mikrotik-Recv-Limit` / `Mikrotik-Xmit-Limit` ; pas l'adresse IP ni le pool. |
| Attributs Access-Accept (hotspot) | `Session-Timeout`, `Idle-Timeout`, `Port-Limit` (remplace `shared-users`), `Mikrotik-Rate-Limit` (prioritaire sur les autres limites de débit), `Mikrotik-Recv-Limit` / `Mikrotik-Xmit-Limit` + Gigawords, `Mikrotik-Group`, `Acct-Interim-Interval` (pris en compte seulement si `radius-interim-update=received`), `WISPr-Session-Terminate-Time`. |
| `Mikrotik-Total-Limit` | Présent dans le dictionnaire, absent de la section Access-Accept de la doc 7.25 → **[LABO]** avant usage. |
| Méthode d'auth hotspot → RADIUS | CHAP par défaut, PAP possible, pas de MS-CHAP. CHAP impose au serveur de connaître le mot de passe en clair. |
| Access-Request | Contient `NAS-Identifier` (identity du routeur), `NAS-IP-Address`, `Calling-Station-Id` (MAC du client), `Called-Station-Id` (nom du serveur hotspot), `Framed-IP-Address`, `Mikrotik-Host-IP`, `WISPr-Location-ID` / `-Name`. |
| Accounting | Start / Interim-Update / Stop, octets + gigawords, `Acct-Session-Time`, `Acct-Terminate-Cause`. Sens entrée / sortie (vu du client ou du routeur) → **[LABO]** : piège classique d'inversion upload / download. |
| Hotspot | `login-by` : `cookie`, `http-chap`, `http-pap`, `https`, `mac`, `mac-cookie`, `trial`. `radius-interim-update` vaut `received` par défaut. Walled garden HTTP/HTTPS par `dst-host`, `walled-garden ip` pour le reste. Le hotspot sait annoncer le portail captif aux clients (RFC 7710 : `user-portal-url`, `seconds-remaining`, `can-extend-session`…). **Fiable en IPv4 uniquement.** |
| RadSec | Disponible (TCP 2083, certificats, secret forcé à `radsec`). Régression signalée par des tiers depuis la 7.15 → pas en v1. |
| Utilisateurs locaux et RADIUS | Hypothèse : avec `use-radius=yes`, la base locale est consultée avant RADIUS → **[LABO]**. Si c'est vrai, les tickets Mikhmon déjà vendus restent valides pendant la migration. |
| `mac-cookie` avec RADIUS | Reconnexion automatique d'un appareil déjà connu : comportement exact face à un serveur RADIUS → **[LABO]**. |

### 1.2 FreeRADIUS

- Branche retenue : **3.2.x** (3.2.8 vue comme dernière version le 10/11/2026, **[À CONFIRMER]** le jour de l'installation). Pas de v4.
- La table `nas` n'est lue qu'au démarrage. Pour ajouter un routeur sans redémarrer : **clients dynamiques** (`raddb/sites-available/dynamic-clients`). Au premier paquet d'une IP inconnue appartenant à un réseau déclaré, FreeRADIUS interroge SQL, puis garde le client en cache pendant `lifetime`.
- BlastRADIUS (CVE-2024-3596) : réglages `require_message_authenticator` et `limit_proxy_state` depuis la 3.2.5. Depuis la 3.2.6, les clients dynamiques héritent de ces réglages depuis leur bloc `client`, et la valeur `auto` ne s'applique pas aux clients « wildcard » → écrire `yes` explicitement.

### 1.3 Mobile Money au Burkina Faso

| Sujet | Fait |
|---|---|
| Orange Money BF | Flux « pré-OTP » : le client compose `*144*4*6*MONTANT#`, obtient un code à 6 chiffres, le saisit sur la page de paiement. Fonctionne sans data. |
| Moov Money BF | Confirmation par code secret après une notification poussée (la doc CinetPay cite `*555*6#`). |
| Wave | API Business : sessions Checkout (URL de lancement de l'appli), Payout, webhooks signés HMAC-SHA256, « Aggregated Merchants » pour les plateformes. Le paiement se valide dans l'appli Wave, donc **avec de la data** : depuis un hotspot non authentifié, c'est un problème → **[LABO]**. |
| Agrégateurs annonçant le Burkina | LigdiCash (local ; Orange + Moov ; facture → redirection → callback ; payout), CinetPay (Orange BF, Moov BF, cartes ; API de transfert), PayDunya, InTouch, YengaPay (local ; annonce aussi Telecel, Sank, Coris), pawaPay (Orange + Moov), FedaPay (Moov, Orange), KkiaPay, Moneroo (orchestrateur), Flutterwave (Orange, Mobicash). **Chaque nom est à revérifier dans sa doc officielle en phase 0.** |
| Frais publics | CinetPay Burkina : 1,5 à 3,5 % à l'encaissement selon le volume, 1,5 % au transfert. Montant minimum par transaction et frais fixes : non trouvés → **[À CONFIRMER]**. |
| Monnaie | XOF, sans décimales. Certains fournisseurs raisonnent en « unités mineures » : normaliser dans chaque adaptateur, avec un test. |

Grille de référence des WiFi Zones de Telecom Universel, à reprendre comme données de démonstration : 100 F (3 h ou 5 h), 200 F (6 h), 300 F (1 jour), 500 F (3 jours), 1 000 F (7 jours). **Le ticket à 100 F est le plus vendu** : chaque franc de frais compte, et un frais fixe par transaction rendrait la vente en ligne non rentable.

### 1.4 Cadre réglementaire

- Instruction BCEAO n°001-01-2024 du 23 janvier 2024 : fournir des services de paiement dans l'UMOA exige un agrément.
- Liste BCEAO des établissements de paiement agréés au 31 août 2026 : 34 dans l'Union, **2 au Burkina (InTouch Burkina, Kerry Payments Burkina)**. CinetPay Africa est agréé en Côte d'Ivoire ; Dunya Digital Payment (raison sociale associée à PayDunya, à confirmer) en Côte d'Ivoire et au Sénégal ; FedaPay et Open SI (éditeur de KkiaPay) au Bénin ; Flutterwave au Sénégal.
- LigdiCash ne figure pas sous ce nom dans cette liste. Elle ne couvre que la catégorie « établissement de paiement », pas les banques ni les émetteurs de monnaie électronique : son statut est donc à lui demander par écrit → **[À CONFIRMER]**.
- Conséquence pour la conception : encaisser sur le compte de Telecom Universel l'argent destiné aux propriétaires, puis le leur reverser, ressemble à un service de paiement réglementé (lecture d'ingénieur, pas un avis juridique). Le code ne doit pas supposer que ce montage est autorisé (voir D1 au §3, et §8).
- PI-SPI, la plateforme de paiement instantané interopérable de la BCEAO, est ouverte depuis le 30/09/2025 (175 participants autorisés au 30/09/2026). Rail futur possible (QR interopérable) ; hors v1.

### 1.5 Concurrence (ce que chaque plateforme annonce sur son site)

| Plateforme | Positionnement | Commission |
|---|---|---|
| Mana Zone | Burkina ; « Mode Serveur Distant » sur FreeRADIUS + mode import de tickets ; Orange / Moov ; programme partenaire à 2 % pendant 1 an | **10 %** au Burkina, 13 % ailleurs |
| Mon-Mikrotik | Mikhmon en ligne ; Orange / Moov via LigdiCash ; revendeurs | **10 %** |
| MonWifiZone | Paiement Wave ; gestion MikroTik à distance | **10 %** |
| MaZoneWifi | « Paiements directs (BYOG) » ; VPN WireGuard ; bot de vente WhatsApp | **5 à 8 %**, sans abonnement |
| Ticket WiFi Zone | Import des tickets générés sur le routeur ; 20+ pays | **15 %** |

Le produit n'est donc pas une première. Il doit gagner sur ce que ces offres ne prouvent pas : disponibilité mesurée, contrôle en temps réel (CoA), comptes transparents et vérifiables, migration depuis Mikhmon sans coupure, support par un expert MikroTik local.

---

## 2. PRODUIT

### 2.1 Acteurs

| Acteur | Rôle |
|---|---|
| Super-admin | Telecom Universel : voit tout, fixe les commissions, suspend, rapproche les comptes. |
| Propriétaire | Client de la plateforme (« tenant ») : un ou plusieurs sites, routeurs, forfaits. |
| Gérant / vendeur | Sous-compte d'un propriétaire, rattaché à un point de vente : génère et vend des tickets, voit ses propres ventes. |
| Client final | Achète un forfait sur le portail captif, ou un ticket papier. Aucun compte à créer. |

### 2.2 Les cinq parcours qui doivent être irréprochables

1. **Raccorder un routeur.** Le propriétaire crée son compte, déclare un site, colle UNE commande dans le terminal RouterOS. Cinq minutes. Son hotspot existant continue de fonctionner pendant et après.
2. **Créer ses forfaits.** Prix, durée, débit, volume, nombre d'appareils.
3. **Acheter sur place.** Le client se connecte au Wi-Fi, choisit un forfait, paie en Orange Money ou Moov Money, et se retrouve connecté sans ressaisir de code.
4. **Vendre en espèces.** Le propriétaire génère des lots de tickets, les imprime, les répartit par point de vente et suit leur activation.
5. **Suivre l'argent.** Le propriétaire voit ses ventes et son solde en temps réel ; Telecom Universel voit sa commission, par propriétaire, au franc près.

### 2.3 Hors périmètre v1 (à prévoir dans le modèle, à ne pas coder)

PPPoE · RouterOS 6 · autres marques (Omada, UniFi) · application mobile native · PI-SPI / QR · cartes bancaires · bot WhatsApp · itinérance entre propriétaires · hotspot IPv6.

---

## 3. DÉCISIONS

Avance avec la valeur par défaut. Les lignes marquées « Yacouba » lui sont soumises à la porte G0 (§12) ; n'attends pas sa réponse pour coder ce qui n'en dépend pas.

| ID | Décision | Défaut pour avancer | Qui tranche |
|---|---|---|---|
| D1 | **Circuit de l'argent.** Mode A « encaissement direct » : chaque propriétaire branche son propre compte marchand, la plateforme ne touche jamais son argent, la commission est prélevée sur un solde de crédits qu'il a prépayé. Mode B « collecte centralisée » : compte marchand de Telecom Universel, grand livre, reversements. Mode C « répartition par le prestataire agréé » : sous-marchands ou split natif, si un agrégateur le propose. | Le code gère A et B via `settlement_mode` par propriétaire. **B reste désactivé en production** tant que `docs/CONFORMITE.md` ne contient pas l'accord écrit de l'agrégateur et un avis juridique. C = ticket R&D. | Yacouba |
| D2 | Agrégateur de lancement | Interface `PaymentProvider` + `MockProvider` ; UN vrai adaptateur en phase 3, celui dont Yacouba fournit les clés de bac à sable. | Yacouba |
| D3 | Commission | `commission_bps` par propriétaire, défaut 1000 (10 %, niveau du marché). Frais de l'agrégateur à la charge du propriétaire. | Yacouba |
| D4 | Tickets vendus en espèces | Sans règle, un propriétaire peut tout vendre en espèces et ne jamais payer de commission. Prévoir un frais par activation de ticket hors ligne (`offline_fee_bps`), prélevé sur le solde de crédits. Défaut 0 tant que Yacouba n'a pas tranché. | Yacouba |
| D5 | Versions RouterOS | **≥ 7.15** (WireGuard + Message-Authenticator). RouterOS 6 hors v1. | Yacouba |
| D6 | Hébergement | 2 VPS Linux (Debian stable) chez 2 hébergeurs différents, IP fixes, un nom de domaine. | Yacouba |
| D7 | Chemin critique | WireGuard (noyau Linux), FreeRADIUS et PostgreSQL installés nativement (systemd) sur chaque nœud, sans CHR intermédiaire. API, worker, portail et tableaux de bord en conteneurs. Moins de couches sur le chemin d'authentification. | Toi (ADR) |
| D8 | Plage de l'overlay | `10.213.0.0/16`, un /32 par routeur, paramétrable. Éviter `100.64.0.0/10` (CGNAT de Starlink et des opérateurs) et les plages hotspot courantes. | Toi (ADR) |
| D9 | Identité du client final | Aucune inscription. Numéro du payeur uniquement. Pas de SMS en v1. | Yacouba |
| D10 | Stack applicative | La même que NetManager : React 18 / Vite / TypeScript, Fastify / Node.js, PostgreSQL / Prisma, BullMQ / Redis. Si le dépôt NetManager est accessible, inventorie ce qui est réutilisable (adaptateurs LigdiCash / CinetPay / PayDunya, mécaniques d'expiration, import Mikhmon) avant d'écrire du neuf. | Toi |

---

## 4. ARCHITECTURE

```text
Client Wi-Fi ──► MikroTik du propriétaire (hotspot, RouterOS ≥ 7.15)
                    │  WireGuard : 2 pairs (nœud A, nœud B)
                    ▼
   ┌───────────── Nœud A ─────────────┐        ┌───────────── Nœud B ─────────────┐
   │ wg0 · FreeRADIUS · PostgreSQL     │◄──────►│ wg0 · FreeRADIUS · PostgreSQL     │
   │ (primaire)                        │ réplic.│ (réplique)                        │
   │ API · worker · Redis · portail    │        │ prêt à reprendre                  │
   └───────────────┬───────────────────┘        └───────────────────────────────────┘
                   │ HTTPS (API, webhooks)
                   ▼
          Agrégateur(s) Mobile Money
```

| Composant | Rôle |
|---|---|
| `radius` | FreeRADIUS 3.2.x. Authentifie, autorise, reçoit l'accounting. |
| `db` | PostgreSQL. Schémas `app` (Prisma), `radius` (fonctions SQL), `ledger` (grand livre). |
| `wg-agent` | Tient les pairs WireGuard du nœud alignés sur la base, sans redémarrer l'interface. |
| `api` | Fastify : API REST, enrôlement, webhooks de paiement. |
| `worker` | BullMQ : rapprochement des paiements, reversements, CoA / Disconnect, nettoyage des sessions, santé des routeurs, alertes. |
| `portal` | Portail captif (rendu serveur, très léger). |
| `dashboard` | React : espace propriétaire et super-admin. |

**Règle 1 — le chemin critique est court.** Routeur → WireGuard → FreeRADIUS → PostgreSQL local. Rien d'autre : pas de Node, pas de Redis, pas d'appel HTTP. Si l'API, le worker ou l'agrégateur tombent, les tickets déjà vendus continuent d'authentifier. Toute la décision d'accès vit dans des fonctions SQL versionnées et testées.

**Règle 2 — l'accounting ne bloque jamais l'authentification.** Accounting découplé : FreeRADIUS écrit dans un fichier `detail`, un lecteur le rejoue vers PostgreSQL. Une base lente ne doit pas provoquer de retransmissions en cascade, et l'échec d'une écriture ne doit jamais transformer un Access-Accept en rejet.

**Règle 3 — l'argent ne dépend jamais du navigateur.** Seul un webhook signé ou un appel de vérification de serveur à serveur fait passer un paiement à « réussi ».

**Règle 4 — cloisonnement.** Un propriétaire ne voit ni ne touche les données d'un autre : `tenant_id` partout, Row Level Security PostgreSQL en défense en profondeur, tests d'isolement automatisés.

**Règle 5 — une seule horloge.** L'heure de référence est celle de PostgreSQL (`now()`), jamais celle du routeur, qui peut être fausse après une coupure de courant.

---

## 5. RADIUS : LOGIQUE D'ACCÈS

### 5.1 Identifier le routeur

- Le routeur est identifié par son **IP source dans le tunnel** (son /32). `AllowedIPs` rend cette adresse non usurpable ; `src-address` est forcé dans `/radius`.
- Un seul bloc de clients dynamiques couvre l'overlay. Secret RADIUS **unique par routeur**. `require_message_authenticator = yes`. `lifetime` court (300 s).
- Révocation : supprimer le pair WireGuard (effet immédiat) **et** désactiver le routeur en base (effet à l'expiration du cache).
- FreeRADIUS se connecte à PostgreSQL avec un rôle qui ne peut qu'exécuter les fonctions `radius.*` (`SECURITY DEFINER`), sans accès direct aux tables : un nœud RADIUS compromis ne peut pas lire le grand livre.

### 5.2 Fonctions SQL (schéma `radius`)

| Fonction | Contrat |
|---|---|
| `radius.client_lookup(src_ip)` | Renvoie secret et nom court du routeur actif, ou rien. |
| `radius.authorize(username, src_ip, calling_station_id, called_station_id)` | **Lecture seule.** Renvoie les attributs de contrôle et de réponse, ou un refus avec une cause codée dans `Reply-Message` : `ticket_inconnu`, `expire`, `epuise`, `mauvais_site`, `trop_d_appareils`, `proprietaire_suspendu`, `trop_de_tentatives`. |
| `radius.post_auth(...)` | Journalise chaque tentative (anti-bruteforce, support). |
| `radius.acct_start / acct_interim / acct_stop(...)` | **Idempotentes** (clé : routeur + `Acct-Session-Id`). Le ticket est activé au premier Start. Compteurs de temps et de volume mis à jour par différence, jamais par addition aveugle. |
| `radius.acct_on_off(src_ip)` | Ferme les sessions ouvertes du routeur. Ne pas en dépendre : un nettoyage par délai existe aussi (§5.4). |

### 5.3 Forfaits : dimensions combinables

| Dimension | Sens |
|---|---|
| `uptime_limit` | Temps consommé ; se met en pause quand le client se déconnecte. |
| `validity` | Fenêtre continue à partir de la première connexion. |
| `data_limit` | Volume total. |
| `expires_at` | Date limite absolue (lot de tickets périmé). |
| `rate_limit` | Chaîne `Mikrotik-Rate-Limit`, sens routeur : rx = upload du client, tx = download du client. |
| `devices` | Appareils simultanés (`Port-Limit`). |
| `bind_mac` | Lie le ticket au premier appareil. |
| `scope` | Valable sur un site, ou sur tous les routeurs du propriétaire. |

`Session-Timeout` = min(temps restant, fin de validité − maintenant, expiration absolue − maintenant). Les limites de volume envoyées sont les restes à consommer, recalculés à chaque login. Le ticket porte une **copie figée** du forfait : modifier un forfait ne change pas les tickets déjà vendus.

### 5.4 Sessions

- Appareils simultanés : `Port-Limit` côté routeur **et** contrôle côté serveur (sessions ouvertes), pour couvrir l'usage d'un ticket sur plusieurs routeurs.
- Sessions fantômes : fermées d'office sans Interim depuis 3 intervalles. Les coupures de courant sont fréquentes : le redémarrage d'un routeur ne doit ni bloquer la reconnexion du client, ni lui faire perdre du temps consommé non comptabilisé.
- Reconnexion sans friction par `mac-cookie`. Les adresses MAC aléatoires existent (iOS, Android) : la MAC n'est jamais la seule clé d'accès, le code du ticket reste utilisable.
- CoA / Disconnect émis par le worker depuis l'IP overlay du nœud, avec le secret du routeur : suspension, remboursement, changement de débit. Test de bout en bout obligatoire sur CHR.

### 5.5 Résistance à la devinette

Codes de ticket d'au moins 8 caractères dans un alphabet de 32 symboles sans ambiguïté (ni 0/O, ni 1/I/L), soit environ 10^12 combinaisons. Limitation des échecs par MAC et par routeur dans `authorize`, avec alerte.

### 5.6 Matrice de tests minimale (`radclient` + dictionnaire MikroTik, puis CHR)

| # | Scénario | Attendu |
|---|---|---|
| T1 | Ticket inconnu | Reject `ticket_inconnu` |
| T2 | Ticket neuf, première connexion | Accept ; `Session-Timeout` exact ; activation à l'Accounting-Start |
| T3 | Forfait 1 h de temps consommé, reconnexion après 20 min d'usage | `Session-Timeout` = 2400 |
| T4 | Forfait « validité 5 h », activé depuis 5 h 01 | Reject `expire` |
| T5 | Deuxième appareil sur un ticket à 1 appareil | Refus |
| T6 | Ticket du propriétaire A présenté sur un routeur de B | Reject, tentative journalisée |
| T7 | Accounting-Stop reçu deux fois | Compteurs inchangés au second |
| T8 | Routeur redémarré sans Stop | Sessions fermées au délai ; reconnexion possible |
| T9 | Disconnect-Request sur une session active (CHR) | Session coupée, Stop reçu |
| T10 | Access-Request sans Message-Authenticator | Ignoré |
| T11 | 10 échecs en 1 minute depuis une même MAC | Limitation + alerte |
| T12 | Forfait 1 Go, 900 Mo consommés | Limite restante de 100 Mo envoyée |
| T13 | PostgreSQL primaire arrêté, nœud B sur sa réplique | Les tickets déjà vendus authentifient toujours |

Objectifs de performance, à mesurer et non à promettre : p95 de `authorize` < 50 ms côté serveur ; 200 authentifications par seconde sur un nœud à 4 vCPU.

---

## 6. RÉSEAU : OVERLAY WIREGUARD ET ENRÔLEMENT

### 6.1 Overlay

- Une interface `wg0` par nœud. Nœud A = `10.213.0.1`, nœud B = `10.213.0.2`. Un /32 par routeur.
- `AllowedIPs` du pair = son /32, rien de plus. Aucun transfert `wg0 → wg0` (nftables) : deux propriétaires ne se voient jamais.
- Routeur → nœud : UDP 1812 / 1813 et ICMP. Nœud → routeur : UDP 3799 et ICMP. Rien d'autre sans consentement explicite du propriétaire.
- `persistent-keepalive=25s` : le routeur est presque toujours derrière un NAT ou un CGNAT (Starlink, 4G), et le nœud doit pouvoir le joindre pour le CoA.
- Points de terminaison par IP fixe, pas de nom DNS dynamique sur le chemin critique.
- La base est la source de vérité des pairs ; `wg-agent` réconcilie ajouts et suppressions sans redémarrer l'interface.

### 6.2 Enrôlement en une commande

Le propriétaire clique « Ajouter un routeur » et reçoit une commande à coller, valable 30 minutes, à usage unique :

```routeros
/tool fetch url="https://api.DOMAINE/enroll/JETON" check-certificate=yes dst-path=wakatnet-enroll.rsc
/import file-name=wakatnet-enroll.rsc
```

Avant ces deux lignes, la commande en porte une par racine TLS de l'API (ISRG Root X1 et X2) : elle l'importe si son empreinte est absente, car RouterOS n'a pas de magasin de racines intégré avant la 7.19 (décision de Yacouba du 14/11/2026, ADR 0003). Ces certificats sont marqués par leur **nom** (`wakatnet racine …`), RouterOS ne leur donnant pas de commentaire ; la désinstallation les retire.

- **Étape 1 (script).** Vérifie la version (≥ 7.15), détecte un conflit avec la plage overlay, crée l'interface WireGuard — la clé privée est générée sur le routeur et n'en sort jamais —, puis envoie à l'API : clé publique, identity, modèle, version, noms des serveurs hotspot.
- **Étape 2 (réponse).** Pairs, adresse, routes, deux entrées `/radius`, `/radius incoming`, règles de pare-feu, profil hotspot, walled garden, `login.html`.
- **Étape 3 (entretien).** Les changements ultérieurs (walled garden, `login.html`, ajout d'un nœud) passent par un script planifié qui tire une configuration versionnée. Il ne touche qu'aux objets marqués `wakatnet`, et le propriétaire peut le désactiver.

Exigences du script, non négociables parce qu'il s'exécute sur le routeur de production d'un tiers :

1. **Idempotent** : le rejouer ne casse rien et ne duplique rien.
2. **Additif** : ne supprime et ne réordonne aucun objet existant. Chaque objet créé porte `comment="wakatnet"`.
3. **Anti-lockout** : ne touche jamais aux accès d'administration ; les règles de pare-feu ajoutées n'ouvrent que le strict nécessaire, depuis l'interface du tunnel.
4. **Activation en dernier** : `use-radius=yes` n'est posé qu'après vérification du tunnel (handshake récent + ping des deux nœuds). Sinon le script s'arrête avec un message clair et laisse le hotspot dans son état d'origine.
5. **Réversible** : un `wakatnet-uninstall.rsc` retire tout ce qui porte le commentaire et restaure le profil hotspot.
6. **Téléchargement authentifié** : vérification du certificat TLS par `/tool fetch` (magasin de confiance de RouterOS ou import préalable de la racine) → **[LABO]**. À défaut, afficher l'empreinte SHA-256 du script dans le tableau de bord.
7. **Conventions** : chemin de commande complet, `comment=` en français sur chaque objet, idiome `[find ...]` pour toute modification, aucun secret réel dans les fichiers versionnés.

Forme attendue du résultat sur le routeur (illustratif, à valider sur CHR) :

```routeros
# --- Tunnel vers la plateforme (clé privée générée localement) ---
/interface wireguard
add name=wg-wakatnet listen-port=13231 mtu=1420 comment="wakatnet"
/interface wireguard peers
add interface=wg-wakatnet public-key="CLE_PUBLIQUE_NOEUD_A" \
    endpoint-address=IP_FIXE_NOEUD_A endpoint-port=51820 \
    allowed-address=10.213.0.1/32 persistent-keepalive=25s \
    comment="wakatnet noeud A"
add interface=wg-wakatnet public-key="CLE_PUBLIQUE_NOEUD_B" \
    endpoint-address=IP_FIXE_NOEUD_B endpoint-port=51820 \
    allowed-address=10.213.0.2/32 persistent-keepalive=25s \
    comment="wakatnet noeud B"
/ip address
add address=10.213.X.Y/32 interface=wg-wakatnet comment="wakatnet"
/ip route
add dst-address=10.213.0.1/32 gateway=wg-wakatnet comment="wakatnet noeud A"
add dst-address=10.213.0.2/32 gateway=wg-wakatnet comment="wakatnet noeud B"

# --- Client RADIUS : l'ordre fait la priorité (A, puis B) ---
/radius
add service=hotspot address=10.213.0.1 src-address=10.213.X.Y \
    secret="SECRET_UNIQUE_DU_ROUTEUR" timeout=3s \
    require-message-auth=yes-for-request-resp comment="wakatnet noeud A"
add service=hotspot address=10.213.0.2 src-address=10.213.X.Y \
    secret="SECRET_UNIQUE_DU_ROUTEUR" timeout=3s \
    require-message-auth=yes-for-request-resp comment="wakatnet noeud B"
/radius incoming
set accept=yes port=3799

# --- Portail joignable avant authentification (IP fixe dédiée) ---
/ip hotspot walled-garden ip
add action=accept dst-address=IP_FIXE_PORTAIL protocol=tcp dst-port=443 \
    comment="wakatnet portail"

# --- Activation, en dernier ---
/ip hotspot profile
set [find name="PROFIL_EXISTANT"] use-radius=yes radius-accounting=yes \
    radius-interim-update=5m login-by=http-chap,http-pap,mac-cookie
```

La valeur de `timeout` se règle en labo avec de la latence et de la perte injectées (profil Starlink et 4G) : trop courte, elle provoque de fausses bascules ; trop longue, elle fait attendre le client quand le nœud A est réellement tombé.

### 6.3 Migration douce depuis Mikhmon

Si le **[LABO]** du §1.1 confirme que la base locale est consultée avant RADIUS, les tickets locaux déjà vendus restent valides après l'enrôlement. Propose alors au propriétaire d'importer ses tickets non utilisés (export Mikhmon ou CSV) pour les suivre dans la plateforme. Dans le cas contraire, l'import devient une étape obligatoire avant l'activation.

---

## 7. PORTAIL CAPTIF ET PAIEMENT

### 7.1 Contraintes du portail

- Il s'ouvre dans les mini-navigateurs de portail captif d'iOS et d'Android, sur des téléphones d'entrée de gamme, à faible débit : HTML rendu côté serveur, moins de 100 Ko au total, **aucune dépendance externe** (ni CDN, ni polices, ni scripts tiers : ils ne sont pas dans le walled garden), pas de popup, pas de nouvel onglet.
- Il est servi depuis une IP fixe dédiée, qui doit rester si possible la seule entrée du walled garden. Préfère les flux en API directe (code USSD + OTP, validation poussée) qui gardent le client sur le portail. Si un agrégateur n'offre qu'une page de paiement hébergée, la liste exacte de ses domaines est ajoutée au walled garden, documentée, testée et tenue à jour depuis la plateforme : jamais de joker large.
- Français par défaut, textes courts, gros boutons.
- Sur le routeur, `login.html` est une minuscule page de redirection vers le portail. Elle transmet au minimum `$(mac)`, `$(ip)`, `$(link-login-only)`, `$(link-orig)`, `$(error)` et l'identifiant public du site. Liste complète des variables et règles d'échappement : section de personnalisation des pages dans la doc hotspot.
- Les causes de refus du §5.2 remontent au portail par `$(error)` et y deviennent des messages utiles (« Forfait terminé — en racheter un ») → **[LABO]**.

### 7.2 Parcours d'achat

1. Le portail propose « J'ai un ticket » et « Acheter un forfait ».
2. Choix du forfait, puis de l'opérateur :
   - **Orange Money** : afficher le code `*144*4*6*MONTANT#` (copiable ; lien `tel:` en amélioration progressive → **[LABO]**), puis demander le numéro et le code reçu.
   - **Moov Money** : numéro, puis attente de la validation sur le téléphone.
   - **Wave** : proposé seulement si le **[LABO]** est concluant. Pistes : entrées de walled garden pour l'appli, ou session d'essai très bridée via `trial` (attention aux abus par MAC aléatoire).
3. L'API crée le paiement (`PENDING`) et appelle `provider.charge()`. Le portail interroge l'état toutes les 3 s, pendant 3 min au plus.
4. À la confirmation, dans **une seule transaction SQL** : écritures du grand livre + création du ticket + lien paiement ↔ ticket.
5. Auto-connexion : renvoi du navigateur vers `link-login-only` avec le code du ticket. Préférer une redirection GET à un formulaire POST d'une page HTTPS vers une cible HTTP, que certains navigateurs signalent comme non sécurisé → **[LABO]** sur Chrome Android et Safari iOS, dans et hors du mini-navigateur.

États d'un paiement : `CREATED → PENDING → SUCCEEDED | FAILED | EXPIRED`, plus `MISMATCH` (montant ou devise inattendus) et `REFUNDED`. Transitions idempotentes ; un paiement `SUCCEEDED` ne peut plus devenir que `REFUNDED`.

Cas à traiter explicitement :

- **Page fermée pendant `PENDING`** (le client est parti composer son code USSD). À son retour, le portail retrouve le paiement et propose le ticket. La récupération ne repose jamais sur la seule MAC, visible de tous sur un Wi-Fi ouvert : exiger aussi le numéro du payeur ou un jeton stocké sur l'appareil.
- **Webhook tardif ou perdu.** Une tâche de rapprochement appelle `provider.verify()` pour tout paiement `PENDING` depuis plus de 2 min, puis toutes les 5 min pendant 24 h.
- **Succès après `EXPIRED`.** Le ticket est créé quand même, et l'événement journalisé.

Deux invariants : jamais de ticket sans paiement confirmé de serveur à serveur ; jamais de paiement confirmé sans ticket ou remboursement tracé.

Piste **[LABO]** : utiliser l'annonce RFC 7710 du hotspot pour afficher le temps restant et un lien « prolonger » dans l'interface système du téléphone.

### 7.3 Interface fournisseur

```ts
interface PaymentProvider {
  readonly id: string;
  capabilities(): {
    operators: Operator[];
    flows: Array<'ussd_otp' | 'push' | 'redirect'>;
    payout: boolean;
    minAmount: number;                                     // XOF, entier
  };
  charge(req: ChargeRequest): Promise<ChargeResult>;       // idempotent sur req.reference
  verify(reference: string): Promise<PaymentStatus>;       // fait foi
  parseWebhook(headers: Headers, rawBody: Buffer): WebhookEvent; // vérifie la signature, lève sinon
  payout?(req: PayoutRequest): Promise<PayoutResult>;      // idempotent sur req.reference
  verifyPayout?(reference: string): Promise<PayoutStatus>;
}
```

- `MockProvider` scriptable : succès, échec, lenteur, webhook en double, webhook avant la réponse de `charge()`, webhook jamais reçu, montant différent.
- En mode A, les appels utilisent les clés du propriétaire, et ses webhooks arrivent sur une URL qui lui est propre.
- **Ne devine jamais l'API d'un agrégateur.** Lis sa doc officielle ; si elle est inaccessible ou ambiguë, arrête-toi et demande à Yacouba la doc ou les clés du bac à sable.

### 7.4 Matrice de tests paiement

| # | Scénario | Attendu |
|---|---|---|
| P1 | Même webhook reçu 5 fois | Un seul ticket, un seul jeu d'écritures |
| P2 | Webhook reçu avant la réponse de `charge()` | Traité correctement |
| P3 | Webhook jamais reçu | Ticket créé par le rapprochement en moins de 5 min |
| P4 | Montant du webhook ≠ montant attendu | `MISMATCH`, pas de ticket, alerte |
| P5 | Signature invalide | 401, aucun effet |
| P6 | Page fermée pendant `PENDING` | Ticket proposé au retour |
| P7 | Succès après `EXPIRED` | Ticket créé, journalisé |
| P8 | Agrégateur en panne | Message clair ; tickets existants et RADIUS intacts |
| P9 | Double soumission du formulaire | Un seul paiement |
| P10 | Coupure réseau pendant un reversement | Pas de double envoi : `verifyPayout()` avant toute relance |

### 7.5 Tickets papier

- Génération par lot et par point de vente ; export PDF imprimable (plusieurs tickets par page A4) ; états : généré, remis au vendeur, activé, expiré.
- Statistiques par point de vente et par vendeur.
- Import des tickets existants (export Mikhmon, CSV).

---

## 8. ARGENT : GRAND LIVRE, COMMISSION, REVERSEMENTS

### 8.1 Grand livre

- Partie double, **en ajout seul** : ni `UPDATE` ni `DELETE` ; une correction est une contre-écriture.
- Montants en `BIGINT`, XOF entiers. Aucun flottant, nulle part.
- Chaque écriture porte l'objet métier concerné (paiement, reversement, frais, ajustement), une clé d'idempotence unique et le taux de commission appliqué, figé au moment de la vente.
- Commission = `montant × commission_bps / 10000`, arrondie au franc le plus proche (0,5 arrondi au franc supérieur), avec minimum optionnel. Règle testée sur 100, 150, 200, 300, 500 et 1 000 F.

### 8.2 Mode A — encaissement direct

- L'argent du client arrive sur le compte marchand du propriétaire. La plateforme ne le détient jamais.
- La commission est débitée d'un **solde de crédits** que le propriétaire recharge par Mobile Money auprès de Telecom Universel : c'est une vente de service de Telecom Universel, pas de l'argent de tiers.
- Alerte quand le solde passe sous 20 % du dernier rechargement. À zéro, la vente en ligne est suspendue après un délai de grâce paramétrable ; les tickets déjà vendus restent valides.
- Les clés API du propriétaire sont chiffrées au repos et ne sont plus jamais affichées après leur saisie.

### 8.3 Mode B — collecte centralisée (désactivé tant que D1 n'est pas levée)

- À chaque vente : compte de compensation de l'agrégateur → dette envers le propriétaire (net) + produit de commission + frais.
- Reversements automatiques (seuil ou calendrier) via `payout()`, idempotents, avec un état « en transit » ; plafond par opération et double validation au-dessus d'un seuil.
- Rapprochement quotidien entre le solde chez l'agrégateur et le grand livre. Tout écart non nul déclenche une alerte et gèle les reversements.

### 8.4 Invariants (tests de propriétés)

- Σ débits = Σ crédits, par transaction et globalement.
- Solde d'un propriétaire = ventes nettes − reversements ± ajustements.
- Aucun paiement compté deux fois, quel que soit le nombre de webhooks reçus.
- Rejouer tout le journal reconstruit exactement les soldes.

### 8.5 Restitution

- Relevé par propriétaire (jour, mois), export CSV et PDF.
- Facture mensuelle de commission. Mentions fiscales burkinabè et imputation SYSCOHADA → **[À CONFIRMER]** avec le comptable.
- Procédure de litige et de remboursement, avec ses écritures.

---

## 9. MODÈLE DE DONNÉES (tables minimales)

| Domaine | Tables |
|---|---|
| Comptes | `tenant`, `tenant_user` (rôles), `point_of_sale` |
| Réseau | `site`, `router` (clé publique WireGuard, IP overlay, secret RADIUS, version, état, dernier contact), `enrollment_token` |
| Offre | `plan`, `voucher_batch`, `voucher` (code, copie figée du forfait, état, `activated_at`, `expires_at`, compteurs, MAC liée, lot, paiement) |
| Usage | `session` (partitionnée par mois), `auth_log` |
| Paiement | `payment`, `payment_event` (corps brut des webhooks), `payout`, `credit_topup` |
| Comptabilité | `ledger_account`, `ledger_entry` |
| Traçabilité | `audit_log` |

Migrations : Prisma pour `app` ; SQL pur versionné pour `radius` et `ledger`. Le code d'un ticket est unique par propriétaire.

---

## 10. SÉCURITÉ, DISPONIBILITÉ, EXPLOITATION

### 10.1 Sécurité

- Secrets et clés API chiffrés au repos ; aucun secret dans le dépôt, les logs ou les scripts versionnés.
- Webhooks : signature vérifiée, identifiant d'événement unique (un rejeu est sans effet), corps brut conservé.
- Double authentification pour le super-admin ; rôles propriétaire, gérant, vendeur ; journal d'audit de toute action sensible.
- Limitation de débit sur le portail et sur l'API.
- Sauvegardes chiffrées hors site, avec test de restauration automatisé chaque mois.
- Données personnelles : collecte minimale (MAC, numéro du payeur, sessions), durée de conservation paramétrable, registre des traitements dans `docs/CONFORMITE.md`. Obligations CIL et ARCEP → **[À CONFIRMER]** par Yacouba.

### 10.2 Disponibilité

- Objectifs : authentification RADIUS disponible 99,9 % du mois ; perte de données maximale 5 min ; reprise en 30 min.
- Deux nœuds. Chaque routeur a deux pairs WireGuard et deux entrées `/radius`.
- PostgreSQL en réplication continue de A vers B. Si A est perdu, B authentifie sur sa réplique en lecture seule : mode dégradé assumé, les activations et les compteurs sont rattrapés par le rejeu des fichiers `detail`.
- Promotion de B **manuelle et documentée**. Pas de bascule automatique en v1 : sur une base qui porte un grand livre, une double écriture concurrente (« split-brain ») coûte plus cher que quelques minutes d'attente.

### 10.3 Supervision et exploitation

- Métriques : authentifications par seconde, latence, rejets par cause, routeurs hors ligne, âge du dernier handshake, file d'accounting en attente, paiements `PENDING`, écart de rapprochement.
- Alertes vers Telegram ou e-mail. Page d'état pour les propriétaires.
- Mises à jour un nœud à la fois, sans interruption de l'authentification.

---

## 11. LIMITES CONNUES (refuse, ou ouvre un ticket R&D)

- Prélever une commission sur des espèces sans mesure côté serveur.
- Garantir un paiement Wave à un téléphone qui n'a pas Internet.
- Empêcher l'usurpation de MAC sur un Wi-Fi ouvert : limite inhérente au hotspot.
- Hotspot IPv6 natif.
- Enrôler un routeur RouterOS 6.
- Collecte centralisée en production sans accord écrit (D1).
- Annoncer une disponibilité que les mesures ne démontrent pas.

---

## 12. PHASES ET PORTES DE VALIDATION

| Phase | Contenu | Preuves exigées |
|---|---|---|
| **0 — Cadrage et labo** | Dépôt, `docker-compose` de développement, CHR RouterOS (7.15 et stable courante), `radclient`. Lever tous les **[LABO]** du §1. `docs/PAYMENT_PROVIDERS.md` : matrice vérifiée dans les docs officielles (opérateurs BF, flux, transfert, frais, minimum, bac à sable, signature, agrément). `docs/QUESTIONS_AGREGATEURS.md` : questionnaire que Yacouba enverra. | `docs/LABO.md` : chaque **[LABO]** tranché, avec capture ou log. Liste des écarts avec le §1. |
| **1 — Cœur RADIUS** | Fonctions SQL, forfaits, tickets, accounting découplé, Disconnect / CoA. Un seul propriétaire. | Matrice T1–T12 verte. Sur CHR : connexion par ticket, coupure à l'échéance, Disconnect. |
| **2 — Multi-propriétaires et enrôlement** | Overlay, `wg-agent`, clients dynamiques, scripts d'enrôlement et de désinstallation, cloisonnement. | Un CHR vierge et un CHR avec hotspot et utilisateurs locaux existants, enrôlés en une commande. Désinstallation propre. Test d'isolement. Révocation immédiate. |
| **3 — Portail et paiement** | Portail, `MockProvider`, un adaptateur réel en bac à sable, grand livre, mode A. | Navigateur sans interface derrière le CHR : achat, puis auto-connexion. Matrice P1–P9 verte. Tests de propriétés du grand livre. |
| **4 — Exploitation commerciale** | Tableaux de bord, tickets papier, points de vente, relevés, crédits ; mode B derrière un drapeau. | Parcours 1 à 5 du §2.2 joués de bout en bout. P10. |
| **5 — Haute disponibilité et durcissement** | Second nœud, réplication, supervision, sauvegardes, test de charge, revue de sécurité par un agent qui n'a pas écrit le code. | T13. Restauration chronométrée. Rapport de charge. Rapport de revue, corrections faites. |
| **6 — Pilote** | Un site de Telecom Universel pendant 2 semaines, petits montants, rapprochement quotidien à la main. Puis 3 propriétaires pilotes. | Journal du pilote ; écart de rapprochement nul. |

**Portes : arrêt obligatoire, attends Yacouba.**

- **G0**, fin de phase 0 : décisions D1 à D6 et D9 ; écarts constatés avec le §1.
- **G-ARGENT**, avant toute clé de production : phase 3 verte **et** `docs/CONFORMITE.md` rempli. Aucun franc réel avant.
- **G-PILOTE**, avant d'enrôler le routeur d'un tiers : phase 5 verte.

Contenu minimal du questionnaire agrégateur : autorisation d'encaisser pour le compte de tiers, et sous quel statut ; sous-comptes marchands ou répartition automatique d'un paiement ; API de transfert vers Orange, Moov et Wave (frais, plafonds, délais) ; montant minimum et frais fixes par transaction ; flux sans redirection utilisable en API ; signature et rejeu des webhooks ; bac à sable ; délai de règlement ; agrément BCEAO pour opérer au Burkina.

---

## 13. RÈGLES DE TRAVAIL POUR L'AGENT

1. **Jamais « c'est fait » sans preuve.**
2. Ne devine aucune interface. Sources de vérité, dans l'ordre : comportement observé en labo > doc officielle de la version visée > journal des modifications > forums.
3. Un seul changement à la fois sur le chemin critique. Toute modification d'une fonction `radius.*` arrive avec son test.
4. Tout code qui touche `ledger`, `payment` ou `payout` exige des tests de propriétés et une relecture par un second agent.
5. Aucun secret dans le dépôt, les logs, les `.rsc` versionnés, la conversation ou une ligne de commande. Les fichiers de secrets sont créés et remplis par Yacouba, à la main.
6. Tout `.rsc` est exécuté sur CHR avant d'être montré, sur un routeur vierge **et** sur un routeur déjà configuré.
7. Tu ne te connectes à aucune machine de production. Tu livres fichiers et procédures.
8. `docs/JOURNAL.md` tenu à chaque session ; un ADR par décision d'architecture. Incertain ? Dis-le et propose le test qui tranche.
9. Un ticket à la fois, dans une session neuve (§14.3). Travail en parallèle seulement si Yacouba le demande, pour des tickets sans dépendance entre eux et hors du chemin critique : un worktree Git par ticket (`claude --worktree NOM` dans un autre terminal, ou des sous-agents lancés « avec des worktrees »). Si le dépôt a un `origin`, propose-lui d'abord de régler `worktree.baseRef` sur `head` : sinon les worktrees partent de la branche distante et ignorent les commits locaux non poussés. Deux agents ne modifient jamais le même fichier ; `infra/freeradius/` et `infra/sql/radius/` n'ont qu'un auteur à la fois. Tu ne crois pas le rapport d'un sous-agent : tu relances toi-même ses tests avant de fusionner. En dehors de ce que prévoit le §14.2, n'exécute jamais sans l'accord de Yacouba une commande qui écrit un `CLAUDE.md`, des hooks ou une configuration d'outil dans ce dépôt.
10. N'élargis pas le périmètre. Une idée hors §2 va dans `docs/IDEES.md`.
11. Le labo doit tourner sur le poste de Yacouba (Windows, Docker Desktop / WSL2, GNS3 pour les CHR) ou, à défaut, sur un VPS Linux de test. Note dans `docs/LABO.md` ce que tu as retenu, et pourquoi.

---

## 14. SKILLS ET MÉTHODE DE TRAVAIL

Inventaire relevé le 10/11/2026 : les 67 skills du dossier `~/.agents/skills` du poste de Yacouba, dont les fichiers ont été lus, puis les skills et les plugins de son compte claude.ai. Leur présence dans la session où tu lis ce document n'a pas pu être vérifiée : commence par le §14.1.

Notation. **[PC]** : dossier `~/.agents/skills` du poste. **[CPT]** : skill du compte claude.ai ; Claude Code (≥ 2.1.273, connecté à ce compte) le télécharge et le range sous `claude.ai sync` dans `/skills`. **[PLG]** : skill d'un plugin du compte, de la forme `plugin:skill` ; présent dans l'application Claude, et dans Claude Code seulement si le plugin y est installé. **[Y]** : skill du poste que **seul Yacouba peut lancer**, en tapant `/nom` ; il n'apparaît pas dans ta liste et tu ne peux pas l'appeler.

### 14.1 Vérifier avant de s'appuyer dessus

1. Compare ta liste de skills avec le §14.4. Pour les skills [Y], demande à Yacouba ce qu'affiche `/skills`. Note dans `docs/JOURNAL.md`, pour chacun : présent ou absent.
2. Skill absent : fais le travail selon les règles de ce document, et dis-le. Tu ne simules jamais un skill ; tu n'inventes ni ses fichiers ni ses commandes.
3. Appelle chaque skill par le nom exact de ta liste (un préfixe est possible).
4. Plusieurs skills embarquent des scripts `bash` ou Python, alors que le poste est sous Windows, en PowerShell natif. Teste une fois `bash --version`, `jq --version` et `python --version`, et note le résultat. Les fichiers de `~/.agents/skills` sont presque tous en fins de ligne CRLF, scripts compris : un script `bash` copié tel quel ne s'exécute pas (Python s'en accommode). Un script qui ne tourne pas se signale ; il ne se contourne pas en silence.

### 14.2 Mise en place, une seule fois (début de la phase 0)

1. Enregistre ce document tel quel dans `docs/SPEC.md`. Il fait foi, et il sert de référence « Spec » aux revues.
2. Crée `CLAUDE.md` avec le modèle ci-dessous. Les sessions suivantes et les sous-agents partent de ce fichier, pas de cette conversation.
3. Crée `CONTRIBUTING.md` : les normes qu'une relecture peut vérifier, tirées des §4, §8.1 et §13 et des conventions du §6.2 (argent en `BIGINT` XOF, grand livre en ajout seul, aucun secret, un test pour chaque fonction `radius.*` modifiée, documents et messages de commit en français, chaque commit cite le chemin de son ticket). Il sert de référence « Standards » aux revues.
4. `.gitignore` : `.claude/worktrees/`, `.claude/settings.local.json`, fichiers de secrets. `.gitattributes` : `* text=auto eol=lf` (et `eol=crlf` pour `*.bat` et `*.cmd`), parce que le poste est sous Windows et qu'un script en CRLF ne s'exécute pas dans un conteneur Linux.
5. Demande à Yacouba de taper `/setup-matt-pocock-skills` [Y]. Réponses recommandées : tickets en **Markdown local** (dossier `.scratch/`, versionné), étiquettes par défaut, contexte unique (`CONTEXT.md` à la racine, `docs/adr/`). Motifs : aucune dépendance à `gh`, absent du poste le 10/11/2026 ; et les PRD, qui décrivent sa stratégie commerciale, restent avec le code.
6. Avec son accord : `git-guardrails-claude-code` [PC], portée projet. Il bloque `git push`, `git reset --hard`, `git clean -f`, `git branch -D`, `git checkout .` et `git restore .`. Son script est en `bash`, exige `jq`, et ne surveille que l'outil Bash : des commandes passées par l'outil PowerShell lui échappent. Essais faits sous Linux sur la copie exacte du fichier : sans `jq`, il laisse tout passer ; en CRLF, il refuse toutes les commandes. Convertis donc ta copie en LF, puis apporte trois preuves : (a) le script, nourri de `git push origin main`, sort en code 2 avec le message `BLOCKED` ; (b) nourri de `git status`, il sort en code 0 ; (c) lancé depuis ton outil de commandes habituel, `git push --dry-run` est bloqué avant exécution. S'il manque une preuve, retire le hook et dis-le : un garde-fou non prouvé ne compte pas.
7. Avec son accord, dès que `package.json` existe : `setup-pre-commit` [PC] (Husky, lint-staged, Prettier), réglé comme au §14.5.

```markdown
# WAKATNET
Spécification faisant foi : `docs/SPEC.md`. Avant tout travail, lis ses §0, §4, §13 et §14, puis la section du lot en cours.
Glossaire : `CONTEXT.md`. Décisions : `docs/adr/`. Normes de code : `CONTRIBUTING.md`. Journal, une entrée par session : `docs/JOURNAL.md`.
Jamais « c'est fait » sans preuve. Aucun secret dans le dépôt, les logs, la conversation ou une ligne de commande. Aucune connexion à une machine de production. Pas de `git push` : Yacouba pousse lui-même.
```

### 14.3 Enchaînement d'une phase

Les phases 1 à 5 suivent le même circuit. Les phases 0 et 6 (labo, recherche, pilote) n'ont pas de PRD.

| Étape | Qui | Commande ou skill | Résultat |
|---|---|---|---|
| 1. Cadrer | Yacouba | `/grill-with-docs` [Y] + périmètre de la phase (§12) | Questions une par une, chacune avec ta réponse recommandée ; `CONTEXT.md` et ADR écrits au fil des réponses |
| 2. Lever un doute par du code | Yacouba, si besoin | `/handoff` [Y], session neuve, `/prototype` [Y], puis `/handoff` [Y] en retour | Prototype jetable ; seul son verdict est gardé, dans un ADR ou dans le PRD |
| 3. Spécifier | Yacouba, même session que l'étape 1 | `/to-prd` [Y] | `.scratch/phase-N-titre/PRD.md` |
| 4. Découper | Yacouba, même session | `/to-issues` [Y] | Tickets `.scratch/phase-N-titre/issues/NN-titre.md`, qu'il valide avant publication |
| 5. Réaliser | Yacouba, **une session neuve par ticket** | `/implement` [Y] + chemin du PRD + chemin du ticket | Sur la branche du ticket : `tdd`, tests, `review`, commit |
| 6. Clore | Toi | `review` depuis l'étiquette Git (`git tag`) de la porte précédente ; preuves du §12 | Étiquette Git de fin de phase ; entrée au journal |

- Étapes 1, 3 et 4 dans une seule session, sans `/compact` avant la fin de l'étape 4. Session saturée : `/handoff` [Y], puis session neuve.
- **Si les skills [Y] sont absents**, le circuit reste le même : tu rédiges toi-même le PRD et les tickets dans `.scratch/`, Yacouba les valide, et chaque ticket se traite dans une session neuve.
- **Contrats d'abord.** Aucun ticket de code n'est ouvert avant que les contrats de la phase soient acceptés dans un ADR : signatures SQL du §5.2, OpenAPI, interface `PaymentProvider`.
- **Tranches verticales.** Un ticket traverse toutes les couches et se prouve seul ; autant que possible, il correspond à une ligne des matrices T ou P. Premier ticket de la phase 1 : T2 de bout en bout (`radclient` → FreeRADIUS → `radius.authorize` → Accept avec le `Session-Timeout` exact). Jamais de ticket « écrire tous les tests » ni « écrire toutes les fonctions SQL ».
- **Une branche par ticket.** `git switch -c ticket/NN-titre` depuis `main` avant `/implement` [Y] ; fusion locale dans `main` après une revue sans réserve et des tests verts.
- **Mode délégué**, seulement si Yacouba l'écrit : tu lances toi-même un sous-agent par ticket, l'un après l'autre, chacun avec le PRD, le ticket, la consigne d'appliquer `tdd` puis `review`, et un critère de fin vérifiable. Jamais pour un ticket qui touche le chemin critique ou l'argent.
- **À G0** : `/grill-with-docs` [Y] sur D1 à D6 et D9, résultats du labo en main.
- **À chaque porte** : aucune branche de ticket ni worktree en suspens ; état noté dans `docs/JOURNAL.md`.

### 14.4 Quel skill pour quel travail

**Méthode, pour toutes les phases**

| Travail | Skill | Consigne propre à WAKATNET |
|---|---|---|
| Tout code | `tdd` [PC] | Un test, puis le code minimal qui le fait passer, puis le suivant. Les tests passent par l'interface publique : protocole RADIUS (`radclient`) et signatures SQL du §5.2, interface `PaymentProvider`, API HTTP. Faux aux frontières seulement (`MockProvider`) ; PostgreSQL est réel. Les contrats des §5, §7 et §8 et les matrices T et P valent plan approuvé : ne demande une validation que pour ce qu'ils ne couvrent pas. |
| Figer une interface | `design-an-interface`, `codebase-design` [PC] | Trois formes au moins, comparées avant d'écrire. À traiter ainsi : l'écriture dans le grand livre, l'API de `wg-agent`, et la façon de fournir l'instant de référence aux fonctions `radius.*` pendant les tests (T3 et T4 doivent être déterministes ; en production, la règle 5 du §4 reste seule valable). `PaymentProvider` (§7.3) est confronté aux docs officielles de deux agrégateurs avant d'être figé. |
| Terme ou décision qui se fixe | `domain-modeling` [PC] | Un seul glossaire : `CONTEXT.md`, sans détail d'implémentation. ADR dans `docs/adr/NNNN-titre.md`. Les décisions du §3 tranchées à G0 y entrent. |
| Décision à obtenir de Yacouba | `grilling` [PC] | Une question à la fois, avec ta réponse recommandée. |
| Fin de ticket, fin de phase | `review` [PC] | Deux axes, deux sous-agents, deux rapports séparés : Standards (`CONTRIBUTING.md`) et Spec (ticket, PRD, `docs/SPEC.md`). Point fixe : `main` pour un ticket, l'étiquette de la porte précédente pour une phase. `/review` est aussi un alias de la commande intégrée `/code-review` : si c'est elle qui répond, dis-le ; elle cherche des bugs et ne remplace pas cette revue. |
| Échec dont la cause n'est pas évidente | `diagnosing-bugs` [PC] | D'abord une commande rejouable qui passe au rouge sur ce défaut précis : `radclient` suivi d'une requête SQL, `curl` sur le portail, rejeu d'un webhook conservé dans `payment_event`. Pour un essai qui exige un téléphone ou un routeur réel : son gabarit `scripts/hitl-loop.template.sh`, converti en LF. |
| Choix du modèle | `routeur-modeles` [CPT] | Chemin critique, argent, sécurité : le niveau le plus fort disponible, y compris pour la relecture de la règle 4. Lots mécaniques : sous-agent moins coûteux, modèle passé explicitement. |
| Fusion en conflit | `resolving-merge-conflicts` [PC] | Les deux intentions sont préservées ; les tests sont relancés avant de conclure. |

**Par lot**

| Lot | Skills | Consigne propre à WAKATNET |
|---|---|---|
| Scripts RouterOS, `login.html`, hotspot, WireGuard (§6) | `mikrotik-routeros-config` [CPT] | Génération, puis son **mode audit** sur chaque `.rsc` produit, avant le passage sur CHR (règle 6). Ses conventions sont celles de l'exigence 7 du §6.2. |
| API, worker, schéma (§5, §7, §8, §9) | `senior-backend` [PC] | Phase 0 : ses sept questions. Ce document répond à Q2 à Q6 ; restent Q1 (rapport lectures / écritures, charge prévue à 12 mois) et, pour Q7, qui arbitre quand l'objectif de disponibilité est manqué : à poser à Yacouba avant G0. Sécurité : `references/backend_security_practices.md` comme liste de contrôle. Charge HTTP du portail et des webhooks : `scripts/api_load_tester.py`, après lecture de son `--help` (la doc du skill cite des options que le script n'a pas). La charge RADIUS du §5.6 se mesure avec `radclient`, pas avec ce script. |
| `wg-agent` | `golang-pro` [PC] | Seulement si l'ADR retient Go. Tests avec `-race`. |
| Portail captif (§7.1) | `web-design-pro` [CPT], `frontend-design` [PC], `design:ux-copy` [PLG] | Direction visuelle et textes courts en français. Les contraintes du §7.1 priment sur toute ambition graphique : polices système, aucun fichier externe, moins de 100 Ko. |
| Tableau de bord | `senior-frontend` [PC], `web-design-pro` [CPT], `ui-ux-pro-max` [PC], `design:accessibility-review` [PLG] | React / Vite (profil `vite-spa`) ; ce qui concerne Next.js est sans objet. `ui-ux-pro-max` : ses listes de contrôle uniquement, car son script `search.py` et sa base de données sont absents du poste. Audit d'accessibilité avant G-PILOTE. |
| Essais dans un navigateur | `webapp-testing` [PC] | Reconnaissance et captures d'écran servant de preuve ; exige Python et Playwright. Les tests de bout en bout versionnés restent dans la pile du dépôt. |
| Matrice des agrégateurs (phase 0) | `deep-research` [CPT], `operations:vendor-review` [PLG] | `docs/PAYMENT_PROVIDERS.md` : coût complet d'une vente à 100 F, risques, points à négocier. Docs officielles uniquement (règle 2). |
| Contrat d'agrégateur (avant G-ARGENT) | `legal:review-contract` [PLG] | Prépare les questions à poser au juriste. Ne remplace pas l'avis exigé par D1. |
| Rapprochement (§8.3, pilote) | `finance:reconciliation` [PLG] | Classement des écarts : décalage dans le temps, correction à passer, cas à instruire. |
| Exploitation | `operations:runbook`, `engineering:deploy-checklist`, `engineering:incident-response` [PLG] | `docs/RUNBOOK.md` ; liste de contrôle avant chaque mise en production ; compte rendu d'incident sans recherche de coupable pendant le pilote. |
| Routeur derrière Starlink (§6.1, labo) | `assistant-starlink` [CPT] | CGNAT, mode bypass, tunnel WireGuard sortant. Ses faits sont datés : à revérifier (règle 2). |
| Alertes Telegram (§10.3) | `telegram-bot` [PC] | Modèles de messages seulement. Un appel HTTPS depuis le worker ; ni n8n ni serveur MCP. |
| Revue de sécurité (phase 5) | Session neuve : `senior-backend` [PC], `mikrotik-routeros-config` [CPT], commandes intégrées `/code-review` et `/security-review` | `docs/REVUE_SECURITE.md`. `/security-review` exige un dépôt distant `origin`. |
| Guide du propriétaire et du vendeur (pilote) | `formateur-it` [CPT], `docx`, `pdf` [PC] | Facultatif, à la demande de Yacouba. À partir de `docs/ONBOARDING_ROUTEUR.md`. |
| Défauts remontés pendant le pilote | `/triage` [Y] | Tickets au format du dépôt, vérifiés avant d'être confiés à un agent. |
| Entretien du code entre deux phases | `/improve-codebase-architecture` [Y] | Facultatif. |

Si Yacouba ne sait plus quelle commande taper : `/ask-matt` [Y].

### 14.5 Ce document prime sur les skills

Un skill apporte une méthode ou une liste de contrôle. Il ne rouvre aucune décision de ce document.

- **Architecture.** La pile (D10), l'hébergement (D6) et le chemin critique (D7) ne se rediscutent pas parce qu'un skill propose autre chose.
- **Seuils.** Ceux des §5.6 et §10.2 priment. Le profil par défaut de `senior-backend` (disponibilité 99,5 %, perte de données d'une heure) est plus lâche : ne le reprends pas.
- **Langue et contexte.** Documents, PRD, tickets, ADR et messages de commit en français, même si le gabarit du skill est en anglais. Montants en XOF entiers ; droit OHADA et réglementation BCEAO ; comptabilité SYSCOHADA. Un skill qui raisonne en dollars, en droit américain, en RGPD ou en normes GAAP est adapté, ou écarté.
- **`setup-pre-commit`.** À la validation : formatage, typage et tests rapides seulement. Les matrices T et P, qui exigent FreeRADIUS et PostgreSQL, tournent par une commande séparée avant chaque fusion et à chaque porte.
- **`/implement` [Y].** Il valide sur la branche courante : d'où la branche par ticket. Personne d'autre que Yacouba ne pousse.
- **`/handoff` [Y].** Il écrit hors du dépôt, dans le dossier temporaire du système. La trace durable reste `docs/JOURNAL.md`.
- **Faits techniques.** Ce qu'un skill affirme sur RouterOS, FreeRADIUS ou un agrégateur se vérifie comme le reste (règle 2).

### 14.6 Garde-fous

1. **Skills à ne pas utiliser ici, même s'ils se déclenchent seuls.** `senior-devops` : ses exemples sont Kubernetes, Terraform et AWS, contraires à D6 et D7, et ses trois fichiers de référence sont des gabarits vides. `senior-fullstack` : il génère d'autres piles que celle de D10. `qa` et `request-refactor-plan` : ils créent des tickets GitHub avec `gh`, sans relecture. `/ubiquitous-language` [Y] : il ouvrirait un second glossaire.
2. **`find-skills`.** N'installe aucun skill, plugin ou serveur MCP sans l'accord de Yacouba : ce sont des instructions et des scripts qui s'exécutent avec ses droits, dans un dépôt qui portera du code de paiement.
3. **Tout skill absent du §14.4 est hors sujet dans ce dépôt**, sauf demande de Yacouba.
4. Pour que les skills des points 1 et 2 ne se déclenchent plus dans ce dépôt, Yacouba peut les passer à l'état `off` dans `/skills` (Espace, puis Échap). Réglage équivalent, dans `.claude/settings.local.json` :

```json
{
  "skillOverrides": {
    "senior-devops": "off",
    "senior-fullstack": "off",
    "qa": "off",
    "request-refactor-plan": "off",
    "find-skills": "off"
  }
}
```

---

## 15. LIVRABLES (dans l'ordre)

1. `docs/SPEC.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `.gitattributes` — mise en place du §14.2. `CONTEXT.md` et `.scratch/` se remplissent au fil des phases.
2. `docs/LABO.md` — tous les **[LABO]** tranchés, preuves jointes.
3. `docs/PAYMENT_PROVIDERS.md` et `docs/QUESTIONS_AGREGATEURS.md`.
4. `docs/ARCHITECTURE.md` et `docs/adr/`.
5. `infra/` — `docker-compose` de développement, configuration FreeRADIUS, migrations SQL.
6. `radius/tests/` — matrice T1–T13 automatisée.
7. `routeros/` — générateur de `wakatnet-enroll.rsc`, `wakatnet-uninstall.rsc`, `login.html`, et `docs/ONBOARDING_ROUTEUR.md` (procédure propriétaire, testée).
8. `apps/api`, `apps/worker`, `apps/portal`, `apps/dashboard`, `apps/wg-agent`.
9. `packages/payments/` — interface, `MockProvider`, un adaptateur réel, matrice P1–P10.
10. `packages/ledger/` — grand livre et tests de propriétés.
11. `docs/RUNBOOK.md` — installation, mise à jour, sauvegarde et restauration, promotion du nœud B, révocation d'un routeur, gel des reversements.
12. `docs/CONFORMITE.md` — gabarit à remplir par Yacouba (accords agrégateur, avis juridique, CIL, ARCEP, fiscalité, dépôt de la marque WAKATNET à l'OAPI).
13. `docs/PILOTE.md` — plan et journal du pilote.

**Commence par les §14.1 et §14.2, puis la phase 0. Rends compte après chaque livrable. Arrête-toi à chaque porte.**

---

## 16. SOURCES (consultées le 10/11/2026)

**RouterOS et FreeRADIUS**
- RADIUS, RouterOS 7.25 — https://manual.mikrotik.com/docs/7.25/authentication-authorization-accounting/radius
- HotSpot, RouterOS 7.25 — https://manual.mikrotik.com/docs/7.25/authentication-authorization-accounting/hotspot-captive-portal/
- `require-message-auth` depuis la 7.15 — https://forum.mikrotik.com/t/resolved-how-to-fix-mikrotik-login-failed-with-radius-added-require-message-auth-option-on-v7-15/176604
- RadSec après la 7.15 (source tierce) — https://mikrotikdocs.fyi/general/radsec-issues-after-715-upgrade/
- FreeRADIUS 3.2.6, notes de version — https://newreleases.io/project/github/FreeRADIUS/freeradius-server/release/release_3_2_6
- FreeRADIUS, clients dynamiques — https://github.com/FreeRADIUS/freeradius-server/blob/HEAD/raddb/sites-available/dynamic-clients

**Réglementation**
- BCEAO, établissements de paiement agréés au 31/08/2026 — https://www.bceao.int/fr/communique-presse/liste-des-etablissements-de-paiement-agrees-dans-lumoa-au-31-aout-2026
- Instruction n°001-01-2024, obligation d'agrément — https://www.osiris.sn/la-bceao-prolonge-jusqu-au-31-aout-2025-la-periode-de-mise-en-conformite-aux.html
- PI-SPI, lancement — https://burkina24.com/?p=418262
- PI-SPI, 175 participants — https://www.financialafrik.com/2026/10/01/bceao-liste-des-175-participants-autorises-a-ouvrir-les-services-de-pi-spi-au-public-au-30-septembre-2026/

**Mobile Money**
- CinetPay, codes USSD par opérateur — https://docs.cinetpay.com/api/1.0-en/checkout/tableau
- CinetPay, tarifs — https://cinetpay.com/pricing
- Payfonte, flux pré-OTP Orange Burkina — https://docs.payfonte.com/guides/collections/direct-charge/examples
- Wave, API Payout — https://docs.wave.com/payout
- Wave, profil tiers de l'API — https://github.com/api-evangelist/wave-mobile-money
- pawaPay au Burkina — https://pawapay.io/blog/pawapay-live-in-burkina-faso
- FedaPay, moyens de paiement — https://docs.fedapay.com/payment-methods/en/payment-methods-en
- Moneroo, méthodes — https://docs.moneroo.io/fr/payments/methodes-disponibles
- Flutterwave, Mobile Money francophone — https://developer.flutterwave.com/v3.0/docs/francophone
- Comparatif d'agrégateurs (YengaPay, KkiaPay…) — https://sinedev.com/comparatif-agregateurs-paiement-afrique/
- LigdiCash, présentation tierce — https://kolonell.com/fr/blog/ligdicash-burkina-faso-paiement-orange-moov-ouagadougou-2026

**Claude Code et skills**
- Skills : emplacements, `disable-model-invocation`, synchronisation des skills claude.ai, `skillOverrides` — https://code.claude.com/docs/en/skills
- Commandes intégrées (`/skills`, `/code-review`, `/security-review`) — https://code.claude.com/docs/en/commands
- Worktrees (`--worktree`, `worktree.baseRef`) — https://code.claude.com/docs/en/worktrees
- Skills du poste : contenu de `~/.agents/skills`, lu le 10/11/2026 (67 dossiers) ; skills et plugins du compte claude.ai, listés le même jour.

**Concurrence**
- https://mana-zone.app/ · https://monmikrotik.cloud/ · https://monwifizone.com/ · https://app.mazonewifi.com/ · https://ticketwifizone.com/
