# ADR 0023 — Étape 3 de l'enrôlement : l'entretien des routeurs (SPEC §6.2)

- **Statut** : décidé le 13/11/2026, sur demande de Yacouba (« corrige les manquants », revue Spec du dépôt).
- **Références** : SPEC §6.2 (étapes 2 et 3, exigences 1 à 7) et §7.1 ; ADR 0004 §3 (nœud B migré sans réenrôlement) ; ADR 0012 (étapes 1 et 2) ; LABO-14.

## Contexte

- Le §6.2 demande une étape 3 : « Les changements ultérieurs (walled garden, `login.html`, ajout d'un nœud) passent par un script planifié qui tire une configuration versionnée. Il ne touche qu'aux objets marqués `wakatnet`, et le propriétaire peut le désactiver. »
- Elle n'existait que dans `docs/IDEES.md`. Pourtant l'ADR 0004 §3 compte sur elle : sans elle, migrer B chez un second hébergeur (condition de G-PILOTE) obligerait à réenrôler chaque routeur.
- La même revue a relevé l'absence du **walled garden** à l'étape 2. Il est corrigé dans le même lot : l'entretien regénère ce que l'étape 2 pose.

## Options

| | A. Script planifié qui tire, par HTTPS public, avec un jeton propre au routeur | B. Même script, mais tiré par le tunnel WireGuard | C. Poussée par le serveur (API RouterOS ou SSH) |
|---|---|---|---|
| Authentification | jeton aléatoire de 32 octets, dont seule l'empreinte est gardée en base | adresse overlay, authentifiée par WireGuard | identifiants d'administration du routeur, gardés par la plateforme |
| Exposition | même chemin que l'enrôlement (nginx, TLS) | écoute de nginx ou de l'API sur l'overlay, à créer | accès d'administration du routeur ouvert à la plateforme |
| Exigence 3 (anti-lockout) | respectée | respectée | **contraire** : la plateforme tient l'administration |
| Panne du tunnel | l'entretien répare le tunnel (nouvelle IP de B) | **impossible** : c'est le tunnel qui serait à réparer | — |

**Décision : A.** B ne peut pas corriger le cas qui la motive (une nouvelle adresse de B coupe le tunnel). C viole l'exigence 3.

## Décisions

1. **Jeton.**
   - 32 octets aléatoires, créé juste après l'enrôlement (`app.entretien_jeton_poser`, posé une seule fois) et transmis dans l'étape 2. La base ne garde que son empreinte SHA-256 (migration 0042).
   - Le jeton figure en clair dans le planificateur. Un compte en lecture seule le voit, et il apparaît dans un `/export`. C'est pourquoi **il ne donne pas le secret RADIUS** : l'entretien relit le secret sur le routeur.
   - **Rotation** par le propriétaire : `POST /v1/routers/:id/entretien` rend une nouvelle ligne de planificateur à coller, et l'ancien jeton cesse aussitôt de valoir. Elle sert après une fuite, et pour les routeurs enrôlés avant cette migration.
2. **Planificateur.**
   - `wakatnet-entretien`, toutes les 6 h, commentaire `wakatnet entretien (desactivable)`, droits `read,write,test,sensitive`. Il n'a ni le droit `policy` (rien dans l'entretien ne touche aux utilisateurs) ni le droit `ftp`.
   - **Sans fichier** : le script est téléchargé en mémoire (`fetch … output=user as-value`) puis exécuté par `:parse`. Un fichier intermédiaire exigeait le droit `ftp` (banc CHR 7.19.4 du 14/11/2026 : « cannot open file: permission denied »). Ce droit aurait permis à un script importé de lire les sauvegardes du routeur et de réécrire les pages du portail. Un compte local `ftp` aurait aussi pu remplacer le fichier entre le téléchargement et l'import (relecture du 14/11/2026). `:parse` analyse tout le script avant de l'exécuter : un script tronqué n'applique rien. La taille est bornée à 32 Kio côté API (`TAILLE_MAX_ENTRETIEN`).
   - Une nouvelle étape 2, ou une rotation, réécrit droits, intervalle et événement ; **seul `disabled` est préservé**.
   - Il télécharge `https://api.DOMAINE/entretien/<jeton>` **avec `check-certificate=yes`** (exigence 6) et l'exécute en mémoire.
   - Un échec (réseau, 404) ne change rien sur le routeur : un avertissement est journalisé.
   - **Désactivable** : `/system scheduler disable wakatnet-entretien`. Un nouvel enrôlement ne le réactive pas, car la mise à jour ne touche pas `disabled`.
3. **Contenu.**
   - L'entretien regénère les **seuls objets « wakatnet »** : pairs WireGuard, avec mise à jour de l'adresse et du port d'un nœud déplacé ; adresse ; routes ; `/radius` ; règles de pare-feu, remises à jour par leur commentaire ; walled garden.
   - **Jamais** : l'activation (`use-radius`), le profil hotspot, le planificateur, ni `/radius incoming` : un CoA que le propriétaire a désactivé le reste.
   - **Un seul retrait** : celui des entrées « wakatnet portail <ip> » qui ne figurent plus dans `WAKATNET_PORTAIL_IPS`. Une ancienne IP du portail ne reste ainsi pas ouverte avant connexion. Il n'a jamais lieu avec une liste vide.
   - Un nœud retiré de la plateforme laisse donc ses objets en place, inertes ; on les retire à la main ou par désinstallation et réenrôlement. C'est le prix de l'exigence 2 (additif) : un entretien qui supprime peut couper un routeur en production.
4. **Version.** La « configuration versionnée » est celle du dépôt et de `WAKATNET_NOEUDS` et `WAKATNET_PORTAIL_IPS` au moment du tirage. Le script est idempotent : le rejouer sans changement ne modifie rien.
5. **Révocation.** Un routeur révoqué (`actif = false`) ou un jeton inconnu reçoivent la **même** réponse 404.
6. **Walled garden** (étape 2 et entretien).
   - Le HTTPS est ouvert **par l'IP dédiée du portail** (`WAKATNET_PORTAIL_IPS`, SPEC §7.1 : « IP fixe dédiée »). Il ne dépend donc pas de LABO-14 : le nom d'hôte n'est pas lisible dans TLS.
   - S'y ajoute une entrée HTTP par nom d'hôte, pour la redirection vers HTTPS.
   - L'API refuse de démarrer en production sans `WAKATNET_PORTAIL_IPS`.
7. **Journaux.** Le jeton n'apparaît jamais : le chemin est masqué par l'API (`cheminMasque`) et par nginx (`/entretien/<jeton>`).

## Non fait, et pourquoi

- **`login.html` par l'entretien.** Le §6.2 le cite. Mais le fichier est posé à la main (ADR 0012) dans le dossier HTML du profil, que le propriétaire peut avoir personnalisé. Le remplacer d'office toucherait un objet qui n'est pas marqué « wakatnet » (exigence 2). C'est à décider par Yacouba.
- **Routeurs enrôlés avant cette migration.** Ils n'ont pas de jeton ; un réenrôlement le leur donne. Aucun routeur de tiers n'est enrôlé aujourd'hui (G-PILOTE fermée).

## Relecture de sécurité (13/11/2026, second agent)

- **Grave, corrigé** : le planificateur téléchargeait **sans vérifier le certificat**, puis importait le fichier avec le droit `policy`. Quiconque sur le chemin réseau du routeur aurait pu en prendre le contrôle. Le certificat est maintenant vérifié, le droit `policy` est retiré, et un test couvre les deux.
- **Corrigés** :
  - le secret RADIUS n'est plus servi ;
  - rotation du jeton ;
  - nom d'hôte du portail vérifié au démarrage, sinon l'étape 2 échouait après la consommation du jeton d'enrôlement ;
  - CoA hors de l'entretien, anciennes IP du portail retirées ;
  - file des alertes de crédits : les plus récentes d'abord, règle réévaluée à l'envoi ;
  - tests renforcés : nœud ajouté, échappement du `on-event`.
- **Plausible, non traité** : les IP du portail ouvrent le port 443 de tout le frontal. Avant connexion, un client peut donc joindre l'API par SNI, ce qui n'ouvre pas Internet. Pour un vhost unique, il faudrait une IP réservée au seul portail dans nginx (ADR 0016).

## [LABO] sur CHR

| Point | Effet si faux |
|---|---|
| `policy=read,write,test,sensitive` suffit. Avec un fichier intermédiaire, c'était **faux** (il fallait `ftp`, banc CHR 7.19.4). Sans fichier (`output=user` puis `:parse`) : **vérifié** par `infra/routeros/essais/chr.sh` en 7.15.3 et 7.19.4 (vrai planificateur, IP du portail remplacée, aucun échec journalisé) | l'entretien échoue, journalise et ne change rien |
| `:foreach … walled-garden ip find …` et le retrait par `$i` | une ancienne IP du portail reste ouverte |
| `/ip hotspot walled-garden ip add … dst-address=… protocol=tcp dst-port=443` laisse un client non connecté joindre le portail en HTTPS | le portail est injoignable avant connexion |
| `/interface wireguard peers set … endpoint-address=…` sur un pair existant rétablit le tunnel vers B déplacé | B reste injoignable jusqu'au réenrôlement |

## Preuves

Tests sur le texte des scripts (`routeros.test.ts`) et par l'API (`enrolement.test.ts`) :
- planificateur posé avant l'activation, et jamais réactivé ;
- URL d'entretien piégée refusée ;
- pair déplacé et règle de pare-feu remis à jour ;
- ni activation, ni planificateur, ni retrait dans l'entretien ;
- empreinte seule en base, jeton posé une seule fois ;
- 404 pour un routeur révoqué ou un jeton inconnu.

Comme le reste des scripts RouterOS, rien n'a été exécuté sur un CHR (écart R8).
