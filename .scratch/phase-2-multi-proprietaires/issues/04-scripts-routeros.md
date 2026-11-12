# 04 — Scripts RouterOS v7 : enrôlement, désinstallation, login.html

**PRD** : `../PRD.md` · **Dépend de** : 03 · **Normes** : R1–R8

## À livrer
- Générateur (module de l'API) des scripts de l'étape 1 et de l'étape 2 (§6.2), et de `wakatnet-uninstall.rsc`.
- `login.html` minimal : saisie du ticket, mise en majuscules **avant** le hachage CHAP (ADR 0006 §15).
- Audit de chaque script par le skill `mikrotik-routeros-config` (mode audit) ; constats corrigés.

## Critères d'acceptation
- Tests sur le texte généré : chaque objet créé porte un commentaire `wakatnet` ; aucune commande `remove` hors objets marqués ; `use-radius=yes` est la dernière modification, derrière la vérification du tunnel ; idiome `[find ...]` ; aucun secret dans les fichiers versionnés.
- Valeurs injectées (identity, noms de serveurs hotspot) échappées : un nom contenant `"`, `$` ou `\` ne casse pas le script.

## Piste B (Yacouba, à la fin)
Exécution sur CHR 7.15 et stable courante, vierge **et** déjà configuré ; rejeu (idempotence) ; désinstallation ; LABO-05, LABO-08, LABO-14.
