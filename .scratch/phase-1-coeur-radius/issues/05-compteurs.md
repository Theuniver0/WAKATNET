# 05 — Temps, validité et volume restants recalculés à chaque login

**PRD** : `../PRD.md` · **Matrice** : T3, T12 · **Dépend de** : 04

## À livrer
- `radius.authorize` calcule `Session-Timeout` = min(temps restant, fin de validité − maintenant, expiration absolue − maintenant), comme au §5.3.
- Volume : reste à consommer. **On ne dépend pas de `Mikrotik-Total-Limit`** (non documenté dans la section Access-Accept de la 7.25, [LABO]).
  - Envoi de `Mikrotik-Recv-Limit` / `Mikrotik-Xmit-Limit` seulement si le forfait sépare les deux sens.
  - Sinon, contrôle côté serveur : `acct_interim` détecte l'épuisement et marque la session à couper. L'émission du Disconnect est faite au ticket 09.
- Copie figée du forfait sur le ticket : modifier le forfait ne change pas les tickets déjà vendus.

## Critères d'acceptation
- T3 : un forfait d'1 h dont 20 min ont été consommées renvoie `Session-Timeout = 2400`.
- T12 : un forfait d'1 Go dont 900 Mo ont été consommés renvoie un reste de 100 Mo, avec l'attribut retenu par l'ADR, ou la session marquée « à couper » à l'épuisement.
- Modifier le forfait après la vente ne change pas le `Session-Timeout` d'un ticket déjà vendu.

## Piste B
`Mikrotik-Total-Limit` et `Mikrotik-Recv-Limit` / `Mikrotik-Xmit-Limit` à observer sur CHR.
