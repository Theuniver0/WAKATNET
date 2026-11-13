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
| F4 | Faible | Corps bruts des webhooks gardés sans durée (numéro du payeur probable) | Durée **[À CONFIRMER]** dans `docs/CONFORMITE.md` (T2) |
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
  - blocage de « J'ai payé » par un voisin qui connaît le numéro (portail, antérieur à f8e350d).
