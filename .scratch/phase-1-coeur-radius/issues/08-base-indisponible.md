# 08 — Comportement quand PostgreSQL est indisponible

**PRD** : `../PRD.md` · **Matrice** : préparation de T13 · **Dépend de** : 07

## Objectif
Le labo a montré que, base arrêtée, FreeRADIUS renvoie Access-Reject à un client en cache (L6). Or un Reject empêche peut-être RouterOS de basculer vers B (LABO-16). Le silence (L6e) le permettrait, mais **sans** rendre muet tout le parc à la moindre erreur SQL.

## À livrer
- ADR « base indisponible », provisoire jusqu'à LABO-16 :
  - silence (`do_not_respond`) **seulement** quand `client_lookup` ou `authorize` échoue pour une raison de connexion ou de délai ;
  - une erreur de donnée donne un refus codé (garanti par les tickets 03 et 05) ;
  - un échec de `post_auth` est sans effet (ticket 07).
- Délais : `connect_timeout`, délai de requête du pilote (à vérifier en 3.2.10), `ALTER ROLE wk_radius SET statement_timeout`, tous inférieurs au `timeout` de RouterOS.
- Test de fumée après chaque migration : `authorize` et `client_lookup` exécutés en tant que `wk_radius`.
- Compteur des `do_not_respond`, exposé pour les futures alertes (§10.3).
- Démarrage de radiusd sans base (`pool { start = 0 }`, L6d).

## Critères d'acceptation
- `docker compose stop postgres` : aucune réponse d'authentification ; Accounting-Response toujours envoyée.
- `docker compose pause postgres` (base qui ne répond plus) : avec 50 Access-Request en attente, Accounting-Response en moins de 100 ms, et aucun épuisement du pool qui bloquerait l'accounting.
- `GRANT EXECUTE` retiré, ou fonction qui lève une exception : comportement de l'ADR, testé, détecté par le test de fumée.
- Retour de la base : authentification de nouveau correcte en moins de `retry_delay` + 1 s.

## Piste B
**LABO-16** (bascule sur timeout ou sur Reject). Il clôt l'ADR.
