# 03 — Refus codés, site et propriétaire

**PRD** : `../PRD.md` · **Matrice** : T1, T4, T6 · **Dépend de** : 02

## À livrer
- `authorize` renvoie les refus `ticket_inconnu`, `expire` (validité écoulée, ou expiration absolue dépassée), `mauvais_site` et `proprietaire_suspendu`, avec les textes de l'ADR 0006. (`epuise` est traité au ticket 05.)
- Dimension `scope` (un site, ou tous les routeurs du propriétaire), copiée et figée sur le ticket.
- Données de test : deux sites pour le propriétaire A, et un propriétaire B.

## Critères d'acceptation
- **T1** : code inconnu → Reject et `ticket_inconnu`.
- **T4** : un forfait « validité 5 h » activé il y a 5 h 01 (instant fixé par une donnée de test, ADR 0007) → `expire`. Une expiration absolue dépassée donne `expire`, même pour un ticket jamais activé.
- **T6** : un ticket de A présenté sur un routeur de B → Reject. La tentative est journalisée (ticket 07).
- **`scope`** : un ticket limité au site S, présenté sur un routeur du site S′ → `mauvais_site` ; un ticket valable sur tout le propriétaire est accepté sur les deux sites.
- Propriétaire suspendu administrativement → `proprietaire_suspendu`. Propriétaire **au plafond de découvert** → ticket **accepté**.
- Donnée inattendue (par exemple un forfait incohérent) → refus codé, jamais d'exception.

## Piste B
Remontée de la cause au portail par `$(error)` (LABO, phase 3).
