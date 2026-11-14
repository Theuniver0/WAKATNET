# Racines TLS de l'API, importées par la commande d'enrôlement

`racines-api.pem` : **ISRG Root X1** et **ISRG Root X2**, les racines de Let's Encrypt (ADR 0016). La commande d'enrôlement les importe sur un routeur qui ne les a pas (empreinte absente), sous le nom `wakatnet racine N` ; la désinstallation les retire. Raison : RouterOS n'a de magasin de racines intégré qu'à partir de la 7.19 (banc CHR du 14/11/2026, ADR 0003) ; de 7.15 à 7.18, `check-certificate=yes` échouerait.

Pourquoi X1 et X2, et pas les racines « Generation Y » (YR, YE) : depuis le 13/05/2026, Let's Encrypt signe par défaut sous YR et YE, **contre-signées par X1 et X2** (sources secondaires, à revérifier sur letsencrypt.org). YR et YE ne sont pas encore dans le magasin Mozilla du paquet `ca-certificates` 20260816 d'Ubuntu 24.04 ; les clients les valident donc par la contre-signature, comme le fera le routeur.

Provenance : copiées du paquet signé `ca-certificates` 20260816ubuntu0.24.04.1 (`/usr/share/ca-certificates/mozilla/ISRG_Root_X1.crt`, `ISRG_Root_X2.crt`), le 14/11/2026. letsencrypt.org n'était pas joignable depuis le conteneur de développement.

| Racine | Empreinte SHA-256 | Fin de validité |
|---|---|---|
| ISRG Root X1 (RSA 4096) | `96bcec06264976f37460779acf28c5a7cfe8a3c0aae11a8ffcee05c0bddf08c6` | 04/06/2035 |
| ISRG Root X2 (ECDSA P-384) | `69729b8e15a86efc177a57afb7171dfc64add28c2fca8cf1507e34453ccb1470` | 17/09/2040 |

**À faire une fois, avant le premier enrôlement réel** : comparer ces empreintes à celles publiées sur https://letsencrypt.org/certificates/, et faire enrôler un vrai routeur en 7.15 à 7.18 contre l'API de production (chaîne réelle servie par nginx, contre-signature comprise : non prouvée par le banc, qui emploie sa propre autorité).

Contrôles au démarrage de l'API (`lireRacinesTls`) : 1 à 3 certificats, autorités auto-signées, en cours de validité, rien d'autre dans le fichier.
