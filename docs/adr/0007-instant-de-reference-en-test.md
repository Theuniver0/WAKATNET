# ADR 0007 — Instant de référence dans les tests

- **Statut** : proposé le 11/11/2026 (ticket 01) ; à accepter par Yacouba.
- **Références** : `docs/SPEC.md` §4 (règle 5), §5.6 (T3, T4), §14.4 ; `CONTRIBUTING.md` C4 ; ADR 0006 §7.

## Problème

T3 et T4 dépendent du temps : 20 minutes consommées, ou une activation il y a 5 h 01. Les tests doivent être déterministes. En production, seul `now()` de PostgreSQL fait foi (règle 5), et **aucun chemin de production ne doit pouvoir déplacer l'horloge**.

## Formes comparées

| Forme | Principe | Pour | Contre |
|---|---|---|---|
| (a) Paramètre `p_now` | `radius._authorize_at(…, p_now)`, avec une enveloppe publique qui passe `now()` | Logique pure, testable en SQL | Si `wk_radius` pouvait appeler la fonction interne, il pourrait déplacer l'horloge. Il faut donc **refuser EXECUTE** sur `_authorize_at` à `wk_radius`. |
| (b) Réglage de session `wakatnet.now` | La fonction lit le réglage s'il est défini | Aucun changement de signature | **Rejetée.** Tout rôle peut faire `SET` sur un réglage personnalisé. Dans une fonction `SECURITY DEFINER`, `current_user` est le propriétaire, et seul `session_user` aiderait. Un oubli rouvre la faille. |
| (c) `faketime` | Horloge simulée pour tout le serveur PostgreSQL de test | Aucun code de test dans les fonctions | Configuration de test différente de la production. Lourd, et sans effet sur le contenu du fichier `detail`. |
| (d) **Données datées dans le passé** | Les tests créent `activated_at = now() - '5h01m'`, des sessions avec `received_at` passé, etc. | Passe par la configuration FreeRADIUS **de production, inchangée** ; rien à protéger | Ne teste pas un instant précis à la seconde près : les assertions tolèrent l'écart d'exécution, par exemple `Session-Timeout ∈ [2399 ; 2400]`. |

## Décision

1. **Tests de bout en bout (radclient → FreeRADIUS → base) : forme (d).** La configuration FreeRADIUS de production n'est pas modifiée. Les assertions dépendant du temps admettent une tolérance explicite d'une seconde au plus.
2. **Tests de propriétés et cas limites en SQL : forme (a)**, sur `radius._authorize_at(…, p_now)`, appelée par le rôle de test `wk_test`. Ce rôle n'est créé que par les fixtures de test, jamais par les migrations de production.
3. Forme (b) rejetée. Forme (c) non retenue.

## Garde-fous (tests obligatoires)

- **Test négatif** : connecté en `wk_radius`, l'appel à `radius._authorize_at` est refusé (permission denied), et `SET wakatnet.now = …` n'a aucun effet sur la réponse de `radius.authorize`.
- **Migrations de production propres** : un test liste les objets créés par `infra/sql/` seul, sur une base vierge, et vérifie qu'aucun rôle, aucune fonction ni aucune extension de test n'y figure.
- **`radius.authorize`** n'a pas de paramètre de temps, et appelle toujours `_authorize_at` avec `now()`.
