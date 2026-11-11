# 08 — Comportement quand PostgreSQL est arrêté

**PRD** : `../PRD.md` · **Matrice** : préparation de T13 · **Dépend de** : 07

## Objectif
Le labo a montré que, base arrêtée, FreeRADIUS renvoie Access-Reject pour un client en cache (L6). Un Reject empêcherait peut-être RouterOS de basculer vers le nœud B (LABO-16). La variante `do_not_respond` (L6e) fait taire le nœud.

## À livrer
- ADR « base arrêtée » : Reject ou silence. Recommandation : **silence** (`do_not_respond` sur échec du module `sql`). Statut : provisoire tant que LABO-16 n'est pas fait.
- Configuration de production conforme, et test automatisé « base arrêtée », dans les deux cas :
  - client en cache : aucune réponse ;
  - nouvelle IP : aucune réponse.
- L'accounting reste répondu (ticket 04).
- Démarrage de radiusd sans base possible (`pool { start = 0 }`, L6d).

## Critères d'acceptation
- Base arrêtée : aucune Access-Accept ni Access-Reject pour l'authentification ; Accounting-Response toujours envoyée.
- Retour de la base : authentification de nouveau correcte en moins de `retry_delay` + 1 s.

## Piste B
**LABO-16 sur CHR** (RouterOS bascule-t-il sur un timeout ? sur un Reject ?). Il ferme l'ADR.
