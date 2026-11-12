# 07 — Achat de bout en bout dans un navigateur sans interface

**Dépend de** : 05, 06

## Critères d'acceptation
- Chromium sans interface (Playwright) : faux hotspot → portail → forfait → paiement simulé confirmé par webhook → redirection GET vers `link-login-only` avec le code → le faux hotspot reçoit un code que `radius.authorize` accepte.
- Le même parcours, la page fermée puis rouverte (P6).

## Piste B
CHR et téléphone réels : mini-navigateurs iOS et Android, LABO-12 et LABO-14.
