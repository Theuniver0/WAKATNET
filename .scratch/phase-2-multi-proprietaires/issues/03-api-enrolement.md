# 03 — API d'enrôlement

**PRD** : `../PRD.md` · **Dépend de** : 02

## À livrer
- `POST /v1/sites/{site}/enrollments` (propriétaire) : crée un jeton (30 min, usage unique), rend la commande à coller ; le jeton n'est stocké que sous forme d'empreinte.
- `GET /enroll/{jeton}` (routeur) : script de l'étape 1, ne consomme pas le jeton.
- `POST /enroll/{jeton}` (routeur) : clé publique WireGuard et inventaire ; consomme le jeton, alloue l'adresse, crée le secret RADIUS, rend le script de l'étape 2. Une seule transaction (`app.enroll_register`).
- Journal d'audit de chaque enrôlement, sans jeton ni secret.

## Critères d'acceptation
- Jeton expiré, déjà consommé, inconnu : 404 identique, sans indice.
- Deux POST concurrents sur le même jeton : un seul routeur créé.
- Clé publique invalide, version < 7.15 : 422, jeton **non** consommé.
- Le routeur créé est reconnu par `radius.client_lookup` avec son secret.
- Adresse allouée hors des plages réservées, jamais deux fois.
