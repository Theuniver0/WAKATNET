# Audit des scripts RouterOS d'enrôlement (phase 2, ticket 04)

- **Date** : 12/11/2026. **Méthode** : skill `mikrotik-routeros-config` en mode audit. L'audit a porté sur les scripts produits par `apps/api/src/routeros.ts` pour un routeur d'exemple (`node` sur le générateur, nœuds A et B fictifs) : `wakatnet-enroll.rsc` (étape 1), `wakatnet-etape2.rsc` (étape 2) et `wakatnet-uninstall.rsc`.
- **Limite (12/11)** : audit par lecture seulement. **Levée en partie le 14/11/2026** : les scripts ont été exécutés sur CHR 7.15.3 et 7.19.4 (section « Exécution sur CHR » ci-dessous).
- **Garde permanente** : `apps/api/tests/routeros.test.ts` vérifie sur le texte généré R1 à R7, l'échappement des valeurs venues du routeur, l'ASCII seul et l'ordre « refus avant création » et « preuve du tunnel avant activation ».

## Résumé

**Acceptable sous réserve du labo.** Les exigences de la spec sont tenues par construction :
- R1 : chaque création est gardée par un `find` ;
- R2 et R3 : aucune suppression hors objets marqués, et un commentaire `wakatnet…` sur tout objet créé ;
- R4 : aucun accès d'administration touché, et seulement des `accept` limités au tunnel et aux IP des nœuds ;
- R5 : `use-radius=yes` vient en dernier, derrière un ping de chaque nœud à travers le tunnel ;
- R6 : la désinstallation rétablit les valeurs d'origine relevées ;
- R7 : chemins complets.

Un défaut probable a été corrigé pendant l'audit. Deux points critiques restent suspendus au labo.

## Problèmes critiques

1. **Vérification TLS de `/tool fetch` (LABO-08), probable.** `check-certificate=yes` exige que le routeur fasse confiance à l'autorité du certificat de l'API. D'après les journaux des modifications, le magasin de confiance intégré de RouterOS est récent (versions 7.1x). Sur une 7.15 sans racine importée, la **première** commande échouerait.
   - **À trancher sur CHR 7.15** avant de choisir entre trois voies :
     - (a) faire importer la racine par le propriétaire avant la commande ;
     - (b) exiger la version qui a le magasin intégré ;
     - (c) repli de la spec : afficher l'empreinte SHA-256 du script dans le tableau de bord, avec `check-certificate=no`. Cette voie n'est **pas** retenue sans décision de Yacouba.
2. **Propagation d'un `:error` de l'étape 2 à travers `/import`, à vérifier.** L'étape 1 l'attrape par `:do { /import … } on-error={…}`. Si l'erreur ne remonte pas, le message de l'étape 2 s'affiche quand même. Le hotspot reste inchangé dans les deux cas, puisque l'activation est derrière la preuve du tunnel. Seul le message de l'étape 1 serait perdu.

## Corrigé pendant l'audit

- **`place-before` vers une règle dynamique, probable.** Un hotspot pose des règles **dynamiques** en tête de la chaîne `input` (sauts vers `pre-hs-input`). RouterOS refuse en général de placer une règle avant une règle dynamique : la règle de pare-feu échouait au milieu de l'étape 2.
  - **Correction** : la cible est `[find where chain=input dynamic=no]`. Les règles `wakatnet` se placent donc après les sauts dynamiques du hotspot, qui ne concernent que le trafic des clients du hotspot (`hotspot=from-client`), jamais le tunnel.
  - Test ajouté.

## Exécution sur CHR (14/11/2026)

Banc `infra/routeros/essais/chr.sh` : un CHR neuf sous qemu (émulation, sans KVM), l'hôte jouant la plateforme
(`plateforme.py`, HTTPS par une autorité de test, scripts du **vrai** générateur via `generer.ts`) et le nœud A
(`wireguard-go`). Résultat : **38 contrôles sur 38 en 7.15.3 et en 7.19.4** :
- refus de l'étape 1 sans rien modifier ni rien envoyer : pas de hotspot, adresse dans 10.213.0.0/16, autre RADIUS du hotspot ;
- enrôlement complet à travers un vrai tunnel WireGuard (preuve par ping), profil passé en RADIUS avec accounting,
  `require-message-auth=yes-for-request-resp` accepté, CoA ouvert, règles `wakatnet` placées devant un pare-feu
  existant (établies, SSH, refus du reste), fichiers temporaires retirés, utilisateur local conservé ;
- étape 2 rejouée : aucun doublon, un planificateur désactivé le reste ;
- étape 3 lancée par le **vrai** planificateur : IP du portail remplacée, aucun échec journalisé ;
- désinstallation : profil et CoA rétablis, plus aucun objet `wakatnet`, objets du propriétaire intacts.

Constats :
1. **Défaut corrigé** : lancé par le planificateur, `fetch … dst-path=` échoue sans le droit `ftp` (« cannot open
   file: permission denied ») : l'entretien n'aurait jamais tourné sur aucun routeur. Plutôt que d'ajouter `ftp`
   (lecture des sauvegardes, pages du portail, échange du fichier avant l'import : relecture par un second agent),
   l'entretien s'exécute **en mémoire** (`output=user as-value` puis `:parse`), avec les seuls droits
   `read,write,test,sensitive` (ADR 0023).
2. **À trancher** : RouterOS n'a de magasin de certificats racines intégré (`/certificate settings`
   `builtin-trust-anchors`) qu'à partir de la **7.19** (absent de 7.15.3, 7.16.2, 7.17.2, 7.18.2 ; présent en 7.19.4).
   De 7.15 à 7.18, la commande d'enrôlement (`fetch … check-certificate=yes` vers l'API, certificat public) échoue tant
   qu'aucune racine n'est importée. Le banc importe sa propre autorité de test : il ne prouve donc pas la chaîne
   publique (le CHR du banc n'a pas de DNS). Même question pour RouterOS 6.
3. Banc seulement : en 7.15, `/import` lancé par SSH n'affiche pas le message d'un `:error` (il est dans le journal), et
   un fichier déposé par SCP n'apparaît pas aussitôt dans `/file`.

Non couvert par ce banc : les paquets RADIUS eux-mêmes (Message-Authenticator réellement envoyé : LABO-00 ; CoA ;
accounting), les clients du hotspot, RouterOS 6, un vrai chemin Internet.

## À vérifier sur CHR (aucune erreur certaine relevée)

Les lignes ci-dessous sont **exécutées sans erreur** par le banc du 14/11/2026 en 7.15.3 et 7.19.4, sauf la détection
d'une plage plus large que 10.213.0.0/16, non essayée.

| Point | Certitude | Remarque |
|---|---|---|
| Portée des `:local` sous `/import` | Probable : bon | Chaque script est un seul bloc `{ … }`. Hors bloc, une `:local` ne survivrait pas à sa ligne. |
| Fonction locale `:local fin do={…}` appelée par `$fin` dans des blocs imbriqués | Probable : bon | Les variables locales du bloc englobant sont visibles dans les `do={}` imbriqués. |
| `address in 10.213.0.0/16`, `dst-address in …` dans un `where` | Probable : bon | Ne détecte **pas** une adresse plus large qui **couvre** la plage, par exemple un LAN en 10.0.0.0/8. Sans gravité pour le routage : les routes /32 vers les nœuds sont plus spécifiques. Gênant seulement si un client du hotspot recevait 10.213.0.1 ou 10.213.0.2. À rendre plus strict si le labo montre un parc en 10.0.0.0/8. |
| `service~"hotspot"` sur le champ `service` (type ensemble) de `/radius` | À vérifier | Repli : `find where service=hotspot`. |
| `:set ($hs->[:len $hs]) {…}` (ajout en fin de tableau) | Probable : bon | Idiome courant en v7. |
| `:serialize to=json` (RouterOS ≥ 7.13), booléens rendus `true`/`false` | Probable : bon | L'API accepte aussi `yes`/`no` et les nombres en chaîne. |
| `/tool fetch … http-method=post http-header-field=… http-data=$corps output=file` | Probable : bon | Réponse 4xx : `fetch` échoue, et `on-error` affiche un message générique. |
| `require-message-auth=yes-for-request-resp` sur `/radius` | Probable : bon en ≥ 7.15 | LABO-00. |
| `radius-interim-update=received` | Certain : valeur admise | L'intervalle vient alors de l'Accept (ADR 0006 §5, LABO-19). |
| `[/ping X src-address=Y count=1]` rend le nombre de réponses | Probable : bon | Le ping à travers le tunnel implique un handshake fait. `last-handshake` n'est donc pas lu. |
| `/import … verbose=no` | Probable : bon | |
| Règles insérées une à une en tête | Certain | L'ordre des règles `wakatnet` entre elles est inversé. C'est sans effet, car ce sont toutes des `accept` disjoints. L'ordre des règles existantes est intact. |

## Améliorations notées, non faites

- `timeout=3s` sur `/radius` : la valeur attend LABO-09 (latence et perte injectées).
- Preuve du tunnel : l'étape 2 exige que **tous** les nœuds configurés répondent. Si le nœud B est en maintenance, un nouvel enrôlement échoue proprement, sans activation. C'est voulu par le §6.2 (« ping des deux nœuds »), à revoir en phase 5 si c'est gênant.
- Fichiers : sur un routeur à stockage `flash/`, `dst-path` sans préfixe écrit en mémoire vive. C'est sans effet ici, car les fichiers sont temporaires.

## Points positifs

- La clé privée WireGuard est générée sur le routeur et n'est jamais lue par le script.
- Aucune valeur venue du routeur (nom de profil, identity) n'est recopiée sans échappement de `\`, `"`, `$` et `?`. Un caractère de contrôle fait refuser la génération.
- Le secret n'apparaît que dans l'étape 2, qui s'efface d'elle-même après l'activation. Il ne reste sur le routeur qu'en cas d'échec du tunnel, pour permettre la relance.
- La désinstallation rétablit `use-radius`, `radius-accounting`, `radius-interim-update` et `/radius incoming accept` à leurs valeurs **relevées** à l'enrôlement, et non à des valeurs supposées.

## Complément (phase 3, 12/11/2026)

L'étape 1 relève en plus `hotspot-address` et `dns-name` de chaque profil hotspot. Ce sont les seules cibles admises de l'auto-connexion du portail (ADR 0013 §12, I1). **[LABO]** : noms exacts de ces propriétés, et forme de `hotspot-address` quand elle n'est pas posée.
