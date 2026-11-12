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
   - un dépôt effacé fait échouer la sauvegarde de la nuit suivante, et l'alerte `sauvegarde` se lève dans les 26 h ;
   - avec 30 jours, au moins trois sauvegardes complètes, et leurs WAL, restent verrouillées le jour où l'on agit.
5. **Clé d'application des nœuds** :
   - limitée à ce bucket ;
   - droits de liste, lecture, écriture et effacement seulement ;
   - **sans** droit sur le bucket (réglages, cycle de vie, verrou), ni contournement du mode gouvernance.

   Même si cette clé fuit, les versions verrouillées restent intactes.
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
2. avec les clés du nœud, l'attaquant fait `pgbackrest stanza-delete`, puis efface tous les objets : pgBackRest ne voit plus rien ;
3. il tente d'effacer définitivement les versions : 986 tentatives, **toutes refusées** ;
4. `pgbackrest --repo-target-time` retrouve la sauvegarde, la restauration rejoue les WAL, et **la ligne témoin est là**.

## Vérifié ou non

- **Vérifié sur sources** : le mode conformité de B2 et son irréversibilité ; `--repo-target-time` et la correction de la 2.59.2.
- **Prouvé au banc** : le comportement de pgBackRest 2.58 face à un bucket versionné et verrouillé, sur un S3 de test, avec moins de 1 000 versions.
- **Non vérifié** :
  - B2 lui-même : en-têtes exigés à l'écriture dans un bucket verrouillé ; Backblaze déconseille une rétention par défaut avec certains logiciels de sauvegarde ;
  - le prix exact et le nom de la région.

  D'où l'**exercice de mise en service** (`docs/MISE_EN_PRODUCTION.md`) : sauvegarde, effacement, restauration avec `--repo-target-time`, sur B2, avant G-PILOTE.

## Conséquences et risques

- **Stockage** : environ deux fois la taille des sauvegardes gardées, à cause des versions masquées encore verrouillées. Négligeable à notre échelle.
- **Irréversible** : on ne peut ni désactiver l'Object Lock d'un bucket, ni raccourcir un verrou en mode conformité. Une sauvegarde contenant une erreur reste 30 jours, ce qui est voulu.
- **Reste** : la fermeture du compte Backblaze, ou un impayé. Le compte se protège comme un compte bancaire (point 6).
- **Données personnelles** : les sauvegardes sont chiffrées côté client (AES-256), et Backblaze ne voit que des blocs chiffrés. Il devient tout de même sous-traitant d'hébergement, en Europe : à inscrire au registre (`docs/CONFORMITE.md`, T9).
