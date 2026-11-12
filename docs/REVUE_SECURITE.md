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
| M1 | Moyen | Aucune limite de débit sur l'API ni sur le portail (SPEC §10.1) ; `/v1/connexion` calcule scrypt pour tout venant | **Décision attendue** : au proxy inverse (pas encore dans le dépôt) ou dans l'application (`@fastify/rate-limit`, nouvelle dépendance). Les deux exigent `trustProxy` réglé. Réduit en partie par M2 |
| M2 | Moyen | Verrou des connexions contourné par des requêtes parallèles (~1 000 essais par 15 min) | **Corrigé** (migration 0030, même mécanique qu'E2). Test : 20 connexions parallèles donnent 5 vérifiées au plus, et 15 refus 429. **Reste** : quiconque connaît l'adresse du super-admin peut le tenir bloqué. Une clé (adresse, IP) attend `trustProxy` (M1) |
| M3 | Moyen | Impossible de retirer l'accès d'un gérant ou d'un vendeur, qui garde ses sessions et lit les codes des nouveaux lots | **Corrigé**. `PUT /v1/utilisateurs/:id { actif: false }`, propriétaire seulement : sessions fermées sur-le-champ, action auditée. Test : refus d'un autre propriétaire (404) et d'un gérant (403), session du vendeur tombée |
| M4 | Moyen | Inscription ouverte : épuisement des adresses de l'overlay (~64 500 enrôlements) et `wg0` gonflé | **Décision attendue** : quota de routeurs et de jetons actifs par propriétaire, et vérification de l'adresse e-mail (ADR 0001 §5 : accès ouvert) |
| M5 | Moyen | MAC, IP et page demandée par le client final écrites dans le journal de l'API | **Corrigé**. `redirection.html` ne transmet plus `mac` ni `ip`, que le portail ne lisait pas ; le journal n'écrit plus la chaîne de requête. Tests : `config.test.ts`, e2e d'achat |
| M6 | Moyen | Échec de l'essai mensuel de restauration (écart du grand livre compris) sans alerte | **Corrigé**. Règle `essai_restauration` : échec, essai de plus de 35 jours, ou essai jamais lancé, sur le primaire. Test : `sante.test.ts` |
| M7 | Moyen | La garde de 30 paiements par minute et par site sert à bloquer la vente en ligne d'un concurrent | **Décision attendue**, liée à M1 : compter la garde par IP source (l'IP WAN du routeur garde le budget du site) |
| M8 | Moyen | Un nœud compromis peut effacer les sauvegardes (clés S3 sur les deux nœuds) | **Décision attendue** avec le fournisseur S3 ([À CONFIRMER]) : verrouillage d'objets ou versionnement de 35 jours ou plus, clés sans droit d'effacement définitif |
| F1 | Faible | L'auto-connexion après achat envoie le code en clair sur le Wi-Fi ouvert | Choix de l'ADR 0013 §10 ; passer en HTTPS là où le hotspot le permet : **décision** |
| F2 | Faible | Robustesse de la récupération d'un achat liée au format de la référence de l'opérateur | **[LABO]** ; le refus des références finissant par `-` ou `_` est à revoir avec le vrai adaptateur |
| F3 | Faible | L'import Mikhmon ne vérifie pas le plafond du découvert | **Décision** (ADR 0002) |
| F4 | Faible | Corps bruts des webhooks gardés sans durée (numéro du payeur probable) | Durée **[À CONFIRMER]** dans `docs/CONFORMITE.md` (T2) |
| F5 | Faible | L'interface publique des nœuds laisse tout passer (seuls `wg0` et `wk-noeuds` sont filtrés) | **À faire avant G-PILOTE** : politique `drop` en entrée publique sauf SSH, WireGuard et 443. Elle touche l'accès SSH : à poser et vérifier depuis une seconde session (anti-lockout) |
| F6 | Faible | `wk_rewind`, qui lit tout le répertoire de données, était admis en local | **Corrigé** : `pg_hba.conf` le refuse en local, de même que `wk_replication` ; seul l'autre nœud les utilise |
| F7 | Faible | Une restauration d'essai interrompue (SIGKILL) laissait une base en clair sur disque | **Corrigé** : les restes sont effacés au début de l'essai, qui ne tourne plus que sur le primaire |
| F8 | Faible | L'exemple de `admin-creer.ts` écrivait le mot de passe dans l'historique du shell | **Corrigé** : exemple avec `read -rs` |
| F9 | Faible | Énumération des adresses inscrites (409) | **Décision**, liée à la vérification de l'adresse (M4) |
| F10 | Faible | Portail, API et tableau de bord répondent sur tous les noms d'hôte | **À faire** avec le proxy inverse (M1) : filtrer les routes selon `Host` |
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
