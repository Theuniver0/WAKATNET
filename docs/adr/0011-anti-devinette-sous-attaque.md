# ADR 0011 — Anti-devinette sous attaque : un index par routeur que la requête par MAC ne peut pas prendre

- **Statut** : **accepté le 12/11/2026, par délégation de Yacouba** (« fais tout le travail sans poser de question »). Suite de la mesure du ticket 10.
- **Références** : `radius/tests/perf/RAPPORT.md` §7 ; ADR 0006 §4 et §11 ; migration `infra/sql/radius/0012_radius_devinette_sous_attaque.sans_transaction.sql` ; `radius/tests/test_devinette_attaque_sql.py`.

## Contexte (mesuré)

Pour savoir si une MAC est bloquée, `trop_de_tentatives` compte ses échecs récents sur un routeur. Sous attaque, le routeur reçoit beaucoup d'échecs récents, avec des MAC toutes différentes. Les statistiques, elles, ne voient pas encore ces lignes : l'`autoanalyze` n'agit qu'après environ 10 % de lignes nouvelles. Le planificateur prenait alors l'index **par routeur**, `(router_id, at)`, et filtrait la MAC. Le coût d'`authorize` pour un **vrai** client croissait avec l'attaque : 16,5 ms à 50 000 échecs récents, **44 ms à 100 000**, soit au bord de l'objectif de 50 ms.

## Options

1. **Rafraîchir les statistiques plus souvent** (`autovacuum_analyze_scale_factor = 0`, seuil de 5 000). C'est minimal, mais cela dépend du cycle d'autovacuum, avec environ une minute dégradée au pire, et d'un coût d'`ANALYZE` sur une grande table.
2. **Rendre l'index par routeur inutilisable par la requête par MAC.** C'est structurel et indépendant des statistiques.
3. **Limiter en amont** (pare-feu du nœud, hotspot RouterOS). C'est utile, mais hors du nœud et non prouvé ici.

## Décision

**Option 2.**
- L'index par routeur porte sur l'expression `(router_id + 0)`. Une condition `router_id = …` ne peut pas s'en servir ; seul le compte d'alerte par routeur de `post_auth`, écrit `router_id + 0 = …`, l'utilise.
- **En plus**, les deux comptes d'alerte de `post_auth` sont bornés à leur seuil (`LIMIT` 10 et 100) : leur coût ne croît plus avec le volume.
- L'option 3 reste souhaitable (phase 5 et essai sur CHR).

## Preuves

- **Rouge sur `main`, vert après la migration** (`test_devinette_attaque_sql.py`) : les compteurs d'index de PostgreSQL montrent que 5 `authorize` d'un vrai client, sur un routeur qui a 20 000 échecs récents et des statistiques non rafraîchies, parcouraient l'index par routeur 5 fois. Après la migration : **0 fois**.
- L'alerte par routeur reste levée, une fois par fenêtre. Le seuil de 99, 100 et 120 échecs du ticket 07 est toujours vert.
- **Mesure** (`perf/resultats/attaque-avant-0012.txt` et `attaque-apres-0012.txt`) :

  | Échecs récents sur le routeur | Avant (ms) | Après (ms) |
  |---|---|---|
  | 0 | 1,6 | 1,1 |
  | 10 000 | 3,6 | 0,55 |
  | 50 000 | 16,5 | 0,39 |
  | 100 000 | 44,0 | 0,46 |

## Application de la migration (revue du 12/11/2026)

- La première version de 0012 était transactionnelle. Une construction d'index ordinaire (verrou SHARE) y bloquait les INSERT de `post_auth` pendant toute sa durée. Puis le `DROP INDEX`, en attente derrière un lecteur long, aurait fait attendre tous les `authorize` derrière lui, au-delà de leur `statement_timeout`.
- Elle est remplacée par `0012_…sans_transaction.sql` : `CREATE INDEX CONCURRENTLY` et `DROP INDEX CONCURRENTLY`, étapes idempotentes, un index invalide laissé par une construction interrompue étant d'abord supprimé. `migrer.sh` l'applique hors transaction, avec `lock_timeout` et de nouveaux essais (ADR 0008, amendement du 12/11/2026).
- **Remplacement d'une migration déjà fusionnée** : la version transactionnelle n'a été appliquée qu'à des piles de test jetables. La pile de dev ne lance pas `migrer.sh`, et il n'existe pas encore de nœud. Sur une base qui l'aurait appliquée, la nouvelle migration crée l'index sous son nom définitif (`auth_log_echecs_routeur_expr`) et supprime l'ancien.
- **Prouvé** (`test_devinette_attaque_sql.py`) : la migration est rejouée pendant qu'une transaction longue lit `auth_log`. Elle attend (« verrou indisponible ») puis aboutit, et pendant ce temps `authorize` et `post_auth` répondent en 52 ms au pire.

## Conséquences

- Toute nouvelle requête qui voudrait l'index par routeur doit écrire `router_id + 0 = …`. Cette contrainte est écrite dans la migration et ici.
- Le contrat de l'ADR 0006 (§4 et §11 : seuils, blocage, alertes) ne change pas.
