# ADR 0019 — Fournisseur d'e-mail : Brevo, et les protections exigées par l'ADR 0017

- **Statut** : décidé le 12/11/2026, par délégation de Yacouba (« tranche le fournisseur d'e-mail »). Restent à vérifier à l'ouverture du compte, et notés comme tels : la mention de marque sur l'offre gratuite, et la restriction des clés par IP.
- **Références** : ADR 0017 (M4 : vérification de l'adresse ; conditions avant de brancher un fournisseur) ; `docs/REVUE_SECURITE.md` (M4, F9) ; migration 0034.

## Besoin

- Un seul usage, **transactionnel** : le lien de confirmation de l'adresse d'un propriétaire, et l'avis « un compte existe déjà ».
- Le volume est infime : quelques messages par propriétaire. Aucun envoi commercial.
- Exigences :
  - données dans l'Union européenne (adresses e-mail de propriétaires burkinabè ; `docs/CONFORMITE.md`) ;
  - API HTTP stable, sans nouvelle dépendance (`fetch` de Node suffit) ;
  - authentification du domaine expéditeur (SPF, DKIM, DMARC) pour arriver en boîte de réception chez Gmail et Outlook, où lisent la plupart des propriétaires ;
  - coût nul ou quasi nul à ce volume.

## Décision

1. **Brevo** (France). Sources du 12/11/2026 :
   - offre gratuite de 300 e-mails par jour ;
   - API transactionnelle `POST https://api.brevo.com/v3/smtp/email` (en-tête `api-key`) ;
   - données hébergées en France et en Allemagne ;
   - mode « bac à sable » (en-tête `X-Sib-Sandbox: drop`) : il valide un envoi sans l'expédier. L'API ne l'utilise pas ; il peut servir à un essai à la main de la clé, avec `curl`.
2. **Écartés** :
   - **Scaleway TEM** : bon prix, mais son API est encore en `v1alpha1` ; c'est la seconde option si Brevo déçoit ;
   - **Mailjet** : convient, sans avantage sur Brevo ;
   - **Postmark** et **Resend** : données aux États-Unis ;
   - **Amazon SES** : gratuit seulement la première année, et configuration plus lourde ;
   - **notre propre serveur SMTP** : délivrabilité médiocre depuis une IP de VPS.
3. **Expéditeur** : `ne-pas-repondre@notif.DOMAINE`, un sous-domaine dédié, pour ne pas mêler sa réputation à celle du domaine principal. SPF et DKIM selon la console Brevo, DMARC en `p=quarantine`.
4. **Secrets** :
   - la clé API est dans `/etc/wakatnet/api.env` (`WAKATNET_BREVO_CLE`), jamais dans le dépôt ni sur une ligne de commande ;
   - compte Brevo avec double authentification ;
   - si Brevo le permet, la clé est limitée aux IP des nœuds A et B (à vérifier) ;
   - **suivi des ouvertures et des clics désactivé** dans la console : sinon Brevo réécrit le lien, et le jeton de confirmation passe par son domaine de suivi et ses journaux ;
   - l'adaptateur refuse les redirections, pour que la clé ne suive jamais une redirection vers un autre domaine, et ne lit jamais le corps des réponses.
5. **Réglage** :
   - `WAKATNET_COURRIEL=brevo`, `WAKATNET_COURRIEL_DE`, `WAKATNET_COURRIEL_NOM` ;
   - sans `WAKATNET_COURRIEL`, aucun envoi. Un propriétaire inscrit **ne peut pas se connecter** tant que le super-admin n'a pas validé son adresse. Ce n'est plus comme avant : la connexion d'un compte non confirmé est désormais refusée.
   - **Au déploiement de la migration 0034**, lister les propriétaires non confirmés et valider ceux qui sont connus :

     ```sql
     SELECT id, email FROM app.utilisateur WHERE role = 'proprietaire' AND email_verifie_le IS NULL
     ```

     Sinon, ils ne peuvent plus se connecter.
6. **Les conditions de l'ADR 0017, remplies dans ce même changement** (migration 0034) :
   - **inscription sans session, réponse toujours identique** (202) : un compte neuf reçoit le lien ; une adresse déjà inscrite reçoit un avis. Cela ferme **F9** ;
   - **connexion refusée** à un propriétaire dont l'adresse n'est pas confirmée, avec le **même message** que pour un mauvais mot de passe : « adresse ou mot de passe incorrect, ou adresse pas encore confirmée » ;
   - **renvoi du lien sans session** (`POST /v1/verification/renvoyer`), réponse toujours identique ;
   - **limites par source** : 5 inscriptions par heure, et 5 renvois par heure. En IPv6, la source est le /48, puisqu'un abonné peut en recevoir un entier ;
   - **avis « compte existant »** : au plus 1 par jour et par compte, compté à part des liens. Sinon, un tiers épuisait en 5 inscriptions les liens d'un compte neuf, qui restait bloqué ;
   - **plafond global de 200 e-mails par 24 h** (le quota gratuit de Brevo est de 300 par jour), avec l'alerte `courriels` à 160 ;
   - **adresse libérée** : un propriétaire jamais confirmé au bout de 7 jours voit son adresse remplacée par une adresse factice, et son compte est désactivé. Rien n'est effacé ; la vraie titulaire peut alors s'inscrire ;
   - l'**envoi part en arrière-plan** : la durée de la réponse ne dépend pas de l'aller-retour vers Brevo ;
   - **quota de 2 routeurs** pour un compte vérifié par lien ; 10 dès que le super-admin le valide ;
   - **pour les comptes non validés par le super-admin** : au plus 100 **routeurs enrôlés** par jour, tous comptes non validés confondus (alerte `plafond_enrolement`), et aucune commande au-delà de 90 % de l'overlay. Baisser le quota d'un compte suspect ne le valide pas ;
   - `app.inscription`, qui ouvrait une session, n'est plus appelable par l'API : une API restée sur l'ancien code ne rouvre pas F9 pendant le déploiement.
7. **Sous-traitant** : Brevo reçoit l'adresse e-mail des propriétaires (`docs/CONFORMITE.md`, T4). L'accord de traitement (DPA) et la durée de conservation de ses journaux d'envoi restent à inscrire au registre.

## Conséquences

- Un propriétaire se vérifie seul. Le super-admin ne valide plus que pour relever le quota au-delà de 2.
- **Remplir l'overlay** demande désormais 32 258 comptes, chacun vérifié par une boîte aux lettres (64 516 adresses ÷ 2). Le plafond global en limite le rythme à 100 enrôlements par jour, soit plus de 600 jours. L'alerte `overlay_plein` laisse le temps d'agir.
- **Déni de service résiduel** : un attaquant qui enrôle 100 routeurs dans la journée suspend, ce jour-là, les raccordements des comptes non validés ; l'alerte `plafond_enrolement` le signale. Le plafond des 200 e-mails peut aussi être épuisé par un envoi en masse, ce qui retarde les vrais propriétaires (alerte `courriels`).
- **Un e-mail perdu bloque la connexion** : le propriétaire redemande un lien depuis l'écran de connexion. Sinon, Telecom Universel valide l'adresse.
- **Reste** :
  - des adresses jetables, mais au rythme borné ci-dessus ;
  - l'énumération par minutage : le hachage du mot de passe a lieu dans les deux cas, avant la base, et l'envoi part en arrière-plan. Il ne reste qu'un écart de quelques appels à la base, de l'ordre de la milliseconde.

## Audit du 13/11/2026 (comptes, inscription, vérification de l'adresse)

Constats reproduits par l'auditeur ; corrigés par la migration 0039, `auth.ts`, `app.ts`, `courriel.ts` et `CompteMarchand.tsx`. Tests : `auth.test.ts` et `courriel.test.ts` (« audit 13/11/2026 »).

1. **[Élevé] Toute inscription bloquée.** La purge à 7 jours renommait l'adresse en `purge-<id>@wakatnet.invalid`, sur une colonne unique, et l'API acceptait cette forme. Un tiers réservait d'avance l'adresse d'une purge à venir : la purge, lancée par chaque inscription, échouait, et toute inscription répondait 500.
   - L'API refuse le domaine de premier niveau `.invalid` (inscription et renvoi).
   - La contrainte `utilisateur_email_reservee` n'admet une adresse de `wakatnet.invalid` que sous la forme `purge-<id de la ligne elle-même>` : deux lignes ne peuvent plus viser la même adresse de purge. Posée `NOT VALID` ; les adresses réservées d'avance sont neutralisées comme une purge (compte désactivé, journal d'audit `adresse_reservee_neutralisee`), puis la contrainte est validée.
   - La purge tourne dans une sous-transaction : son échec n'annule qu'elle, jamais l'inscription.
   - La purge reste sur le chemin de l'inscription. La sortir vers une tâche planifiée serait plus propre ; ce n'est plus nécessaire à la sûreté.
2. **[Moyen] Contournement de F9 par la longueur du nom.** L'API admettait 120 caractères, la colonne 80 : 500 sur une adresse libre, 202 sur une adresse prise, et l'essai en erreur n'était pas compté. Désormais : 80 dans l'API ; toute erreur de la création répond comme une adresse prise ; l'essai est compté avant la création et l'erreur ne l'annule plus.
3. **[Moyen] Pré-appropriation.** Un tiers inscrivait l'adresse de la victime avec son propre mot de passe ; le lien que la victime suivait confirmait le compte du tiers. Désormais, une inscription qui vise une adresse **inscrite et non confirmée** remplace le mot de passe et invalide les liens ouverts (statut `attente`, journal d'audit). La réponse reste la même (F9). Un avis **sans lien** part (« compte en attente » : le mot de passe est celui de la dernière demande ; redemander un lien depuis l'écran de connexion), sur le budget des avis (1 par jour et par compte, à part des liens) : un tiers qui se réinscrit en boucle n'épuise toujours pas les 5 liens du compte.
   - **Pourquoi ce choix** : la dernière demande fixe le mot de passe, et seule la titulaire de la boîte reçoit le lien qui confirme. Une adresse confirmée n'est jamais touchée. Rien dans la réponse ne dit si l'adresse était libre, en attente ou confirmée. Le rythme reste borné par les limites par source et le plafond global.
   - **Reste** : un tiers qui se réinscrit après la titulaire et avant son clic fixe encore le mot de passe. Il ne peut pas se connecter avant la confirmation, et la titulaire, qui ne peut pas se connecter, se réinscrit. Fermer cette course demande un **parcours de réinitialisation du mot de passe** (ou un mot de passe choisi au moment de la confirmation) : suite recommandée, non faite ici.
4. **[Moyen] Liens comptés sans partir.** Plafond global plein, chaque inscription ou renvoi créait et comptait un lien qui ne partait jamais ; au bout de 5, le compte était bloqué. Désormais, la place sur le plafond est prise **avant** de créer le lien, dans la même transaction (`verification_creer`, et de même pour les avis) ; un envoi refusé par le fournisseur est décompté (`verification_annuler`), sans rendre sa place sur le plafond (le fournisseur a pu l'envoyer). Nouveau plafond quotidien par source : **10 demandes par 24 h**, inscriptions et renvois confondus, en plus des 5 par heure et par nature. La source étant un HMAC du jour UTC, la fenêtre repart au changement de jour.
5. **[Faible] Journal des erreurs 500.** L'objet d'erreur entier était journalisé, avec le `DETAIL` de PostgreSQL (« Failing row contains » : adresse, nom, empreinte scrypt). Désormais : classe, code, code SQLSTATE et nom de la contrainte, jamais le message, la pile ni le `DETAIL`.
6. **[Faible] Minutage du renvoi.** Une adresse en attente déclenchait des requêtes de plus avant la réponse. `/v1/verification/renvoyer` répond désormais 202 avant tout travail en base, qui se fait après la réponse (500 travaux au plus en attente) ; les erreurs sont journalisées sans donnée personnelle. L'arrêt de l'API attend la fin de ces travaux.
7. **[Faible] Jeton pawaPay et gestionnaire de mots de passe.** Le champ `type="password"` était proposé à l'enregistrement par le navigateur. Désormais : champ texte masqué par une classe de la feuille de style (`-webkit-text-security: disc`, permis par `style-src 'self'`), `autoComplete="off"`, attributs d'exclusion des gestionnaires courants, et champ vidé aussi en cas d'erreur. Un navigateur sans `-webkit-text-security` affiche le jeton pendant la saisie ; il n'est jamais réaffiché ensuite.
