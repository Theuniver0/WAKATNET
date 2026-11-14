# Courriel à MoneyFusion — 14/11/2026

> **Pour Yacouba, avant l'envoi.** Ce courriel remplace ceux de pawaPay et de CinetPay, retirés du projet le 14/11/2026 (ADR 0024). Les courriels du 10/11/2026 (`2026-11-10-agregateurs.md`) n'ont jamais été envoyés et restent comme trace. Ordre d'envoi et suivi : `docs/courriels/2026-11-14-LISEZMOI.md`.
>
> - **Adresse** : support de MoneyFusion, [adresse], à prendre sur la page officielle « Contact » du site. Aucune adresse n'est vérifiée dans le dépôt.
> - **Pas de pièce jointe.** Les questionnaires du 10/11/2026 (`pj/*.docx`) visent pawaPay et CinetPay : ne pas les joindre.
> - **Ne rien promettre** sur les volumes : ils ne sont pas mesurés (`docs/G0.md`, Q1).
> - **Aucun secret** dans le courriel : ni lien API, ni clé.
> - **Suivi** : noter la date d'envoi au §4 de `docs/QUESTIONS_AGREGATEURS.md`. Relance conseillée après 10 jours ouvrés.
> - **Report des réponses** : voir le tableau sous le courriel.

---

## MoneyFusion

**Objet :** WAKATNET — compte marchand pour des exploitants de WiFi Zones au Burkina Faso : huit questions

Madame, Monsieur,

Telecom Universel, société basée à Ouagadougou, prépare le lancement de **WAKATNET**. Cette plateforme permet aux exploitants de WiFi Zones du Burkina Faso de vendre leurs forfaits de connexion depuis leur portail Wi-Fi, payés par Orange Money et Moov Money.

Nous avons préparé l'intégration de votre API de paiement, d'après votre documentation publique (`docs.moneyfusion.net`). Avant tout encaissement réel, nous avons besoin de vos réponses **écrites** sur huit points.

**1. Contrat marchand.** Dans notre modèle, **chaque exploitant a son propre compte** « Money Fusion Enterprise » et reçoit directement l'argent de ses clients. Notre plateforme ne détient jamais ces fonds. L'exploitant crée son application et nous remet son lien API ; **notre plateforme appelle l'API pour lui**, depuis les adresses IP de nos serveurs, qu'il déclare dans son application.
- Ce montage est-il permis par vos conditions ?
- Faut-il un contrat entre vous et notre plateforme, en plus du contrat de chaque exploitant ?
- Un exploitant burkinabè, personne physique, entreprise individuelle ou société, peut-il ouvrir un compte ? Avec quelles pièces, et dans quel délai ?

**2. Entité et agrément pour le Burkina Faso.** Votre site indique que MoneyFusion est « Partenaire reconnu par plusieurs institutions agréées BCEAO ». Nous n'avons pas trouvé d'agrément propre.
- Quelle entité fournit vos services d'encaissement au Burkina Faso, et laquelle signerait le contrat d'un exploitant burkinabè ?
- Êtes-vous agréés comme établissement de paiement, ou travaillez-vous sous l'agrément d'une autre institution ? Laquelle ?
- Quelle pièce pouvez-vous nous communiquer pour l'attester ?

**3. Sens de `Montant` au statut.** C'est pour nous un point **bloquant**. Notre serveur ne délivre un ticket qu'après avoir lu le montant payé dans la réponse de `GET /paiementNotif/{token}`. Dans la réponse de statut, `Montant` est-il le montant **brut** payé par le client, ou le montant **net** de `frais` ? Votre exemple de statut donne 200 pour 200 ; votre exemple de webhook donne 194 et 6 de frais.

**4. Devise du statut.** La réponse de statut ne mentionne pas la devise. Est-elle toujours le franc CFA (XOF) pour un compte ouvert au Burkina Faso ? Peut-elle être différente ?

**5. Mode test.** Existe-t-il un mode test ou un bac à sable, avec des numéros de test, pour essayer l'intégration sans argent réel ? Sinon, que nous conseillez-vous pour un premier essai ?

**6. Relevé du compte.** Nous rapprochons chaque jour nos ventes avec votre relevé. Pouvez-vous nous indiquer :
- comment l'obtenir (export du tableau de bord, API) ;
- la liste exacte des colonnes et leur ordre, ainsi que le séparateur ;
- le format des dates et leur **fuseau horaire** ;
- le format des montants, et la façon dont les frais apparaissent ;
- les libellés exacts des statuts ;
- la référence portée par chaque ligne : votre jeton, votre `numeroTransaction`, ou notre référence, que nous transmettons dans `personal_Info`.

**7. Signature des webhooks.** Vos webhooks (`payin.session.pending`, `.completed`, `.cancelled`) ne semblent pas signés. Existe-t-il une signature, un secret partagé ou une liste d'adresses IP d'émission que nous pourrions vérifier ? Vos webhooks peuvent-ils être répétés ou arriver dans le désordre ?

**8. Changement d'adresse IP du serveur.** Seules les IP enregistrées peuvent appeler l'API. Quand l'adresse d'un de nos serveurs change (bascule vers le serveur de secours, changement d'hébergeur), quelle est la procédure pour l'ajouter ? Peut-on déclarer plusieurs IP ? Quel est le délai de prise en compte ?

Nous vous serions aussi reconnaissants de nous indiquer où sont hébergées les données des transactions, dont le numéro du payeur, et si vous proposez un accord de traitement des données.

Nous vous remercions par avance de votre réponse, et restons à votre disposition pour un échange.

Veuillez agréer, Madame, Monsieur, nos salutations distinguées.

[Nom et fonction]
Telecom Universel, Ouagadougou
[Téléphone] · [Adresse]

---

## Où reporter chaque réponse

| Point | Où le reporter |
|---|---|
| 1. Contrat marchand | `CONFORMITE.md` §3, ligne « MoneyFusion » : entité contractante, contrat signé, modes autorisés par écrit, encaissement pour compte de tiers. Et §12, première case (contrat signé de l'agrégateur de lancement) |
| 2. Entité et agrément | `CONFORMITE.md` §4, ligne « MoneyFusion », colonnes « Statut » et « Vérifié par Yacouba » ; §3, colonne « Entité contractante » ; et §12, deuxième case |
| 3. Sens de `Montant` | **aucune case de CONFORMITE.md** : ADR 0024, décision 5 (brut ou net). Une réponse écrite ne remplace pas le premier essai réel en petits montants, qui tranche |
| 4. Devise du statut | **aucune case de CONFORMITE.md** : ADR 0024, décision 5 (devise « XOF » posée, [À CONFIRMER]) |
| 5. Mode test | ADR 0024, « Risques acceptés » (aucun bac à sable) ; `docs/PILOTE.md` §2, G-ARGENT, ligne « Adaptateur réel » |
| 6. Relevé | **aucune case de CONFORMITE.md** : `docs/PILOTE.md` §4 (relevé MoneyFusion, non documenté) ; ADR 0024, « Risques acceptés » (format du relevé) |
| 7. Signature des webhooks | **aucune case de CONFORMITE.md** : ADR 0024, décision 3 et « Risques acceptés » (webhook non signé) |
| 8. Changement d'IP | ADR 0024, « Risques acceptés » (IP déclarées) ; `docs/ONBOARDING_ROUTEUR.md`, étape MoneyFusion ; `docs/PILOTE.md` §2, G-ARGENT |
| Données | `CONFORMITE.md` §6, ligne « Données échangées avec MoneyFusion » ; §7, T2, colonnes « Destinataires » et « Lieu d'hébergement » |
