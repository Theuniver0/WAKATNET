# Normes de contribution — WAKATNET

Référence « Standards » des revues. Chaque règle est vérifiable à la relecture. En cas de doute, `docs/SPEC.md` fait foi.

## 1. Chemin critique (SPEC §4, règles 1, 2 et 5)

- **C1.** L'authentification ne passe que par : routeur → WireGuard → FreeRADIUS → PostgreSQL local. Aucun appel à Node, Redis ou HTTP depuis FreeRADIUS. Un module `rest`, `exec` ou `perl`/`python` dans le chemin `authorize`/`authenticate` est un refus de revue.
- **C2.** Toute la décision d'accès vit dans des fonctions SQL versionnées du schéma `radius` (`infra/sql/radius/`). Aucune logique d'accès dans `unlang` au-delà de l'appel de ces fonctions.
- **C3.** L'accounting ne bloque jamais l'authentification : FreeRADIUS écrit dans un fichier `detail`, un lecteur le rejoue vers PostgreSQL. L'échec d'une écriture ne transforme jamais un Access-Accept en rejet.
- **C4.** L'heure du routeur n'est jamais utilisée pour décider (`Event-Timestamp` est journalisé, rien de plus). Les décisions d'accès utilisent `now()` de PostgreSQL. Les événements d'accounting sont datés à leur **réception par le nœud** (`Packet-Original-Timestamp`), qui partage l'horloge de la base ; jamais à l'heure de leur rejeu (ADR 0006 §7). En test, l'instant de référence suit l'ADR 0007 ; en production, seul `now()` vaut.
- **C5.** Toute modification d'une fonction `radius.*` arrive avec son test (matrice T du §5.6) dans le même commit.
- **C6.** Un seul changement à la fois sur le chemin critique : un commit ne modifie pas à la fois `infra/freeradius/` et `infra/sql/radius/` sans nécessité démontrée dans son message.
- **C7.** Le rôle PostgreSQL de FreeRADIUS ne peut qu'exécuter les fonctions `radius.*` (`SECURITY DEFINER`) ; il n'a aucun droit sur les tables, ni sur les schémas `app` et `ledger`.

## 2. Argent (SPEC §8.1, règles 3 et 4 du §13)

- **A1.** Montants en `BIGINT` (SQL) / `bigint` ou entier sûr (TypeScript), en XOF entiers. **Aucun flottant**, nulle part : ni `NUMERIC` à décimales, ni `float`, ni `number` issu d'une division non arrondie explicitement.
- **A2.** Grand livre en **ajout seul** : ni `UPDATE` ni `DELETE` sur `ledger.*`. Une correction est une contre-écriture. Les droits SQL l'imposent (pas seulement la convention).
- **A3.** Chaque écriture porte : l'objet métier concerné, une clé d'idempotence unique, le taux de commission figé au moment de la vente.
- **A4.** Commission = `montant × commission_bps / 10000`, arrondie au franc le plus proche, 0,5 arrondi au franc supérieur. Testée sur 100, 150, 200, 300, 500 et 1 000 F.
- **A5.** Seul un webhook signé ou un appel de vérification serveur à serveur fait passer un paiement à `SUCCEEDED`. Jamais un retour navigateur.
- **A6.** Tout code qui touche `ledger`, `payment` ou `payout` exige des tests de propriétés (Σ débits = Σ crédits ; rejeu = mêmes soldes ; aucun double comptage) **et** une relecture par un second agent.
- **A7.** Une vente confirmée = une seule transaction SQL : écritures + ticket + lien paiement ↔ ticket.
- **A8.** Un adaptateur de paiement normalise les « unités mineures » du fournisseur vers XOF entiers, avec un test.

## 3. Cloisonnement (SPEC §4, règle 4)

- **I1.** `tenant_id` sur toute table métier ; Row Level Security PostgreSQL activée en défense en profondeur.
- **I2.** Toute nouvelle route ou requête multi-propriétaires a un test d'isolement (A ne voit ni ne modifie B).

## 4. Secrets (SPEC §10.1, règle 5 du §13)

- **S1.** Aucun secret dans le dépôt, les logs, les `.rsc` versionnés, la conversation ou une ligne de commande. Les valeurs d'exemple sont des marqueurs explicites (`SECRET_UNIQUE_DU_ROUTEUR`, `CHANGE_ME`).
- **S2.** Les fichiers de secrets sont créés et remplis à la main par Yacouba ; ils sont listés dans `.gitignore`.
- **S3.** Secrets et clés API chiffrés au repos ; jamais réaffichés après saisie.

## 5. Scripts RouterOS (SPEC §6.2)

- **R1.** Idempotent : rejouer le script ne casse rien et ne duplique rien.
- **R2.** Additif : ne supprime et ne réordonne aucun objet existant non marqué `wakatnet`.
- **R3.** Chaque objet créé porte `comment="wakatnet…"` (commentaire en français).
- **R4.** Anti-lockout : aucun changement des accès d'administration ; pare-feu ouvert au strict nécessaire, depuis l'interface du tunnel seulement.
- **R5.** `use-radius=yes` posé en dernier, après preuve du tunnel (handshake récent + ping des deux nœuds) ; sinon arrêt avec message clair, hotspot inchangé.
- **R6.** Réversible : `wakatnet-uninstall.rsc` retire tout ce qui porte le commentaire et restaure le profil hotspot.
- **R7.** Chemin de commande complet, idiome `[find ...]` pour toute modification.
- **R8.** Tout `.rsc` est exécuté sur CHR (routeur vierge **et** routeur déjà configuré) avant d'être montré ; la preuve est jointe.

## 6. Preuves, documents, commits

- **P1.** Jamais « c'est fait » sans preuve (sortie de test, log `radiusd -X`, capture).
- **P2.** Documents, PRD, tickets, ADR et messages de commit **en français**.
- **P3.** Chaque commit cite le chemin de son ticket (`.scratch/phase-N-titre/issues/NN-titre.md`) ou, hors ticket, la section de `docs/SPEC.md` qu'il réalise.
- **P4.** Un ADR (`docs/adr/NNNN-titre.md`) par décision d'architecture ; `docs/JOURNAL.md` mis à jour à chaque session.
- **P5.** Une idée hors périmètre (SPEC §2) va dans `docs/IDEES.md`, pas dans le code.
- **P6.** Une branche par ticket (`ticket/NN-titre`), fusion locale dans `main` après revue sans réserve et tests verts.
- **P7.** Fins de ligne LF (voir `.gitattributes`), sauf `*.bat` / `*.cmd`.
