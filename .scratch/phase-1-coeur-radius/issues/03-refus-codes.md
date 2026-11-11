# 03 — Refus codés : ticket inconnu, expiré, épuisé, propriétaire suspendu

**PRD** : `../PRD.md` · **Matrice** : T1, T4 · **Dépend de** : 02

## À livrer
- `radius.authorize` renvoie un refus avec la cause dans `Reply-Message` : `ticket_inconnu`, `expire` (validité écoulée, ou expiration absolue dépassée), `epuise`, `proprietaire_suspendu`. Textes exacts : ceux de l'ADR 0006.
- Tests T1, T4, plus des cas propres à chaque cause.

## Critères d'acceptation
- T1 : un code inconnu donne Reject et `Reply-Message = "ticket_inconnu"`.
- T4 : un forfait « validité 5 h », activé depuis 5 h 01 selon l'instant de test, donne Reject et `expire`.
- Expiration absolue dépassée : `expire`, même pour un ticket jamais activé.
- Propriétaire suspendu : Reject et `proprietaire_suspendu`.

## Piste B
LABO : la cause doit remonter au portail par `$(error)`. À vérifier sur CHR au ticket portail (phase 3).
