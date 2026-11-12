# 07 — Import des tickets Mikhmon

**PRD** : `../PRD.md` · **Dépend de** : 02 · **Spec** : §6.3

## À livrer
- `POST /v1/imports/mikhmon` : CSV d'utilisateurs hotspot (`name,password,profile,...`), correspondance profil → forfait fournie par le propriétaire ; rapport ligne par ligne (importé, doublon, refusé et pourquoi).
- Migration : origine du ticket (`wakatnet` ou `import`) et contrainte de code propre aux tickets importés.

## Critères d'acceptation
- Rejeu du même fichier : aucun doublon.
- Ticket importé authentifié par `radius.authorize` (code saisi en minuscules, PAP).
- Codes refusés : identifiant ≠ mot de passe, caractères hors `[0-9A-Za-z]`, longueur hors 4–32, profil sans correspondance.
- Import cloisonné : jamais dans les forfaits d'un autre propriétaire.
