# 01 — Contrats de la phase 1 (ADR)

**PRD** : `../PRD.md` · **Type** : décision (aucun code de production) · **Dépend de** : rien

## Objectif
Figer les contrats avant tout code de production (§14.3, « contrats d'abord »).

## À livrer
- `docs/adr/0006-contrats-radius.md` :
  - signatures exactes de `radius.client_lookup`, `radius.authorize`, `radius.post_auth`, `radius.acct_start / acct_interim / acct_stop / acct_on_off` : paramètres, types, valeurs renvoyées ;
  - liste des causes de refus du §5.2 et leur texte exact dans `Reply-Message` ;
  - attributs de réponse : `Session-Timeout`, `Idle-Timeout`, `Mikrotik-Rate-Limit`, `Port-Limit`, `Acct-Interim-Interval`.
- `docs/adr/0007-instant-de-reference-en-test.md` : au moins 3 formes comparées (§14.4). Par exemple :
  - (a) paramètre `p_now` par défaut à `now()` ;
  - (b) réglage de session `wakatnet.now`, honoré seulement par un rôle de test ;
  - (c) temps simulé par `faketime` sur le serveur PostgreSQL de test.

  Choix motivé. Règle impérative : aucun chemin de production ne doit pouvoir déplacer l'horloge.
- `docs/adr/0008-migrations-et-schema-app.md` :
  - outil de migration SQL pour `radius` (fichiers numérotés et table de suivi, ou un outil existant) ;
  - place des tables `tenant`, `site`, `router`, `plan`, `voucher`, `session`, `auth_log` en phase 1 : Prisma tout de suite (§9), ou SQL d'abord puis Prisma en phase 2. Les conséquences de chaque option sont comparées.

## Critères d'acceptation
- Les trois ADR sont acceptés par Yacouba.
- Chaque signature indique, pour chaque ligne T de la matrice, la fonction qui la sert.

## Hors périmètre
Tout code de production.
