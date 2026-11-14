# Revue de sécurité — phase 5

- **Date** : 12/11/2026. **Ticket** : `.scratch/phase-5-haute-disponibilite/issues/08-revue-securite.md` ; SPEC §12 (phase 5).
- **Relecteur** : un agent qui n'a pas écrit le code, en lecture seule, sur le commit `3046f22`. Il a lu le code et raisonné, sans exécuter de test.
- **Suites** : décidées et appliquées par l'agent principal, sur la branche de la phase 5. Chaque correction est prouvée par un test, cité dans le tableau.
- **Bilan** :
  - aucun constat critique : aucun chemin ne donne à un inconnu ou à un propriétaire l'accès aux données d'un autre, ni ne crée d'argent ;
  - deux constats élevés, corrigés ;
  - huit moyens : trois corrigés, cinq qui attendent une décision.

## 1. Constats et suites

| # | Gravité | Constat | Suite |
|---|---|---|---|
| E1 | Élevé | Après une promotion de B, un redémarrage de A par l'hébergeur (unité restée activée) ou un passage d'Ansible le faisait repartir en **primaire** : deux grands livres divergents, et les routeurs qui reviennent sur A | **Corrigé**. Garde `ExecStartPre=` sur l'unité PostgreSQL et garde dans le rôle Ansible (`infra/noeud/garde-double-primaire.sh`) ; RUNBOOK §3 : faire couper le réseau de A injoignable. Prouvé avec un vrai systemd (`infra/ansible/essais/essai.sh`, étape 7). **Trouvé en le prouvant** : l'unité de Debian n'a pas de `User=`, la garde tournait en root sans fichier de mots de passe, et laissait passer. Elle bloque désormais quand le pair répond sans que son état puisse être lu |
| E2 | Élevé | Code TOTP du super-admin deviné sans limite (10⁶ codes, ±1 pas) | **Corrigé**. Migration 0030 : essais **réservés** sous verrou avant la vérification, 5 en 15 min ; au-delà, session fermée et événement `totp_trop_d_essais` audité. Test : 12 essais parallèles donnent 5 vérifications au plus |
| M1 | Moyen | Aucune limite de débit sur l'API ni sur le portail (SPEC §10.1) ; `/v1/connexion` calcule scrypt pour tout venant | **Corrigé en phase 6** (ADR 0016 §2) : limites par IP dans nginx, prouvées au banc Ansible (étape 8). Décision d'origine : au proxy inverse (pas encore dans le dépôt) ou dans l'application (`@fastify/rate-limit`, nouvelle dépendance). Les deux exigent `trustProxy` réglé. Réduit en partie par M2. **Audit du 13/11/2026** (ADR 0016) : `/etat` du portail limité aussi (429 prouvé au banc, étape 8) |
| M2 | Moyen | Verrou des connexions contourné par des requêtes parallèles (~1 000 essais par 15 min) | **Corrigé** (migration 0030, même mécanique qu'E2). Test : 20 connexions parallèles donnent 5 vérifiées au plus, et 15 refus 429. **Blocage par un tiers, corrigé en phase 6** (migration 0031, relue par un second agent) : 5 essais par (adresse, source) ; 10 par adresse pour les sources inconnues ; un appareil connu (cookie posé à une connexion réussie) garde son propre budget et passe pendant une attaque distribuée. Test : `auth.test.ts`. **Reste** : un titulaire **sans** appareil connu attend 15 min pendant une attaque de 2 sources ou plus. La devinette répartie passe de 5 à 10 essais par 15 min et par compte, hors appareils connus |
| M3 | Moyen | Impossible de retirer l'accès d'un gérant ou d'un vendeur, qui garde ses sessions et lit les codes des nouveaux lots | **Corrigé**. `PUT /v1/utilisateurs/:id { actif: false }`, propriétaire seulement : sessions fermées sur-le-champ, action auditée. Test : refus d'un autre propriétaire (404) et d'un gérant (403), session du vendeur tombée. **Écran ajouté en phase 6** (bouton « Couper l'accès » avec confirmation, écran « Points de vente et vendeurs ») : prouvé par l'e2e, parcours 4 |
| M4 | Moyen | Inscription ouverte : épuisement des adresses de l'overlay (~64 500 enrôlements) et `wg0` gonflé | **Corrigé en phase 6** (ADR 0017, migration 0033) : quota d'enrôlement par propriétaire (10 par défaut, réglable par le super-admin), qui compte les routeurs enrôlés **révoqués compris** et les jetons ouverts ; raccorder un routeur exige une adresse e-mail vérifiée (lien, ou validation du super-admin tant qu'aucun fournisseur d'e-mail n'est choisi) ; alerte `overlay_plein` à 80 %. Tests : `quota.test.ts`, e2e parcours 1. **Fournisseur branché** (ADR 0019, Brevo) avec les conditions de l'ADR 0017 : quota de 2 pour un compte vérifié par lien, plafond global de 100 commandes par jour et arrêt à 90 % de l'overlay pour les comptes non validés, limites par source. **Audit du 13/11/2026** (migration 0036) : plafond global et seuil de 90 % de l'overlay contrôlés aussi à la **consommation** du jeton, sous les mêmes verrous (propriétaire, puis global) ; une rafale de jetons pris d'avance par plusieurs comptes ne les dépasse plus (409, jeton intact). Un jeton émis ne survit plus à la suspension du compte ni à la baisse de son quota : refus à la consommation, et jetons ouverts expirés par le super-admin. Tests : `quota.test.ts` (« audit 13/11/2026 »). **Reste** : des adresses jetables, au rythme borné par ces plafonds |
| M5 | Moyen | MAC, IP et page demandée par le client final écrites dans le journal de l'API | **Corrigé**. `redirection.html` ne transmet plus `mac` ni `ip`, que le portail ne lisait pas ; le journal n'écrit plus la chaîne de requête. Tests : `config.test.ts`, e2e d'achat |
| M6 | Moyen | Échec de l'essai mensuel de restauration (écart du grand livre compris) sans alerte | **Corrigé**. Règle `essai_restauration` : échec, essai de plus de 35 jours, ou essai jamais lancé, sur le primaire. Test : `sante.test.ts` |
| M7 | Moyen | La garde de 30 paiements par minute et par site sert à bloquer la vente en ligne d'un concurrent | **Corrigé en phase 6, sauf voisin de CGNAT**. 30 POST par minute et par source dans nginx (ADR 0016 §2) ; dans l'API, garde par (site, source), plafond de 100 par minute et par site (migration 0031). **L'IP publique du routeur, notée par `wg-agent`, a son propre budget hors plafond** (migration 0032) : un tiers ne bloque plus le hotspot. Relues par un second agent. Tests : `paiement.test.ts`, `portail.test.ts`, `wg-agent` (vraie poignée de main WireGuard). **Restes** : un voisin de NAT ou de CGNAT de même IP publique peut vider le budget du routeur ; un routeur non reconnu (double WAN, `wg-agent` arrêté, alerte `ip_routeurs`) retombe sur 0031, où 4 sources bloquent le site. **Audit du 13/11/2026** (ADR 0016) : la zone `payer` de nginx est indexée sur (site, source), et non plus sur la seule source. Un client bruyant derrière le NAT d'un hotspot, ou un voisin de CGNAT, ne vide plus que le budget de ce site, et non celui de tous les sites vendus depuis cette IP (prouvé au banc, étape 8). **Reste** : le voisin de NAT sur le même site |
| M8 | Moyen | Un nœud compromis peut effacer les sauvegardes (clés S3 sur les deux nœuds) | **Corrigé en phase 6** (ADR 0018) : Backblaze B2, bucket versionné et verrouillé en **mode conformité, 30 jours** ; restauration après effacement par `--repo-target-time` (pgBackRest ≥ 2.59.2, contrôlé par Ansible). Prouvé au banc `sauvegarde-s3.sh` : l'attaquant efface tout avec la configuration pgBackRest du nœud, ses 986 effacements définitifs sont refusés, la base revient (moto ne contrôle pas les droits des clés : les capacités de la clé B2 ne sont pas prouvées par ce banc). Audit du 13/11/2026 : contrôle externe du bucket hors des nœuds (`infra/surveillance/controle-b2.sh`, clé en lecture de liste seule), configuration pgBackRest à root, capacités de la clé fixées. **Reste** : exercice sur B2 lui-même avant G-PILOTE (dont les capacités de la clé) ; planification du contrôle externe ; réécriture de `backup.info` sans `stanza-delete`, vue seulement par un essai de restauration hors nœud ; fermeture du compte B2 |
| F1 | Faible | L'auto-connexion après achat envoie le code en clair sur le Wi-Fi ouvert | Choix de l'ADR 0013 §10 ; passer en HTTPS là où le hotspot le permet : **décision** |
| F2 | Faible | Robustesse de la récupération d'un achat liée au format de la référence de l'opérateur | **[LABO]** ; le refus des références finissant par `-` ou `_` est à revoir avec le vrai adaptateur |
| F3 | Faible | L'import Mikhmon ne vérifie pas le plafond du découvert | **Décision** (ADR 0002) |
| F4 | Faible | Corps bruts des webhooks gardés sans durée (numéro du payeur probable) | **Corrigé le 13/11/2026** (migration 0040, durée décidée par Yacouba) : corps vidés à 6 mois, comme le numéro du payeur ; l'événement reste pour le dédoublonnage. Durée à valider par le juriste (`docs/CONFORMITE.md` §7 bis) |
| F5 | Faible | L'interface publique des nœuds laisse tout passer (seuls `wg0` et `wk-noeuds` sont filtrés) | **Corrigé en phase 6** (ADR 0016 §3, rôle `parefeu`, prouvé au banc, étape 9). Prévu à l'origine : politique `drop` en entrée publique sauf SSH, WireGuard et 443. Elle touche l'accès SSH : à poser et vérifier depuis une seconde session (anti-lockout). **Audit du 13/11/2026** (ADR 0016) : le retour arrière rétablit aussi le fichier sur disque ; une table absente de la mémoire est rechargée à chaque passage ; `parefeu` tourne juste après `socle`, avant les rôles qui peuvent échouer (certbot sur la réplique) ; DHCP limité aux réponses d'un serveur. Retour arrière **déclenché** au banc (étape 10) |
| F6 | Faible | `wk_rewind`, qui lit tout le répertoire de données, était admis en local | **Corrigé** : `pg_hba.conf` le refuse en local, de même que `wk_replication` ; seul l'autre nœud les utilise |
| F7 | Faible | Une restauration d'essai interrompue (SIGKILL) laissait une base en clair sur disque | **Corrigé** : les restes sont effacés au début de l'essai, qui ne tourne plus que sur le primaire |
| F8 | Faible | L'exemple de `admin-creer.ts` écrivait le mot de passe dans l'historique du shell | **Corrigé** : exemple avec `read -rs` |
| F9 | Faible | Énumération des adresses inscrites (409) | **Corrigé en phase 6** (ADR 0019, migration 0034) : l'inscription n'ouvre pas de session et répond pareil que l'adresse soit libre ou prise ; connexion refusée avant confirmation avec le message d'un mauvais mot de passe ; renvoi du lien à réponse identique. Tests : `auth.test.ts`, `quota.test.ts`, e2e parcours 1 **Audit du 13/11/2026** (migration 0039, ADR 0019) : un nom de plus de 80 caractères ne répond plus 500 sur une adresse libre et 202 sur une adresse prise (422 avant la base, et toute création en échec répond comme une adresse prise, essai compté dans le budget de la source) ; le renvoi du lien répond avant tout travail en base (plus d'écart de durée selon l'adresse) ; une erreur 500 ne journalise plus le DETAIL de PostgreSQL (adresse, nom, empreinte du mot de passe), seulement classe, code et contrainte ; adresses en `.invalid` refusées (API et contrainte `utilisateur_email_reservee`), ce qui ferme aussi le blocage de toute inscription par une adresse de purge réservée d'avance ; pré-appropriation : une inscription sur une adresse inscrite **non confirmée** remplace le mot de passe et invalide les liens ouverts, à réponse identique ; plafond global d'e-mails réservé avant de créer un lien, 10 demandes par jour et par source. Tests : `auth.test.ts` et `courriel.test.ts` (« audit 13/11/2026 »). **Reste** : une course gagnée par un tiers qui se réinscrit juste avant le clic de la titulaire ; le parcours de réinitialisation du mot de passe, qui la fermerait, est à faire |
| F10 | Faible | Portail, API et tableau de bord répondent sur tous les noms d'hôte | **Corrigé en phase 6** (ADR 0016 §2, prouvé au banc, étape 8). Prévu à l'origine : filtrer les routes selon `Host`. **Audit du 13/11/2026** : un SNI connu suivi d'un `Host` inconnu était servi par le serveur TLS par défaut ; il reçoit désormais `444` (prouvé au banc, étape 8) |
| F11 | Faible | Collecteur de santé et tâche des fantômes sous `freerad` | Accepté pour l'instant. Ils doivent lire le spool, qui est réservé à `freerad` ; à revoir en séparant les droits du spool |

Remarques sans scénario réaliste, notées sans suite immédiate :
- `pg_read_all_stats` est accordé au propriétaire des fonctions ;
- les lignes `DETAIL` de PostgreSQL (une adresse e-mail en doublon) restent journalisées ;
- un propriétaire peut désigner un hôte arbitraire comme cible d'auto-connexion, mais n'expose ainsi que ses propres clients.

## 2. Jugé sain par le relecteur

- **Fonctions et requêtes** :
  - toutes les fonctions `SECURITY DEFINER` fixent `search_path` ;
  - un propriétaire est toujours lu dans `app.tenant_courant()`, jamais reçu en paramètre ;
  - le filtre par point de vente est posé en SQL ;
  - aucune requête SQL n'est construite par concaténation.
- **Cloisonnement** : RLS avec `set_config(…, true)` dans une transaction, clés étrangères composites, aucune élévation de rôle possible.
- **Sessions et authentification** :
  - session : cookie `HttpOnly; Secure; SameSite=Strict`, jeton de 256 bits, empreinte seule en base ;
  - CSRF par en-tête personnalisé ;
  - scrypt et comparaison en temps constant ;
  - TOTP sans rejeu, secret chiffré avec donnée associée.
- **Paiements** :
  - webhooks : corps brut, signature vérifiée avant toute écriture, événement unique ;
  - `verify()` fait foi, montant et devise contrôlés ;
  - le MockProvider est refusé en production.
- **Grand livre** : ajout seul, équilibre par contraintes différées, aucun droit d'un rôle de connexion.
- **Rendus** :
  - portail échappé, avec CSP ;
  - tableau de bord servi depuis la mémoire, avec CSP stricte ;
  - PDF et CSV échappés.
- **Enrôlement** :
  - jeton de 256 bits à usage unique, masqué dans les journaux ;
  - scripts RouterOS échappés et validés ;
  - téléchargement avec `check-certificate=yes`.
- **FreeRADIUS** : clients limités à l'overlay, `Require-MA`, silence en panne, aucune ligne d'authentification dans le journal.
- **Réseau et exploitation** :
  - `wg0` sans transfert ;
  - `wg-agent` borné ;
  - PostgreSQL écoute en local et sur `wk-noeuds` seulement ;
  - aucun secret ne passe par Ansible ;
  - unités durcies.

## 3. Non vérifié

- **Hors du dépôt** : le déploiement de l'API et du portail derrière un proxy inverse (TLS, HSTS, limites, journaux d'accès), et la création de `wg0` et du binaire de `wg-agent` sur le nœud.
- **Repris de la matrice, non relus** : l'échappement des `%{…}` par `rlm_sql_map`, et le comportement de RouterOS sur CHR (**[LABO]**).
- **[À CONFIRMER]** : le format des références des opérateurs, et le fournisseur S3.

## 4. Audit du 13/11/2026 : code ajouté depuis la phase 5 (f8e350d)

- **Méthode** : dix agents indépendants, un par domaine, en lecture seule :
  - argent pawaPay ;
  - comptes et courriel ;
  - quota ;
  - limites M2 et M7 ;
  - portail ;
  - rapprochement ;
  - frontal ;
  - sauvegardes ;
  - CI ;
  - tableau de bord.

  Sept agents correcteurs ont suivi, sur des fichiers séparés, puis une relecture de la règle 4 du code d'argent corrigé, par un agent qui ne l'avait pas écrit. Les sous-agents prévus n'ont pas pu être lancés, faute d'outil dans la session : chaque domaine a été audité par un seul agent.
- **Bilan** : aucun Critique. Cinq constats Élevés, tous corrigés :
  - **relevé vide** → « ÉCART NUL » (rapprochement) ;
  - **inscriptions bloquées pour tous** par une adresse `purge-N@wakatnet.invalid` réservée d'avance (migration 0039) ;
  - **nginx jamais rechargé** après le renouvellement du certificat (`--deploy-hook`) ;
  - **réplique B sans pare-feu public**, puisque le défi ACME échouait avant le rôle parefeu (parefeu placé avant frontal, TLS par nœud) ;
  - **effacement des sauvegardes à J+31 sans aucune alerte**, l'alerte venant du nœud compromis (contrôle externe `infra/surveillance/controle-b2.sh`, ADR 0018).
- **Moyens, corrigés** :
  - plafonds d'enrôlement refaits à la consommation du jeton (0036) ;
  - relecture des clés pawaPay bornée et contrôles sans clé faits d'abord ;
  - limite propre au compte marchand (0037) ;
  - énumération par la longueur du nom ;
  - pré-appropriation d'une adresse ;
  - plafond d'e-mails qui bloquait les comptes neufs (0039) ;
  - rôle `wk_rapprochement` en lecture seule (0038) ;
  - arguments ignorés et débits hors paiement (rapprochement) ;
  - `/etat` sans limite ;
  - `wk_payer` par site ;
  - retour arrière du pare-feu, qui ne valait qu'en mémoire ;
  - montée de Node jamais installée ;
  - droits `root:postgres` de pgBackRest ;
  - capacités de la clé B2 et ordre du RUNBOOK §7 ;
  - CODEOWNERS ;
  - `npm ci --ignore-scripts`, avec retour arrière ;
  - plafond global de scrypt (503).
- **Relecture de la règle 4 des correctifs** : aucun bloquant. Corrigés :
  - **I-1** : ligne hors paiement sans référence (`--hors-sans-reference`) ;
  - **I-2** : tolérance d'horloge sur `expires` ;
  - **M-1** : erreur convertie pour les appelants simultanés ;
  - **M-4** : `[ ]` échappés.

  Laissés, avec leur motif :
  - **M-2** : anciennes clés pendant une panne. La vérification périodique rattrape ;
  - **M-3** : l'expiration des jetons n'est pas stricte en concurrence. La garantie vient du contrôle à la consommation ;
  - **M-5** : REFUNDED à cheval sur deux jours. Aucun remboursement n'est codé ;
  - **M-6** : `wk_rapprochement` lit tous les propriétaires, ce qui est voulu pour l'exploitant.
- **Reste, avec suite recommandée** :
  - un parcours de réinitialisation du mot de passe, pour fermer la dernière course de pré-appropriation ;
  - la continuité de la colonne `Balance` du relevé, dès un export réel ;
  - l'exercice sur B2 réel (capacités de la clé, marques d'effacement) ;
  - la protection de `main`, avec revue des propriétaires du code ;
  - le voisin de NAT d'un même site (M7).
- **Faibles laissés** :
  - F1 et F3 (décisions de Yacouba) ;
  - durée de `/renvoyer` pour un compte sans session : quasi nulle désormais ;
  - réinitialisation des compteurs à minuit UTC ;
  - détournement du point de terminaison WireGuard par un acteur placé sur le chemin (documenté) ;
  - blocage de « J'ai payé » par un voisin qui connaît le numéro (portail, antérieur à f8e350d). **Laissé exprès** : le plafond de 5 essais par numéro et par quart d'heure est l'anti-devinette du suffixe à 4 caractères (65 536 possibilités), soit environ 5 % de chances sur les 7 jours de validité. Le budget par source proposé (avec un plafond de 20 par numéro) porterait ce risque de vol de ticket à environ 20 %. Le blocage, lui, ne fait perdre aucun argent : le code reste sur l'appareil d'achat. L'arbitrage revient à Yacouba.

## 5. Scan de sécurité du 13/11/2026 (dépôt entier, révision 5a76760)

Scan automatisé par plusieurs agents, chaque constat contre-vérifié par un panel indépendant. Six constats ont survécu, tous corrigés dans le même lot. Le rapport brut (`CLAUDE-SECURITY-20261113-204422/`) reste hors du dépôt.

| # | Gravité | Constat | Correctif | Preuve |
|---|---|---|---|---|
| F1 | moyenne | `tronquer()` était quadratique. Un propriétaire pouvait bloquer l'API (un seul fil) avec un long nom de site sur une planche PDF. | Entrée bornée à 1 000 caractères, une seule passe, en-tête calculé une fois par planche (`pdf.ts`). | `exploitation.test.ts` « scan de sécurité F1 » ; mesure : 0,25 ms contre plus de 20 s avant |
| F2 | moyenne | Une inscription non authentifiée remplaçait le mot de passe d'un compte en attente. La confirmation ou la validation par le super-admin activait ensuite le mot de passe de l'attaquant. | Migration 0043 : une inscription ne change jamais le mot de passe. Il se **choisit à la confirmation** (`app.verification_confirmer`). La validation par le super-admin rend un lien à remettre après vérification d'identité (`MISE_EN_PRODUCTION.md`). | `auth.test.ts` « scan de sécurité F2 », `quota.test.ts`, e2e `tableau.ts` |
| F3 | moyenne | Le blocage anti-devinette porte sur la MAC, choisie par le client ; le seuil par routeur ne faisait qu'alerter. | Migration 0044, addendum de l'ADR 0011 : sous alerte `echecs_routeur`, les codes de **forme faible** sont refusés sur ce routeur quelle que soit la MAC. Forme faible : hors forme de la plateforme, ou tout en chiffres. **Partiel**, voir plus bas. | `test_t07_sql.py::test_f3_…` : chaîne réelle, 100 échecs de 100 MAC, alerte, refus |
| F4 | moyenne | L'essai mensuel de restauration démarrait, en `postgres` sur le primaire, une grappe venue du dépôt de sauvegardes partagé : l'autre nœud pouvait y faire exécuter du code, avec un accès superutilisateur à la base vivante. | `essai-restauration.sh` en root. La restauration et les WAL sont tirés sous `postgres`, avant le démarrage. L'instance restaurée tourne sous l'utilisateur dédié **`wakatnet-essai`** : le pg_hba vivant ne lui accorde rien, `/etc/pgbackrest` lui est fermé, et les deux points sont **vérifiés à chaque essai**. Ses réponses sont filtrées par motif ; le JSON est construit par python ; les tablespaces sont replacés dans l'essai. | `infra/noeud/essais/sauvegarde.sh`, étape « Sauvegarde piégée » : une fonction de `pg_catalog` piégée s'exécute bien (témoin positif), sous `wakatnet-essai`, et n'atteint rien. Contre-épreuves : l'ancien script crée une table dans la base vivante ; avec un pg_hba en `trust`, le nouveau refuse de tourner |
| F5 | faible | La limite par appareil de « J'ai payé » reposait sur un jeton choisi par le client. | Migration 0045 : plafond dur de 10 échecs par (site, numéro) sur 24 h. | `portail.test.ts` « scan de sécurité F5/F6 » |
| F6 | faible | Le suffixe de 4 caractères était comparé à la référence du **fournisseur** (pawaPay : hexadécimal, 65 536 valeurs), que le client ne reçoit pas. | Migration 0045 : **liste blanche** des fournisseurs, réduite aujourd'hui au simulateur. pawaPay et CinetPay sont refusés tant que la référence de l'**opérateur** (ADR 0013) n'est pas enregistrée. | même test (pawaPay et CinetPay) |

**Conséquences à connaître**

- **F2** : le formulaire de confirmation demande désormais le mot de passe. Un propriétaire inscrit avant la migration et non confirmé choisit son mot de passe en cliquant sur son lien ; le mot de passe donné à l'inscription ne vaut plus.
- **F3** : pendant une attaque, les tickets Mikhmon courts sont refusés sur le routeur visé, au plus 5 minutes après la dernière rafale.
- **F6** : avec pawaPay et CinetPay, « J'ai payé mais je n'ai pas mon ticket » répond « introuvable » jusqu'à ce que la référence opérateur soit enregistrée. Le client garde son ticket sur l'appareil d'achat ; sinon, c'est le support (recherche par le propriétaire). **À trancher par Yacouba** : enregistrer la référence opérateur dans les adaptateurs, ou garder ce refus.

**Relecture des correctifs (règle 4, second agent, 13/11/2026)**. Elle a renversé deux correctifs de la première version ; tout ce qui suit a été repris :

- **F4 n'était pas fermée.** La première version imposait la configuration, mais les catalogues restaurés restent à la sauvegarde : une fonction de `pg_catalog` piégée s'exécutait en `postgres`. Le banc ne le voyait pas, puisqu'il n'avait pas de piège de catalogue ni de témoin positif. D'où l'utilisateur isolé, et le piège de catalogue ajouté au banc.
- **F3** :
  - le test violait la contrainte de forme des tickets, et le voilà réécrit sur la chaîne réelle ;
  - un ticket Mikhmon de 8 chiffres passait pour sûr, d'où le critère de forme.
- **F2** : la purge des comptes non confirmés de plus de 7 jours pouvait tuer le lien remis par le super-admin. Un compte validé par le super-admin n'est plus purgé (test dans `quota.test.ts`). « Un lien ouvert » ne convenait pas : un tiers en rouvrirait sans fin par `/renvoyer`, et l'adresse ne serait jamais libérée (test existant de l'ADR 0019).
- **F5/F6** :
  - la liste noire devient une liste blanche ;
  - le message « patientez 15 minutes » était faux face au plafond de 24 h ;
  - CinetPay est maintenant testé.

**Reste ouvert, à trancher par Yacouba**

- **F3, devinette sous le seuil.** Un attaquant qui reste sous 100 échecs par minute, en changeant de MAC, ne déclenche jamais l'alerte : environ 140 000 essais par jour et par routeur. Un stock Mikhmon de 4 à 6 chiffres tombe donc en quelques heures au plus. Aucune limite de débit compatible avec le service ne protège un code de 10 000 valeurs. Les vraies parades :
  - réémettre les tickets importés en codes de la plateforme ;
  - ou limiter sur le routeur (option 3 de l'ADR 0011).
- **F3, déni de service.** Un client qui entretient l'alerte (100 codes inventés par minute) bloque les tickets importés du routeur pour tous. C'est le prix de la règle ; les codes de la plateforme ne sont pas touchés. Nœud B en réplique : aucune protection (ADR 0011).
- **F4** : l'essai sur une machine jetable, hors des nœuds (ADR 0018), reste la meilleure option. L'instance isolée garde le réseau et peut joindre les services locaux, comme tout utilisateur sans droits.
- **F6** : enregistrer la référence de l'opérateur dans les adaptateurs, ou garder le refus.
- **F2, mineur** : le mot de passe saisi à l'inscription ne sert plus. Le retirer du formulaire est une décision d'interface.

**Seconde relecture des correctifs (13/11/2026)**

- **Verdict** : F4 tient pour l'essentiel. Le code de la sauvegarde ne s'exécute plus en `postgres`, aucune sortie de l'instance n'est interprétée par le shell root, `chown -R` et `rm -rf` ne suivent pas les liens, et les capacités de l'unité suffisent. F3 n'a pas d'oracle (`upper()` en tête) et son test est valide. Pas de régression bloquante sur F2, F5 et F6.
- **Corrigés aussitôt** :
  - les sessions d'un compte sont closes quand il confirme son adresse et pose son mot de passe ;
  - le test F2 compare l'empreinte du mot de passe avant et après la seconde inscription ;
  - l'utilisateur isolé n'a aucun groupe secondaire (`--clear-groups`), et l'essai vérifie qu'il ne lit pas `/etc/wakatnet` ;
  - le journal de l'instance est lu sous l'utilisateur isolé.
- **Ouverts, avec leur suite recommandée** :
  - **F3, attaque lente** : sous 100 échecs par minute, avec des MAC tournantes, jamais d'alerte (déjà noté plus haut). Suite : un budget bas d'échecs de forme faible par routeur sur une heure (par exemple 30), écrit par `post_auth`. Sous attaque, un ticket importé trouvé reçoit la même réponse qu'un code inconnu, ce qui couvre aussi les préfixes Mikhmon. **À décider avec la réémission des tickets importés.**
  - **F4, réseau et sockets locales** : l'instance isolée joint l'API en direct sur 127.0.0.1:3000, où elle peut forger `X-Forwarded-For` et sauter les limites de nginx. Elle peut aussi deviner les mots de passe des rôles PostgreSQL, ou joindre l'autre nœud et Internet. Suite : la lancer sous `unshare --net`, ou une règle nftables `meta skuid wakatnet-essai reject` dans le rôle parefeu.
  - **F4, ressources** : une sauvegarde énorme, ou du code isolé, peut remplir le disque du primaire ou mobiliser sa mémoire. Suite :
    - `MemoryMax`, `TasksMax` et `OOMScoreAdjust` dans l'unité ;
    - un système de fichiers dédié à `/var/lib/wakatnet-essai` ;
    - une comparaison de la taille annoncée avec l'espace libre.
  - **F4, banc** : il lance le script en root hors de systemd, donc ni les capacités, ni `ProtectSystem`, ni `StateDirectory` ne sont exercés, ni le réseau dans le piège. Suite : le banc Ansible nocturne (nœuds sous systemd), et un piège réseau.
  - **F4, restauration sous `postgres`** : un manifeste piégé ne trouverait que les chemins accessibles en écriture de l'unité, dont `/var/lib/wakatnet`. Suite : un troisième utilisateur pour la restauration.
  - **F5/F6** : un tiers qui connaît le numéro bloque la récupération pendant 24 h. Impact nul tant que la récupération est coupée en production.

**Points ouverts corrigés (« corrige les manquants », décisions de Yacouba du 13/11/2026)**

- **F3, attaque lente : budget horaire** (migrations 0046 et 0047).
  - Chaque échec est marqué « forme faible » ou non, sans jamais garder le code.
  - Au-delà de 30 échecs de forme faible en une heure sur un routeur (`devinette_faibles_par_heure`, `devinette_faibles_fenetre_s`), ou pendant une alerte, le routeur est **restreint** : les codes faibles y sont refusés, et un ticket importé de forme forte (préfixe Mikhmon) reçoit la réponse d'un code inconnu.
  - Les codes de la plateforme restent servis.
  - Test : `test_f3_budget_horaire_d_echecs_faibles_attaque_lente`.
  - **Reste**, en connaissance de cause :
    - 30 essais par heure, soit 720 par jour, contre un stock Mikhmon de 4 chiffres (10 000 valeurs) : la réémission reste la parade de fond ;
    - un client qui échoue exprès 30 fois retient les tickets importés du routeur pendant une heure.
- **F4, réseau et sockets** : l'instance restaurée et tout ce qu'elle lance tournent dans leurs propres espaces de noms (`unshare --net --mount`).
  - Ils n'ont aucune interface réseau, ni Internet, ni l'autre nœud, ni l'API ou FreeRADIUS en local.
  - La socket et le répertoire de la base vivante, `/etc/pgbackrest`, `/etc/wakatnet` et `/var/lib/wakatnet` y sont masqués.
  - L'essai vérifie ces masquages et cette absence de réseau avant de restaurer, et refuse de tourner sinon.
  - L'unité gagne `CAP_SYS_ADMIN` et `RestrictNamespaces=net mnt`, que setpriv abandonne.
- **F4, ressources** : `OOMScoreAdjust=1000`, `MemoryHigh=25%`, `MemoryMax=40%`, `TasksMax=512`, `CPUWeight=20`. Avant de restaurer, l'essai compare la taille annoncée de la sauvegarde (plus 20 %) à la place libre, en gardant 10 % du disque ou 2 Gio.
- **F4, banc** : le conteneur tourne en `--privileged` pour les espaces de noms, et le piège essaie aussi le réseau. Preuves :
  - le piège s'exécute sous `wakatnet-essai`, **sans réseau**, et n'atteint rien ;
  - contre-épreuve 1 : l'ancien script exécute le piège **avec réseau** en `postgres`, et crée une table dans la base vivante ;
  - contre-épreuve 2 : avec un pg_hba en `trust`, le nouveau script refuse de tourner ;
  - contre-épreuve 3 : sans espaces de noms (conteneur non privilégié), il refuse aussi.
- **F6** : refus gardé (décision de Yacouba). Le client garde son ticket sur l'appareil d'achat ; sinon, c'est le support.

**Toujours ouverts**

- La restauration elle-même tourne sous `postgres`. Un manifeste piégé n'atteindrait que les chemins accessibles en écriture de l'unité. Un troisième utilisateur dédié à la restauration est la suite.
- Disque : le code isolé peut encore remplir `$RACINE` pendant l'essai. Un système de fichiers dédié à `/var/lib/wakatnet-essai` le borne.
- L'unité et le rôle Ansible ne sont exercés que par le banc nocturne : il faut le surveiller à la première nuit.
- F2 : le mot de passe saisi à l'inscription ne sert plus (décision d'interface).

**Troisième relecture (13/11/2026), corrigée aussitôt**

- **F3** :
  - la 0044, déjà poussée, n'est plus modifiée : le budget passe dans la 0046, idempotente, avec la colonne en tête (ordre des verrous de `post_auth`, pas d'interblocage) ;
  - la restriction est évaluée pour toute saisie (pas d'oracle de durée) ;
  - une alerte `budget_routeur` est posée, et un paramètre à 0 vaut 1 ;
  - sous alerte, le test couvre aussi l'import de forme forte.
- **F4** :
  - `/run` est masqué en entier (D-Bus, systemd-resolved : plus de DNS détourné), ainsi que `/var/spool` et `/var/log` ;
  - `/tmp`, `/var/tmp` et `/dev/shm` sont des tmpfs de 64 Mio ;
  - l'instance a son propre espace de noms IPC, et `setpriv` passe en `--no-new-privs --bounding-set=-all` ;
  - l'état du dépôt n'est lu qu'une fois, et `restore --set` restaure la sauvegarde contrôlée ;
  - la plage de WAL est bornée (4096 segments) et comptée dans la place disque ;
  - `postgresql.auto.conf` est vidé sous `postgres` ;
  - banc : une sonde distingue « fermé » d'une erreur quelconque et exige un `/run` vide. Le piège voit `ferme errno=101 run=` ; l'ancien script voit `ouvert run=5` et crée la table vivante.
- **Restent ouverts** :
  - budget par propriétaire (30 × N routeurs) ;
  - restauration sous un troisième utilisateur ;
  - espace de noms PID (le nettoyage repose sur `pkill` et le cgroup de l'unité) ;
  - `SystemCallFilter` ;
  - disque dédié à l'essai ;
  - unité et rôle Ansible à éprouver sur systemd (banc nocturne).

**Derniers points ouverts corrigés (« corrige les manquants », 14/11/2026)**

- **F3, budget par propriétaire** (migrations 0048, idempotente, et 0049, index `CONCURRENTLY`). Au-delà de 60 échecs de forme faible en une heure sur l'ensemble des routeurs d'un propriétaire (`devinette_faibles_par_proprietaire`), tous ses routeurs sont restreints, et une alerte `budget_proprietaire` est posée. Cela ferme les « 30 × N routeurs ».
  - Test : `test_f3_budget_par_proprietaire_echecs_repartis_sur_ses_routeurs`, avec des échecs répartis sur trois routeurs dont aucun n'atteint son propre budget.
  - Prix : 60 échecs volontaires retiennent pendant une heure les tickets importés de tout le propriétaire.
- **F4, espace PID** : le serveur restauré est PID 1 de son espace. Le tuer tue tout ce qu'il a lancé, et `/proc` ne montre que l'essai.
- **F4, restauration isolée** : pgBackRest (restauration et WAL) tourne sous `postgres`, dans un espace de montage où la base vivante (`data_directory` lu en direct), `/var/lib/wakatnet`, `/etc/wakatnet` et la socket sont masqués, et dans son propre espace PID. Un manifeste piégé n'atteint que l'essai. Ce choix remplace le troisième utilisateur, qui aurait exigé de changer les groupes de `/etc/pgbackrest` et de redémarrer PostgreSQL.
- **F4, disque** : un surveillant mesure la place libre pendant tout l'essai, et à chaque étape. Sous la marge, il tue la restauration et l'instance, et l'essai échoue. La taille annoncée par le dépôt n'est plus la seule défense. Le banc le prouve : la sauvegarde piégée écrit 400 Mio, l'essai est arrêté et la copie effacée.
- **F4, unité** : `SystemCallFilter=@system-service @mount`, `RestrictNamespaces=net mnt ipc pid`, et `CAP_SETPCAP` pour que setpriv vide le jeu limite.
- **Unité éprouvée sous systemd** : l'étape « 5 bis » du banc Ansible (Debian 13 et Ubuntu 24.04) lance la vraie unité, et la restauration réussit. Elle a trouvé deux défauts que le banc Docker ne voyait pas :
  - `CAP_SETPCAP` manquait : l'isolement échouait, et l'essai refusait de tourner ;
  - les droits de `/etc/wakatnet` dans le banc (0755) n'étaient pas ceux du rôle (0750) : l'essai refusait de tourner, à raison.

**Toujours ouverts, décisions de Yacouba**

- **Réémission des tickets Mikhmon** : elle invaliderait des tickets peut-être déjà vendus. Seul le stock non distribué pourrait l'être sans risque.
- **F2** : le mot de passe saisi à l'inscription ne sert plus (choix d'interface).

**Quatrième relecture (14/11/2026), corrigée aussitôt**

- `--kill-child` d'unshare était annulé par le changement d'uid de setpriv. `setpriv --pdeathsig KILL` le rétablit : tuer `unshare` tue l'espace.
- **Surveillant** :
  - il couvre aussi `archive-get` (fonction `suivi`) ;
  - il continue de tuer après un premier déclenchement ;
  - il échoue fermé si `df` échoue ;
  - son message lui est propre (« arrêté par le surveillant »).
- **Restauration** : `/var/spool/pgbackrest` et `/var/log/pgbackrest` sont masqués ; ses journaux et verrous vont dans l'essai. Tout lien de la copie qui sort de la copie fait refuser le démarrage.
- **Alerte `budget_proprietaire`** : un index (0049), et un verrou consultatif par propriétaire contre le doublon.
- **Unité** : `SystemCallFilter=~@keyring io_uring_*` (le commentaire disait vrai, pas le filtre).
- **Tests** :
  - le budget par propriétaire est contrôlé sur ses trois routeurs, pour un autre propriétaire (non touché), avec une seule alerte au-delà du seuil, et une restauration exacte des paramètres ;
  - le rejeu de 0046 ne peut plus casser sur une alerte `budget_proprietaire` ;
  - l'étape « Disque » remplit sans fin, au premier plan de la requête, et vérifie qu'aucun processus ne survit et que la place est rendue.
- **Étape 5 bis** : elle prouve que le durcissement de l'unité laisse passer un essai sain sous systemd. L'isolement et le surveillant, eux, sont prouvés par le banc Docker.

**Décisions de Yacouba appliquées (14/11/2026)**

- **Réémission des tickets importés de Mikhmon** (migration 0050, `/v1/imports/reemission`, écran « Tickets papier ») :
  - le propriétaire remplace d'un coup les tickets importés **jamais utilisés** (ni activation, ni connexion acceptée, ni expiration) par des codes de la plateforme ;
  - chaque nouveau ticket garde le forfait figé de l'ancien et va dans des lots ordinaires, imprimables en PDF ;
  - l'ancien **garde son code**, mais il est **expiré** et lié à son remplaçant (`reemis_par`). Saisi, il répond « expiré » ; c'est un « inconnu » qui épuiserait le budget anti-devinette. Un réimport le voit en doublon, et le support sait quel ticket le remplace ;
  - **le premier activé gagne** : une connexion avec l'ancien code pendant la réémission active l'ancien (l'accounting cherche par code). À chaque tour des tâches, `app.reemission_reconcilier()` expire alors le remplaçant resté inutilisé ; si les deux ont servi, il pose l'alerte `reemission_double` ;
  - le traitement se fait par tranches de 500, en transactions courtes, et chaque ticket est revérifié une fois verrouillé ;
  - aucun crédit n'est consommé, puisque c'est du remplacement un pour un (le plafond du découvert ne s'applique pas ; les frais papier se prélèvent à l'activation, sur la copie figée identique) ;
  - l'écran demande confirmation : les tickets déjà vendus mais pas encore utilisés sont remplacés eux aussi. Il rappelle de supprimer ces tickets du routeur, au cas où le routeur consulterait sa base locale avant RADIUS (LABO-08).

  Relecture par un second agent (règle 4) : la première version renommait l'ancien code. Une connexion pendant la réémission donnait alors deux tickets pour un seul paiement, et un réimport faisait revivre l'ancien. Les deux défauts sont corrigés par la conception ci-dessus, et prouvés par `import.test.ts`.

  C'est la parade de fond contre la devinette des codes courts : les budgets de l'ADR 0011 n'en sont que le filet.
- **Inscription sans mot de passe** : le formulaire ne le demande plus, puisqu'il se choisit à la confirmation (F2). L'API ignore un `mot_de_passe` envoyé par un ancien client, et pose un secret aléatoire haché, avec la même durée de réponse.
- **Reste, antérieur à ce lot** : la réponse à l'inscription attend l'envoi de l'e-mail (lien ou avis), qui ne fait pas le même travail en base dans les deux cas. Sa durée peut donc encore distinguer une adresse libre d'une adresse inscrite. Remède : répondre d'abord, puis envoyer, comme le fait déjà `/v1/verification/renvoyer`.
