# ADR 0018 — Sauvegardes verrouillées : Backblaze B2, Object Lock en mode conformité (revue de sécurité M8)

- **Statut** : décidé le 12/11/2026, par délégation de Yacouba (« tranche M8 »). À confirmer à l'ouverture du compte : prix, région et nom de point de terminaison (voir « Vérifié ou non »).
- **Références** : `docs/REVUE_SECURITE.md` (M8) ; ADR 0004 (hébergement), ADR 0015 §5 (sauvegardes) ; `infra/noeud/essais/sauvegarde-s3.sh`.

## Contexte

- Les clés S3 de pgBackRest sont sur les deux nœuds, car la sauvegarde suit le primaire. Un nœud compromis peut donc **effacer toutes les sauvegardes**, puis la base : c'est le scénario d'un rançongiciel.
- Le dépôt doit être chez un **troisième fournisseur**, distinct de l'hébergeur des nœuds (ADR 0015 §5). Pendant le pilote, A et B sont chez Hetzner (ADR 0004). B partira ensuite chez un hébergeur encore à choisir.
- **pgBackRest** efface lui-même ses anciennes sauvegardes (`expire`). Un verrou ne peut donc pas interdire l'effacement en tant que tel. Il doit garantir qu'un effacement ne fait que **masquer** l'objet, et que la version reste lisible.

## Décision

1. **Fournisseur : Backblaze B2**, région européenne (EU Central). Les raisons :
   - c'est un fournisseur de stockage seulement : il ne sera jamais l'hébergeur de A ni de B ;
   - il documente l'**Object Lock en mode conformité** : pendant la durée du verrou, personne ne peut supprimer une version verrouillée ni raccourcir le verrou, pas même le titulaire du compte ;
   - il est compatible S3, et facturé à l'usage (environ 7 $ par To et par mois, à vérifier). Pour une base de quelques Go, le coût est négligeable.
2. **Écartés** :
   - Hetzner Object Storage : même fournisseur que A et B ;
   - Cloudflare R2 : pas d'Object Lock ;
   - Wasabi : facture 90 jours minimum par objet, ce qui ne convient pas aux WAL ;
   - OVHcloud et Scaleway : mode conformité non vérifié, et candidats possibles pour l'hébergement du B définitif.
3. **Bucket** :
   - privé, région EU Central ;
   - **Object Lock activé à la création**, ce qui active aussi le versionnement ;
   - **rétention par défaut : mode conformité, 30 jours** ;
   - règle de cycle de vie qui efface les versions masquées 31 jours après leur masquage, pour borner le coût. Un objet verrouillé ne peut de toute façon pas partir avant la fin de son verrou.
4. **Pourquoi 30 jours** :
   - sauvegarde complète chaque dimanche, différentielle chaque nuit, `repo1-retention-full=4` ;
   - un dépôt effacé fait échouer la sauvegarde de la nuit suivante, et l'alerte `sauvegarde` se lève dans les 26 h. Cette alerte vient des nœuds : face à un nœud compromis, c'est le contrôle externe qui compte (« Audit du 13/11/2026 ») ;
   - avec 30 jours, au moins trois sauvegardes complètes, et leurs WAL, restent verrouillées le jour où l'on agit.
5. **Clé d'application des nœuds** :
   - limitée à ce bucket ;
   - capacités `listBuckets,listFiles,readFiles,writeFiles`, et rien d'autre. `deleteFiles` ne s'ajoute que si l'exercice B2 montre que pgBackRest en a besoin pour masquer un objet (`expire`, `stanza-delete`) : **à vérifier** ;
   - **sans** droit sur le bucket (réglages, cycle de vie, verrou), sur les rétentions ou les blocages légaux des fichiers, ni contournement du mode gouvernance ;
   - commande exacte de création et contrôle par `b2 key list --long` : `docs/MISE_EN_PRODUCTION.md` §1.

   Même si cette clé fuit, les versions verrouillées restent intactes pendant 30 jours. Passé ce délai, elle suffit à tout effacer : d'où le contrôle externe (« Audit du 13/11/2026 »).
6. **Compte Backblaze** :
   - distinct du compte Hetzner, avec double authentification et un moyen de paiement de secours ;
   - la clé maîtresse ne va jamais sur un nœud.
7. **Version de pgBackRest ≥ 2.59.2**, contrôlée par Ansible.
   - `--repo-target-time` (2.54 et suivantes) relit le dépôt tel qu'il était à une date donnée.
   - La 2.59.2 corrige cette relecture sur S3 au-delà de 1 000 versions (pgBackRest #2854) : nos WAL dépassent vite ce seuil.
8. **Restauration après un effacement** : `docs/RUNBOOK.md` §7, « Restaurer après l'effacement du dépôt ».

## Preuve

Le banc `infra/noeud/essais/sauvegarde-s3.sh` tourne sur un serveur S3 de test (moto, derrière nginx pour TLS). Le bucket y est versionné et verrouillé en conformité, avec la configuration pgBackRest de production. Déroulé :
1. sauvegarde complète chiffrée, puis une ligne témoin, archivée ;
2. avec la configuration de pgBackRest du nœud, l'attaquant fait `pgbackrest stanza-delete`, puis efface tous les objets : pgBackRest ne voit plus rien. moto **ne contrôle pas les droits** des clés : le banc prouve le verrou, pas les capacités de la clé B2, qui restent à prouver sur B2 (exercice de mise en service) ;
3. il tente d'effacer définitivement les versions : 986 tentatives, **toutes refusées** ;
4. `pgbackrest --repo-target-time` retrouve la sauvegarde, la restauration rejoue les WAL, et **la ligne témoin est là**.

## Vérifié ou non

- **Vérifié sur sources** : le mode conformité de B2 et son irréversibilité ; `--repo-target-time` et la correction de la 2.59.2.
- **Prouvé au banc** : le comportement de pgBackRest 2.58 face à un bucket versionné et verrouillé, sur un S3 de test, avec moins de 1 000 versions. Pas les capacités de la clé : moto accepte toute clé.
- **Non vérifié** :
  - B2 lui-même : en-têtes exigés à l'écriture dans un bucket verrouillé ; Backblaze déconseille une rétention par défaut avec certains logiciels de sauvegarde ;
  - les capacités minimales de la clé des nœuds (`deleteFiles` nécessaire ou non) et l'impossibilité, avec cette clé, de changer la rétention, de contourner le verrou ou de toucher aux réglages du bucket ;
  - le contrôle externe `infra/surveillance/controle-b2.sh` contre B2 réel (éprouvé seulement avec un `aws` simulé) : rendu des marques d'effacement par `ListObjectVersions`, et absence de marque sur `backup.info` en fonctionnement normal ;
  - le prix exact et le nom de la région.

  D'où l'**exercice de mise en service** (`docs/MISE_EN_PRODUCTION.md`) : sauvegarde, effacement, restauration avec `--repo-target-time`, sur B2, avant G-PILOTE.

## Audit du 13/11/2026 : la promesse reposait sur le nœud compromis

**Limite reconnue.** La décision protège les versions verrouillées pendant 30 jours, mais l'alerte qui doit faire agir dans ce délai est émise **par les nœuds**. Or un nœud compromis peut :
- rediriger pgBackRest sans rien casser : un fichier déposé dans `/etc/pgbackrest/conf.d`, une autre `--config`, ou un `archive_command` changé par `ALTER SYSTEM` (postgres est superutilisateur) ; les sauvegardes partent ailleurs et « réussissent » ;
- ou effacer la stanza et la recréer avec **sa** phrase de passe : de nouveaux objets arrivent dans le bucket, toujours sans alerte.

À J+31, les verrous des vraies sauvegardes ont expiré, et la clé du nœud suffit à les effacer. Le verrou ne vaut que si quelqu'un regarde le bucket **sans passer par les nœuds**.

**Mesures** :
1. **Contrôle externe** : `infra/surveillance/controle-b2.sh`.
   - **Machine** : ni A ni B, et sans aucun accès à eux. Par défaut, une petite machine chez un troisième fournisseur, ou le poste de contrôle d'Ansible s'il est allumé en permanence. Utilisateur dédié, sans sudo.
   - **Clé** : clé B2 dédiée, limitée au bucket, capacités `listBuckets,listFiles` seulement. Passée par fichier `0600` ou par l'environnement, jamais en argument. Un vol de cette machine ne donne ni lecture ni écriture des sauvegardes.
   - **Ce qu'il vérifie** : objet le plus récent sous `wakatnet/backup/` de moins de 26 h ; WAL archivé le plus récent de moins d'une heure ; aucune marque d'effacement sur `backup.info` ni `archive.info` (pgBackRest les réécrit mais ne les efface jamais, sauf `stanza-delete` : c'est la trace d'une stanza recréée) ; bucket lisible. Toute anomalie, y compris l'impossibilité de lire, donne un code de sortie non nul.
   - **Fréquence** : toutes les heures (timer systemd). Délai de détection : 2 h pour les WAL, 27 h pour les sauvegardes, une heure pour une stanza effacée. Très en deçà des 30 jours de verrou.
   - **Alerte** : message sur un salon Telegram, par un **bot distinct** de celui des nœuds (un nœud compromis détient le jeton de leur bot et pourrait effacer ses messages). Un signe de vie quotidien (« en ordre ») part du même contrôle : son absence signale que le contrôle lui-même est tombé.
   - Planification : `docs/MISE_EN_PRODUCTION.md` §2, étape 7.
2. **Configuration de pgBackRest à root** (`root:postgres`, répertoires `0750`, fichiers `0640`) ; Ansible échoue si `conf.d` contient autre chose que `secret.conf`. C'est une défense en profondeur seulement : elle ferme le dépôt d'un fichier par un postgres compromis, pas `--config` ni `ALTER SYSTEM`, et rien face à root.
3. **Capacités de la clé des nœuds** fixées et contrôlées (point 5 et `docs/MISE_EN_PRODUCTION.md` §1).

**Ce que le contrôle ne voit pas** : un attaquant qui réécrit `backup.info` **par-dessus**, avec sa phrase, sans `stanza-delete`, ne laisse aucune marque d'effacement ; seul un essai de restauration le verrait. L'essai mensuel tourne sur les nœuds, donc sous le contrôle de l'attaquant. **Recommandé, non fait** : un essai de restauration mensuel sur une machine jetable hors des nœuds, avec la phrase de la copie hors site et une clé de lecture seule.

## Conséquences et risques

- **Stockage** : environ deux fois la taille des sauvegardes gardées, à cause des versions masquées encore verrouillées. Négligeable à notre échelle.
- **Irréversible** : on ne peut ni désactiver l'Object Lock d'un bucket, ni raccourcir un verrou en mode conformité. Une sauvegarde contenant une erreur reste 30 jours, ce qui est voulu.
- **Reste** : la fermeture du compte Backblaze, ou un impayé. Le compte se protège comme un compte bancaire (point 6). Et la machine du contrôle externe : si elle tombe en silence, plus rien ne regarde le bucket (d'où le signe de vie quotidien).
- **Données personnelles** : les sauvegardes sont chiffrées côté client (AES-256), et Backblaze ne voit que des blocs chiffrés. Il devient tout de même sous-traitant d'hébergement, en Europe : à inscrire au registre (`docs/CONFORMITE.md`, T9).
