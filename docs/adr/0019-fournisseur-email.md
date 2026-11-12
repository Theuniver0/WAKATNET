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
