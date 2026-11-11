# 01 — Contrats de la phase 1 (ADR)

**PRD** : `../PRD.md` · **Type** : décisions (aucun code de production) · **Dépend de** : rien

## Objectif
Prendre **toutes** les décisions d'architecture de la phase avant le code (§14.3, P4). Chaque point ci-dessous reçoit une réponse écrite et motivée.

## ADR 0006 — Contrats `radius.*`

1. **Signatures** de `client_lookup`, `authorize`, `post_auth`, `acct_start / acct_interim / acct_stop / acct_on_off`, et des fonctions de maintenance et de CoA : paramètres, types, valeurs renvoyées. `client_lookup` renvoie aussi l'**exigence de Message-Authenticator par routeur** (ADR 0003 : `yes` par défaut, `no` seulement par exception tracée).
2. **Un seul appel SQL par Access-Request** : une même requête renvoie la décision, les attributs de contrôle et les attributs de réponse. Cela supprime le double appel du labo (L5) et garantit un instantané unique.
3. **Clé de recherche** : propriétaire du routeur (déduit de l'IP source) + code. Jamais le code seul (T6). Le site est déduit de l'IP source → routeur → site ; **pas** de `Called-Station-Id`.
4. **Causes de refus** et leur texte exact dans `Reply-Message` : `ticket_inconnu`, `expire`, `epuise`, `mauvais_site`, `trop_d_appareils`, `proprietaire_suspendu`, `trop_de_tentatives`. Plus la cause d'un mauvais mot de passe.
   - `proprietaire_suspendu` = suspension **administrative** seulement. **Jamais** l'état du solde de crédits (ADR 0001 et 0002).
   - `authorize` ne lève **jamais** d'exception à cause d'une donnée : il renvoie un refus codé.
5. **Attributs de réponse** et leur source :
   - `Session-Timeout`, `Mikrotik-Rate-Limit`, `Port-Limit` ;
   - `Acct-Interim-Interval`, avec une valeur fixée ici ;
   - `Idle-Timeout`, avec sa source (constante ou forfait) ;
   - `Mikrotik-Recv-Limit` / `Mikrotik-Xmit-Limit` + Gigawords pour les forfaits à sens séparés ;
   - `WISPr-Session-Terminate-Time`, retenu ou écarté avec sa raison.
6. **Volume total** : contrôle côté serveur, puis Disconnect (pas de dépendance à `Mikrotik-Total-Limit`, qui est [LABO]). C'est un écart assumé avec la formulation de T12 (« limite restante envoyée »). Le dépassement maximal est documenté en fonction de l'intervalle d'Interim.
7. **Horloges** :
   - décision d'accès = `now()` de la base ;
   - événements d'accounting = instant de **réception** écrit par FreeRADIUS dans `detail`, horloge du nœud ;
   - jamais l'heure du rejeu ni l'`Event-Timestamp` du routeur.
   - Proposer la précision à apporter à C4 et à la règle 5.
8. **Idempotence de l'accounting** :
   - clé = routeur + `Acct-Session-Id` + « époque » du routeur, incrémentée à chaque Accounting-On (protection contre la réutilisation d'identifiants après redémarrage, LABO-18) ;
   - compteurs : total = max(total déjà vu, gigawords × 2^32 + octets), en BIGINT ;
   - Interim ou Stop arrivés après une fermeture d'office : mise à jour des compteurs, sans réouverture ;
   - `acct_on_off` ferme seulement les sessions démarrées avant l'instant de réception.
9. **Appareils simultanés** : la fenêtre de course entre Accept et Start est documentée, et on compte aussi les Accept récents (`auth_log`) qui n'ont pas encore de Start. Point d'écriture de `bind_mac` (`post_auth` ou `acct_start`), et politique face aux MAC aléatoires.
10. **`post_auth` sans effet sur la réponse** :
    - un échec d'écriture ne change ni l'Accept ni le Reject ;
    - Accept et Reject sont tous deux journalisés ;
    - `auth_log` ne contient **jamais** le code en clair (`voucher_id`, ou rien pour un code inconnu) ;
    - `auth_goodpass = no` et `auth_badpass = no`.
11. **Anti-devinette** :
    - seuils distincts par MAC et par routeur (par routeur : alerte seule, ou seuil nettement plus haut, pour éviter de bloquer tout un hotspot) ;
    - un refus `trop_de_tentatives` ne compte pas comme échec ;
    - contrôle avant la recherche du ticket.
12. **Lecteur `detail`** :
    - serveur virtuel FreeRADIUS avec une **instance `sql` séparée** (rôle `wk_acct`, pool à lui) ;
    - `locking = yes` ;
    - un enregistrement en erreur de donnée va en **quarantaine**, la file continue ; seule l'indisponibilité de la base renvoie `fail`.
13. **Base indisponible** (voir ticket 08) :
    - `do_not_respond` seulement quand `client_lookup` ou `authorize` échoue pour une **raison de connexion ou de délai** ;
    - délais : `connect_timeout`, délai de requête du pilote, `statement_timeout` du rôle, tous inférieurs au `timeout` de RouterOS (1100 ms par défaut).
14. **Secrets** :
    - secret RADIUS du routeur lisible seulement par les fonctions `SECURITY DEFINER` ; chiffrement au repos (pgcrypto, clé hors base) ou écart motivé avec S3 ;
    - mot de passe des rôles PostgreSQL lu par `$ENV{}` ou par un fichier non versionné ;
    - rôle `wk_coa` pour l'émission de CoA.
15. **Codes de ticket** : générateur cryptographique (pgcrypto `gen_random_bytes`, tirage sans biais), normalisation de la casse face à CHAP, unicité par propriétaire.
16. **`rate_limit` des clients dynamiques** et absence de cache négatif (E-FR-4, L8) : réglage retenu.
17. **Planification** des tâches (sessions fantômes, purges, déclencheur de Disconnect) en phase 1 : timer systemd ou boucle `LISTEN`/`NOTIFY`, hors du processus FreeRADIUS (règle 1). Rôle `wk_maint`.

## ADR 0007 — Instant de référence en test

- Au moins 4 formes comparées :
  - (a) paramètre `p_now`, découpé en une fonction interne sans droit pour `wk_radius` et une enveloppe publique qui passe `now()` ;
  - (b) réglage de session, avec contrôle de `session_user` (et non de `current_user`, faussé par `SECURITY DEFINER`) ;
  - (c) `faketime` ;
  - (d) données datées dans le passé (`activated_at = now() - '5h01m'`).
- Exigences :
  - la forme retenue passe par la configuration FreeRADIUS **de production, inchangée** ;
  - **test négatif** : connecté en `wk_radius`, aucune tentative ne déplace l'horloge ;
  - aucun objet de test dans les migrations de production, avec un test qui le vérifie.

## ADR 0008 — Migrations, schéma et cadre de test

1. Outil de migration SQL. Place des tables `app` en phase 1 : Prisma tout de suite, ou SQL d'abord.
2. Schéma `session` **compatible avec le partitionnement mensuel** à venir (§9). L'idempotence ne doit pas dépendre d'une contrainte `UNIQUE` impossible sur une table partitionnée : table de clés séparée, ou clé qui inclut le mois.
3. Cadre de test :
   - langage et bibliothèques, dont celle des tests de propriétés ;
   - `run.sh` sur une pile neuve (`down -v`), avec des données déterministes ;
   - tests « base arrêtée » en dernier ou sur une pile séparée ;
   - primitive « attendre que le `detail` soit vidé ».
4. **Plusieurs routeurs dans le conteneur** : réseau Docker dans l'overlay (ou overlay paramétrable), et émetteurs avec des IP sources distinctes (conteneurs, IP secondaires ou netns, comme au labo). Faisabilité sous Docker Desktop / WSL2 notée.
5. **Écart test / production** :
   - liste **fermée** des surcharges de test, dans un fichier séparé ;
   - `radiusd -C` lancé sur la configuration de production seule ;
   - un test compare la liste à la réalité.
6. **Recherche de secrets** dans toutes les sorties de test (`radiusd -X`, `docker logs`, journaux PostgreSQL, `/proc/*/cmdline`). Une seule trouvaille fait échouer le test.

## Critères d'acceptation
- Les trois ADR sont acceptés par Yacouba.
- Pour chaque ligne T1–T12, l'ADR 0006 indique la fonction qui la sert.
- Les points 1 à 17 de l'ADR 0006 ont chacun une réponse.
