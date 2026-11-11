# 07 — Anti-devinette et journal des tentatives

**PRD** : `../PRD.md` · **Matrice** : T11 · **Dépend de** : 06

## À livrer
- `radius.post_auth` journalise chaque tentative dans `auth_log` : routeur, MAC, résultat, cause, instant.
- `radius.authorize` limite les échecs par MAC et par routeur. Seuils paramétrables ; défaut : 10 échecs en 1 minute. Refus `trop_de_tentatives`, et le signal d'alerte est inscrit dans une table que le worker lira plus tard.
- La lecture seule de `authorize` est préservée : le comptage passe par `post_auth`, qui écrit, et `authorize` ne fait que lire `auth_log`.
- Génération des codes de ticket : 32 symboles sans ambiguïté, 8 caractères au moins (§5.5). Test de distribution.

## Critères d'acceptation
- T11 : 10 échecs en 1 minute depuis la même MAC donnent `trop_de_tentatives` sur la tentative suivante, même avec un code valide, et un signal d'alerte.
- Après la fenêtre de limitation, un code valide est de nouveau accepté.
- Durée de conservation de `auth_log` : 90 jours, avec une purge testée (ADR 0005).
