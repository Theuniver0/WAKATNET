# 05 — Temps, validité et volume restants ; épuisement

**PRD** : `../PRD.md` · **Matrice** : T3, T12 · **Dépend de** : 04

## À livrer
- `Session-Timeout` = min(temps restant, fin de validité − maintenant, expiration absolue − maintenant) (§5.3).
- Refus `epuise` : temps consommé ≥ `uptime_limit`, ou volume ≥ `data_limit`. Une valeur calculée ≤ 0 donne **toujours** un Reject `epuise`, jamais un Accept avec `Session-Timeout = 0`.
- Volume selon l'ADR 0006 (point 6) : contrôle côté serveur. `acct_interim` détecte l'épuisement et inscrit la session « à couper » ; la coupure est émise au ticket 09. `Recv` / `Xmit-Limit` + Gigawords seulement pour un forfait à sens séparés.
- Copie figée : modifier le forfait ne change pas les tickets déjà vendus.

## Critères d'acceptation
- **T3** : forfait d'1 h dont 20 min ont été consommées → `Session-Timeout = 2400`.
- **T12** (écart assumé, ADR 0006) : forfait d'1 Go dont 900 Mo ont été consommés → Accept, et la session est inscrite « à couper » dès que le reste est consommé. Le dépassement maximal est documenté.
- Temps épuisé → `epuise`. Volume épuisé → `epuise`.
- Forfait à sens séparés de plus de 4 Go → Gigawords correctement envoyés.
- Forfait modifié après la vente → `Session-Timeout` inchangé pour le ticket déjà vendu.

## Piste B
Coupure réelle au `Session-Timeout` sur CHR. Observation de `Mikrotik-Total-Limit` et de `Recv` / `Xmit-Limit`. **LABO-19** (`Acct-Interim-Interval`).
