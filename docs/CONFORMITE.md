# Conformité — gabarit à remplir

> **Date de création : 10/11/2026.** Livrable du §15 item 12 du SPEC ; références : §1.4, §3 (D1), §8.3, §10.1, §12 (porte G-ARGENT).
> **Ce document n'est pas un avis juridique, fiscal ni comptable.** Il rassemble ce qu'un ingénieur a pu constater, avec le statut de chaque constat, et les cases que Yacouba doit faire remplir par un juriste, un comptable et les prestataires.
> **Tout est [À CONFIRMER]** tant qu'une pièce écrite (contrat, avis signé, récépissé, extrait officiel) n'est pas référencée dans la case correspondante.

---

## 1. Règle de blocage du mode B

> **Le mode B (« collecte centralisée » : encaissement sur le compte marchand de Telecom Universel, puis reversement aux propriétaires) reste DÉSACTIVÉ EN PRODUCTION tant que ce fichier ne contient pas, au §2, à la fois :**
> 1. **l'accord écrit de l'agrégateur** autorisant explicitement ce montage, et
> 2. **un avis juridique écrit** concluant que ce montage est licite au regard de la réglementation BCEAO applicable au Burkina Faso, avec le statut sous lequel il s'exerce.
>
> Une réponse orale, un courriel commercial non engageant ou une clause générale de CGU ne suffisent pas. Le mode C (répartition par un prestataire agréé) reste un ticket R&D tant que les mêmes pièces n'existent pas pour lui.

Pourquoi (lecture d'ingénieur, pas un avis juridique) : l'Instruction BCEAO n°001-01-2024 soumet la fourniture de services de paiement dans l'UMOA à un agrément (statut de vérification au §4). Encaisser l'argent destiné à des tiers puis le leur reverser ressemble à un service de paiement. Le mode A (chaque propriétaire encaisse sur son propre compte marchand, la plateforme ne touche que sa commission, prélevée sur un solde de crédits prépayés) est le mode par défaut parce qu'il évite ce montage (§3 D1, §8.2).

Contrôle technique attendu : le drapeau qui active `settlement_mode = B` en production doit exiger une référence à la ligne du §2 ci-dessous (identifiant de l'accord et de l'avis). La porte **G-ARGENT** (§12) exige aussi que ce fichier soit rempli avant toute clé de production, même en mode A.

---

## 2. Verrou du mode B et du mode C

| Pièce | Mode | Référence du document | Date | Signataire / auteur | Portée exacte (opérateurs, pays, plafonds) | Réserves | Statut |
|---|---|---|---|---|---|---|---|
| Accord écrit de l'agrégateur | B | | | | | | [À CONFIRMER] |
| Avis juridique sur le mode B | B | | | | | | [À CONFIRMER] |
| Accord écrit de l'agrégateur | C | | | | | | [À CONFIRMER] |
| Avis juridique sur le mode C | C | | | | | | [À CONFIRMER] |

Questions à poser au juriste pour l'avis sur le mode B [À CONFIRMER] :

1. Le montage « compte marchand de Telecom Universel → dette envers chaque propriétaire → reversement périodique » constitue-t-il un service de paiement au sens de l'Instruction n°001-01-2024 ?
2. Si oui, peut-il s'exercer sous l'agrément de l'agrégateur (agent, mandataire, sous-marchand, « payment facilitator », marque blanche), et à quelles conditions ?
3. La commission de 10 % est-elle analysée différemment selon qu'elle est prélevée à la source (mode B) ou facturée sur un solde de crédits prépayés (mode A) ?
4. Le solde de crédits prépayés du mode A peut-il être requalifié en monnaie électronique ou en fonds de tiers ? Quelles précautions (non-remboursabilité, usage limité au service) ?
5. Quelles obligations de lutte contre le blanchiment (connaissance du propriétaire, déclarations) s'appliquent à Telecom Universel dans chaque mode ?
6. Quel droit et quelle juridiction pour les contrats avec des agrégateurs établis hors du Burkina (Côte d'Ivoire, Sénégal, Bénin) ?

---

## 3. Accords avec les agrégateurs

Une ligne par prestataire contacté (voir `docs/QUESTIONS_AGREGATEURS.md` et `docs/PAYMENT_PROVIDERS.md`).

| Prestataire | Entité contractante | Contrat signé (réf., date) | Modes autorisés par écrit (A / B / C) | Encaissement pour compte de tiers autorisé ? | Grille tarifaire écrite (réf.) | Clauses de blocage des fonds | Préavis de hausse | Statut |
|---|---|---|---|---|---|---|---|---|
| pawaPay / Kerry Payments Burkina | | | | | | | | [À CONFIRMER] |
| CinetPay | | | | | | | | [À CONFIRMER] |
| YengaPay / Kreezus | | | | | | | | [À CONFIRMER] |
| LigdiCash | | | | | | | | [À CONFIRMER] |
| InTouch Burkina | | | | | | | | [À CONFIRMER] |
| FedaPay | | | | | | | | [À CONFIRMER] |
| Wave (recharge des crédits) | | | | | | | | [À CONFIRMER] |

Points relevés dans les conditions publiques, à faire confirmer (tous **non vérifiés** : vus en extrait de moteur de recherche, pages non chargées) :

- pawaPay : interdiction de créer un compte pour un tiers ou en son nom ; annexe « sous-marchands » soumise à l'approbation de sa conformité.
- CinetPay : offre « marque blanche » permettant à un partenaire d'agréger des marchands ; compte réservé à une entreprise établie dans le pays d'encaissement ; « un compte = un pays » (ce dernier point est écrit dans le README du SDK PHP officiel, lu directement).
- PayDunya : cession du compte interdite sans accord écrit ; blocage des fonds jusqu'à 120 jours en cas de fraude.
- Flutterwave : « Payment Facilitators (unless Registered & Licensed) » soumis à pré-approbation.
- Wave : « Aggregated Merchants » réservé à certaines entreprises, sous contrat.

---

## 4. Statut d'agrément de chaque prestataire

**Avertissement de méthode.** Le site de la BCEAO (`www.bceao.int`, `downloads.bceao.int`) et celui du CB-UMOA (`www.cb-umoa.org`) étaient inaccessibles depuis l'environnement de travail le 10/11/2026. **Aucun texte BCEAO n'a été lu directement.** Les numéros ci-dessous viennent d'extraits de moteur de recherche des PDF officiels. Statuts :

- **partiel** : vu dans un extrait d'une source officielle, sans lecture du document ;
- **non vérifiable** : seulement un décompte, une absence, ou des sources de presse ;
- **[À CONFIRMER]** : en attente de la lecture du document officiel par Yacouba, ou d'une confirmation écrite du prestataire.

Une absence d'une liste d'**établissements de paiement** ne prouve rien : la liste ne couvre ni les banques, ni les établissements de monnaie électronique, ni les agents d'un établissement agréé.

| Prestataire | Entité | Constat | Source vue | Statut | Vérifié par Yacouba (date, lien, capture) |
|---|---|---|---|---|---|
| InTouch | INTOUCH Burkina (SARL) | EP **EP.BF.001/2025**, sur les listes au 15/09/2025 et au 28/02/2026. La date « 9 mai 2025 » ne vient que de la presse, contredite par d'autres dates | Extraits des PDF BCEAO ; presse | partiel (numéro) ; non vérifiable (date) | [À CONFIRMER] |
| pawaPay | KERRY Payments Burkina (SA) | EP **EP.BF.002/2025**, sur la liste au 28/02/2026, absente de celle du 15/09/2025. La page « Local Partners » de pawaPay la présente comme son entité locale | Extrait du PDF BCEAO ; extrait du site pawaPay | partiel | [À CONFIRMER] |
| CinetPay | CINETPAY AFRICA | EP **EP.CI.007/2025** (Côte d'Ivoire), du 29/08/25, liste au 28/02/2026. Absent des EP du Burkina. Régime d'exercice au Burkina inconnu | Extrait du PDF BCEAO | partiel | [À CONFIRMER] |
| PayDunya | DUNYA Digital Payment Côte d'Ivoire / Sénégal | **EP.CI.008/2025** (29/08/25) et **EP.SN.001/2025** (06/05/25), liste au 28/02/2026. Le lien entre « Dunya Digital Payment » et la marque PayDunya n'est sourcé nulle part | Extrait du PDF BCEAO | partiel (numéros) ; non vérifié (lien de marque) | [À CONFIRMER] |
| FedaPay | FEDAPAY (SA) | **EP.BN.004/2026** (Bénin) : vu sur la liste BCEAO Bénin 2026 (extrait) et sur le site FedaPay. Absent de la liste au 28/02/2026. Le site FedaPay se décrit tantôt « Établissement de Paiement », tantôt « agrégateur de paiement ». Date du 02/04/2026 : presse seulement. Rien au Burkina | Extraits ; presse | partiel | [À CONFIRMER] |
| KkiaPay | OPEN SI | **EP.BN.002/2025** (Bénin), du 04/09/25, liste au 28/02/2026. Le lien entre Open SI et KkiaPay n'est sourcé nulle part | Extrait du PDF BCEAO | partiel (numéro) ; non vérifié (lien) | [À CONFIRMER] |
| Flutterwave | FLUTTERWAVE Sénégal | **EP.SN.004/2025** (Sénégal), du 22/05/25, liste au 28/02/2026. Rien au Burkina | Extrait du PDF BCEAO | partiel | [À CONFIRMER] |
| LigdiCash | ? | Ne figure sous ce nom dans aucune liste vue. Une absence ne prouve rien (autre raison sociale, catégorie EME, agent) | Aucune source officielle ; un ticket GitHub tiers | non vérifiable | [À CONFIRMER] par écrit de LigdiCash |
| YengaPay | Kreezus | Non trouvé sur les listes vues | — | non vérifiable | [À CONFIRMER] par écrit de Kreezus |
| Moneroo | ? (raison sociale « Axa Zara LLC » non sourcée) | Se déclare lui-même non-PSP, sans compte marchand : l'agrément pertinent est celui de la passerelle sous-jacente | Extrait du site Moneroo | non vérifié | [À CONFIRMER] |
| Wave | UBA Burkina (émetteur), en partenariat avec Wave Mobile Money SA | Selon les CGU Wave au Burkina, le service est émis par UBA Burkina, émetteur de monnaie électronique. Statut de Wave Mobile Money SA dans les listes BCEAO non vérifié | Extrait des CGU Wave BF | non vérifié | [À CONFIRMER] |
| Orange Money BF, Moov Money, autres portefeuilles | — | La page BCEAO « Établissements de monnaie électronique » donnerait pour le Burkina : 1 Trésor, 1 EME, 0 SFD, 9 partenariats banque–opérateur, soit 11 entrées. La plupart des services mobile money du Burkina seraient donc des **partenariats banque–opérateur**, pas des EME autonomes. Le libellé du SPEC §1.4 « émetteurs de monnaie électronique » est donc probablement inexact comme statut juridique. Page non datée, non lue | Extrait de la page BCEAO | non vérifiable | [À CONFIRMER] |

Documents que Yacouba doit ouvrir lui-même et archiver (capture ou PDF daté) :

- https://www.bceao.int/fr/communique-presse/liste-des-etablissements-de-paiement-agrees-dans-lumoa-au-31-aout-2026 (et le PDF qu'elle référence)
- https://www.bceao.int/sites/default/files/2026-03/LISTE%20DES%20ETABLISSEMENTS%20DE%20PAIEMENT%20AGR%C3%89%C3%89S%20DANS%20L%E2%80%99UMOA%20au%2031%20janvier%202026.pdf
- https://www.bceao.int/sites/default/files/2025-09/LISTE_DES_ETABLISSEMENTS_DE_PAIEMENT_AGREES_15_septembre_2025.pdf
- https://www.bceao.int/fr/content/etablissements-de-monnaie-electronique
- La liste conjointe CB-UMOA des EME et EP pour 2026 (`www.cb-umoa.org`), pour chercher LigdiCash et Kreezus sous une autre raison sociale.

---

## 5. Cadre réglementaire constaté

| ID | Fait | Constat | Statut | À faire |
|---|---|---|---|---|
| REG-1 | **Instruction BCEAO n°001-01-2024 du 23 janvier 2024** relative aux services de paiement dans l'UMOA : fournir des services de paiement exige un agrément | Titre et date vus sur la page réglementaire officielle de la BCEAO (via moteur de recherche). Des sources secondaires précisent : agrément comme établissement de paiement, délai d'instruction de 6 mois à compter d'un dossier complet, période transitoire close le 31/08/2025 (Avis n°004-03-2025 du 19/03/2025, communiqué du 27/05/2025). Le SPEC §16 cite une source tierce (osiris.sn) au lieu du texte officiel | partiel | Lire le PDF officiel : https://bceao.int/sites/default/files/inline-files/Instruction-No001-01-2024_relative_aux_services_de_paiement_dans_l-UMOA.pdf ; page réglementaire : https://www.bceao.int/fr/reglementations/instruction-ndeg001-01-2024-du-23-janvier-2024-relative-aux-services-de-paiement |
| REG-2 | **34 établissements de paiement agréés dans l'UMOA au 31/08/2026** (SN 11, CI 10, BJ 4, TG 3, BF 2, ML 2, NE 1, GW 1) | La page officielle existe (publiée le 08/10/2026). Seule la fin de la ventilation (NE 1, SN 11, TG 3) a été vue en extrait par le contre-vérificateur ; le total ne vient que d'un extrait et d'un site de presse béninois. Décomptes antérieurs : 30 au 15/09/2025, 31 au 28/02/2026 (secondaires) | non vérifiable | Lire la page et le PDF |
| REG-3 | **2 établissements de paiement au Burkina : InTouch Burkina, Kerry Payments Burkina** | Les deux noms ne sont attestés que pour la liste au **28/02/2026**. Aucun fichier Burkina 2026 n'a été trouvé parmi les PDF par pays | partiel (au 28/02/2026) ; non confirmé au 31/08/2026 | Lire la liste au 31/08/2026 |
| REG-4 | **PI-SPI** ouverte le 30/09/2025 | Lancement à Dakar le 30/09/2025 par le gouverneur de la BCEAO, après un pilote à partir du 05/06/2025 : sources secondaires concordantes ; page officielle de lancement non lue | partiel | Lire https://www.bceao.int/fr/content/lancement-officiel-de-la-plateforme-interoperable-du-systeme-de-paiement-instantane-pi-spi |
| REG-5 | **175 participants autorisés** à ouvrir PI-SPI au public au 30/09/2026 (BF 20) | Presse seulement (financialafrik, dakaractu). Seul point officiel vu en extrait : communiqué BCEAO du 25/06/2026, 80 participants connectés au 24/06/2026, échéance du 30/09/2026 pour banques, EME et EP, du 30/06/2027 pour la microfinance | non vérifiable | Trouver la liste BCEAO des participants au 30/09/2026 |
| REG-6 | **PI-SPI obligatoire depuis le 02/11/2026** pour les transactions de monnaie électronique interopérables (banques et EME ; microfinance jusqu'au 30/06/2027) | Sources secondaires citant un communiqué BCEAO du 02/10/2026, non lu. Elles rapportent aussi : transferts gratuits jusqu'à 8 000 FCFA par jour (presse contradictoire), plafond des comptes de monnaie électronique porté de 2 à 4 millions de FCFA, Wave absent de PI-SPI à la date de démarrage. **Le SPEC §1.4 (« rail futur ; hors v1 ») est probablement dépassé** sur ce point, sans obliger WAKATNET, qui passe par des agrégateurs, à intégrer PI-SPI | non vérifiable | Lire le communiqué BCEAO du 02/10/2026 ; poser la question 32 du questionnaire aux agrégateurs |
| REG-7 | Statut juridique des portefeuilles au Burkina | Voir la dernière ligne du §4 | non vérifiable | — |

---

## 6. Protection des données — CIL (Commission de l'Informatique et des Libertés, Burkina Faso)

Aucune source sur la CIL n'a été consultée dans cette session : **rien ci-dessous n'est un fait vérifié.** Les cases servent à recueillir les réponses de la CIL ou d'un juriste.

| Point | Réponse | Pièce (réf., date) | Statut |
|---|---|---|---|
| Texte applicable (loi burkinabè sur la protection des données personnelles, et ses décrets) | [référence exacte à relever sur le site de la CIL] | | [À CONFIRMER] |
| Rôles : Telecom Universel est-il responsable de traitement, sous-traitant des propriétaires, ou les deux selon le traitement ? Chaque propriétaire est-il responsable du traitement des données de ses clients ? | | | [À CONFIRMER] |
| Formalité préalable exigée (déclaration, demande d'avis, autorisation) pour chaque traitement du §7 | | | [À CONFIRMER] |
| Récépissé ou numéro de la formalité | | | [À CONFIRMER] |
| Transfert de données hors du Burkina : les 2 VPS (D6) sont-ils hébergés hors du pays ? Conditions d'un transfert vers ce pays | | | [À CONFIRMER] |
| Données échangées avec les agrégateurs (numéro du payeur) : accord de traitement, pays d'hébergement | | | [À CONFIRMER] |
| Information des personnes : mentions à afficher sur le portail captif (texte court, compatible §7.1) | | | [À CONFIRMER] |
| Droits des personnes (accès, rectification, opposition, effacement) : procédure et délai de réponse | | | [À CONFIRMER] |
| Notification des violations de données : à qui, dans quel délai | | | [À CONFIRMER] |
| Conservation des journaux de connexion : existe-t-il une **obligation légale** de conservation pour un fournisseur d'accès Wi-Fi public (durée minimale ou maximale) ? Elle pourrait primer sur les durées proposées au §7 | | | [À CONFIRMER] |

---

## 7. Registre des traitements

Collecte minimale (§10.1 du SPEC) : la plateforme ne demande ni nom, ni inscription, ni SMS au client final (D9). **Les durées et les bases légales ci-dessous sont des propositions techniques à valider par un juriste et par la CIL ; elles sont paramétrables dans la plateforme.**

| # | Traitement | Données | Personnes concernées | Finalité | Base légale proposée | Durée de conservation proposée | Destinataires | Lieu d'hébergement | Mesures de sécurité | Statut |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | Authentification sur le hotspot | **Adresse MAC** du client (`Calling-Station-Id`), IP attribuée, identifiant du routeur, code du ticket | Clients finaux | Ouvrir l'accès acheté, lier un ticket à un appareil (`Port-Limit`), limiter les abus | Exécution du contrat de vente du forfait [À CONFIRMER] | Durée de validité du ticket + [N] jours ; journal `auth_log` : [N] jours | Propriétaire du site ; Telecom Universel (exploitation) | VPS A et B ([pays À CONFIRMER]) | Cloisonnement par `tenant_id` et RLS ; accès restreint ; chiffrement des sauvegardes | [À CONFIRMER] |
| T2 | Paiement d'un forfait | **Numéro du payeur**, opérateur, montant, référence et statut du paiement, corps brut des webhooks (`payment_event`) | Clients finaux | Encaisser, délivrer le ticket, récupérer un ticket après fermeture de la page (§7.2), traiter les litiges et remboursements, rapprochement | Exécution du contrat ; obligations comptables pour les pièces de paiement [À CONFIRMER] | Données de paiement : durée d'archivage comptable [À CONFIRMER avec le comptable] ; numéro du payeur dans les données opérationnelles : [N] mois, puis pseudonymisé | Agrégateur concerné ; propriétaire ; Telecom Universel | VPS A et B ; agrégateur ([pays À CONFIRMER]) | Webhooks vérifiés ; corps bruts en accès restreint ; aucune donnée de paiement dans les logs applicatifs | [À CONFIRMER] |
| T3 | Sessions et comptabilité d'usage (accounting) | Début, fin, durée, octets entrants et sortants, cause de fin, MAC, IP, routeur | Clients finaux | Appliquer les limites du forfait, statistiques du propriétaire, supervision, litiges | Exécution du contrat ; intérêt légitime pour la supervision [À CONFIRMER] ; obligation légale éventuelle (§6) | Table `session` partitionnée par mois : [N] mois, puis agrégats anonymes | Propriétaire ; Telecom Universel ; autorités sur réquisition [À CONFIRMER] | VPS A et B | Partitions supprimées à échéance ; accès par rôle | [À CONFIRMER] |
| T4 | Comptes des propriétaires, gérants et vendeurs | Identité, téléphone, courriel, rôle, point de vente, journal des connexions, 2FA | Propriétaires, gérants, vendeurs | Gestion du compte et des droits, sécurité, support | Exécution du contrat de service WAKATNET | Durée du contrat + [N] ans [À CONFIRMER] | Telecom Universel ; **Brevo** (sous-traitant d'envoi : adresse e-mail et texte du message de confirmation, ADR 0019) | VPS A et B ; Brevo (France, Allemagne) | 2FA du super-admin ; mots de passe hachés ; audit | [À CONFIRMER] |
| T5 | Connaissance du propriétaire et facturation | Raison sociale, RCCM, IFU, coordonnées de paiement, factures de commission, recharges de crédits | Propriétaires | Facturer la commission, obligations fiscales et comptables, lutte contre la fraude | Obligation légale ; exécution du contrat [À CONFIRMER] | Durée légale de conservation des pièces comptables [À CONFIRMER avec le comptable] | Telecom Universel ; comptable ; administration fiscale | VPS A et B | Accès restreint | [À CONFIRMER] |
| T6 | Clés API des propriétaires (mode A) | Clés et secrets des comptes marchands | Propriétaires | Encaisser pour le compte du propriétaire sur son propre compte marchand | Exécution du contrat | Jusqu'à révocation par le propriétaire ou fin du contrat | Personne (jamais réaffichées) | VPS A et B | Chiffrées au repos ; jamais dans les logs ni le dépôt (§8.2, §10.1) | [À CONFIRMER] |
| T7 | Journal d'audit | Auteur, action sensible, horodatage, objet | Super-admin, propriétaires, gérants | Traçabilité, sécurité, litiges | Intérêt légitime ; obligation de sécurité [À CONFIRMER] | [N] ans [À CONFIRMER] | Telecom Universel | VPS A et B | Ajout seul | [À CONFIRMER] |
| T8 | Grand livre | Écritures liées aux paiements, reversements, commissions (références vers T2) | Propriétaires ; indirectement clients finaux | Comptes exacts et reconstructibles (§8) | Obligation légale comptable [À CONFIRMER] | Durée légale comptable [À CONFIRMER] | Telecom Universel ; comptable | VPS A et B | Ajout seul, aucune mise à jour ni suppression | [À CONFIRMER] |
| T9 | Sauvegardes | Copie chiffrée de toutes les bases | Toutes | Reprise après sinistre (§10.2) | Intérêt légitime ; obligation de sécurité | Environ 4 semaines (4 complètes), verrouillées 30 jours, versions effacées 31 jours après (ADR 0018) | Telecom Universel ; **Backblaze B2**, sous-traitant de stockage (ne voit que des blocs chiffrés) | Hors site, Union européenne (région EU Central de B2, [À CONFIRMER] à l'ouverture) | Chiffrement AES-256 côté client, verrou en mode conformité, test de restauration mensuel | [À CONFIRMER] |
| T10 | Limitation des abus (ADR 0016, migrations 0031 et 0032) | Journal d'accès de nginx : **IP en clair**, chemin, date ; en base : adresse e-mail saisie à la connexion et HMAC du jour de la source (jamais l'IP), empreinte du cookie d'appareil connu ; **IP publique de chaque routeur** (connexion du propriétaire, souvent un particulier), relevée par `wg-agent` | Clients finaux, propriétaires, gérants, vendeurs, attaquants | Bloquer la devinette des mots de passe et l'envoi massif de demandes de paiement | Intérêt légitime ; obligation de sécurité [À CONFIRMER] | nginx : rotation du paquet (environ 14 jours) [À CONFIRMER] ; échecs de connexion : 1 jour ; demandes de paiement : 1 heure ; appareils connus : 90 jours ; IP du routeur : effacée à la révocation, ou après 1 jour sans être revue | Telecom Universel | VPS A et B | HMAC à clé renouvelée chaque jour ; purge à chaque appel ; les sauvegardes les gardent aussi longtemps qu'elles | [À CONFIRMER] |

### 7 bis. Durées réellement appliquées par le code (relevé du 13/11/2026)

Ce que fait la plateforme aujourd'hui. Le juriste et la CIL valident ou font changer ces valeurs ; le registre ci-dessus doit les reprendre. Chaque ligne cite sa source.

| Donnée (traitement) | Durée appliquée | Source |
|---|---|---|
| Numéro du payeur en clair (T2) | **6 mois**, puis effacé ; restent le HMAC et la forme masquée | `purge_numero_le` = création + 6 mois (migration 0037), `app.numeros_purger()` (0022), ADR 0005 |
| Tentatives de récupération d'un achat (T2) | 24 heures | `app.numeros_purger()` (0022) |
| Journal d'authentification RADIUS, MAC comprise (T1) | **90 jours** | `radius.purge_auth_log()` (radius 0009), ADR 0005 |
| Alertes RADIUS, MAC comprise (T1) | 90 jours | `radius.purge_auth_log()` (radius 0009) |
| Échecs de connexion au tableau de bord (T10) | 1 jour | migrations 0023, 0030, 0031 |
| Essais TOTP (T4) | 1 jour | migration 0030 |
| Demandes de paiement par source, en HMAC (T10) | 1 heure | migrations 0031, 0032 |
| Demandes d'inscription par source, en HMAC (T10) | 1 jour | migrations 0034, 0039 |
| Appareils connus (empreinte du cookie, T10) | 90 jours | migration 0031 |
| IP publique d'un routeur (T10) | effacée à la révocation, ou après 1 jour sans être revue | migration 0032, wg-agent |
| Liens de vérification d'adresse (T4) | valides 24 heures, effacés après 7 jours | migration 0039 |
| Compte propriétaire jamais confirmé (T4) | adresse libérée après 7 jours (renommée `purge-<id>@wakatnet.invalid`) | migrations 0034, 0039, ADR 0019 |
| Envois d'e-mails comptés pour le plafond (T4) | 2 jours | migration 0034 |
| Vérifications du compte marchand (T6) | 1 heure | migration 0037 |
| Journal d'accès de nginx, IP en clair (T10) | rotation du paquet Debian, environ 14 jours | ADR 0016 §2 |
| Sauvegardes (T9) | 4 complètes hebdomadaires, verrou de 30 jours, versions effacées 31 jours après | ADR 0018 |

**Aucune purge n'est codée pour les données suivantes : à trancher avant G-PILOTE.**
- **Sessions RADIUS** (T3 : MAC, IP, octets, durées). `radius.session` n'est ni purgée ni partitionnée (le commentaire de radius 0005 parle d'un partitionnement mensuel « futur »). La durée du registre (« [N] mois, puis agrégats ») n'est donc pas appliquée.
- **Corps bruts des webhooks** (T2, `payment_event`). Avec pawaPay, ils contiennent le numéro du payeur en clair, qui survit donc à la purge de 6 mois. C'est le constat F4 de la revue de phase 5, toujours ouvert.
- **Journal d'audit** (T7) : conservé sans limite. C'est cohérent avec « ajout seul », mais la durée « [N] ans » du registre n'existe pas dans le code.

Conflit à arbitrer : la purge des données personnelles (T1 à T3) et l'immuabilité du grand livre (T8). Proposition technique : le grand livre ne référence que des identifiants internes ; le numéro du payeur vit dans `payment` et peut être pseudonymisé à échéance sans toucher aux écritures [À CONFIRMER].

---

## 8. ARCEP (Autorité de Régulation des Communications Électroniques et des Postes, Burkina Faso)

Aucune source ARCEP n'a été consultée dans cette session : **rien ci-dessous n'est un fait vérifié.**

| Question | Réponse | Pièce | Statut |
|---|---|---|---|
| Un propriétaire de WiFi Zone qui revend de l'accès Internet au public doit-il détenir une licence, une autorisation ou faire une déclaration ? | | | [À CONFIRMER] |
| Telecom Universel, qui fournit la plateforme logicielle sans fournir la connectivité, est-il soumis à un régime ARCEP pour WAKATNET ? | | | [À CONFIRMER] |
| Obligations d'identification des utilisateurs d'un accès Wi-Fi public (la plateforme ne collecte que la MAC et le numéro du payeur) | | | [À CONFIRMER] |
| Obligations de conservation des données de connexion et de réponse aux réquisitions (voir aussi §6) | | | [À CONFIRMER] |
| Usage des fréquences Wi-Fi (bandes libres, puissance) par les propriétaires | | | [À CONFIRMER] |
| Conséquence pour WAKATNET : faut-il exiger des propriétaires une attestation de régularité avant l'enrôlement d'un routeur ? | | | [À CONFIRMER] |

---

## 9. Fiscalité et comptabilité (SYSCOHADA)

À remplir avec le comptable de Telecom Universel (§8.5 du SPEC). Aucune règle fiscale n'a été vérifiée dans cette session.

| Question | Réponse du comptable | Date | Statut |
|---|---|---|---|
| Mentions obligatoires de la facture mensuelle de commission au Burkina | | | [À CONFIRMER] |
| TVA applicable à la commission de la plateforme ; à la vente de crédits prépayés (mode A) : exigible à la recharge ou à la consommation ? | | | [À CONFIRMER] |
| Imputation SYSCOHADA : produit de commission, crédits prépayés non consommés (dette envers le propriétaire, produit constaté d'avance ?), frais d'agrégateur | | | [À CONFIRMER] |
| Mode B : imputation de la dette envers les propriétaires et du compte de compensation chez l'agrégateur | | | [À CONFIRMER] |
| Frais d'agrégateur hors taxes (CinetPay, pawaPay annoncent des frais HT) : TVA récupérable ? | | | [À CONFIRMER] |
| Retenue à la source ou autre prélèvement sur des paiements à des prestataires étrangers (agrégateurs établis hors du Burkina) | | | [À CONFIRMER] |
| Durée légale de conservation des pièces comptables (alimente T2, T5, T8 du §7) | | | [À CONFIRMER] |
| Le relevé par propriétaire (§8.5) peut-il servir de pièce justificative pour sa propre comptabilité ? | | | [À CONFIRMER] |
| Arrondi de la commission (au franc le plus proche, 0,5 au franc supérieur, §8.1) : acceptable fiscalement ? | | | [À CONFIRMER] |

---

## 10. Marque WAKATNET — dépôt à l'OAPI

| Étape | Résultat | Date | Pièce | Statut |
|---|---|---|---|---|
| Recherche d'antériorité sur « WAKATNET » (et variantes proches) dans les bases de l'OAPI | | | | [À CONFIRMER] |
| Choix des classes de produits et services (à déterminer avec un conseil en propriété industrielle : logiciel, télécommunications, services informatiques en ligne, services de paiement ?) | | | | [À CONFIRMER] |
| Choix du déposant (Telecom Universel) et du mandataire | | | | [À CONFIRMER] |
| Dépôt : numéro, date | | | | [À CONFIRMER] |
| Publication et période d'opposition | | | | [À CONFIRMER] |
| Enregistrement : numéro, date, échéance de renouvellement | | | | [À CONFIRMER] |
| Nom de domaine réservé (D6) : nom, registraire, date d'échéance | | | | [À CONFIRMER] |

---

## 11. Contrats avec les propriétaires

| Pièce | Version | Date | Validée par (juriste) | Statut |
|---|---|---|---|---|
| Conditions générales d'utilisation de la plateforme | | | | [À CONFIRMER] |
| Conditions de commission (taux par défaut 10 %, D3), de recharge et de suspension des crédits (§8.2), frais hors ligne (D4) | | | | [À CONFIRMER] |
| Accord de traitement des données (si Telecom Universel est sous-traitant des propriétaires, §6) | | | | [À CONFIRMER] |
| Procédure de litige et de remboursement (§8.5) | | | | [À CONFIRMER] |
| Mode B uniquement : convention de reversement (seuil, calendrier, gel en cas d'écart de rapprochement, §8.3) | | | | [À CONFIRMER] — interdit en production avant le §2 |

---

## 12. Validation

La porte **G-ARGENT** (§12 du SPEC) ne s'ouvre que si les cases suivantes sont cochées et référencées :

- [ ] §3 : au moins un contrat d'agrégateur signé pour l'adaptateur de lancement (D2), avec sa grille tarifaire écrite.
- [ ] §4 : statut d'agrément de cet agrégateur vérifié sur un document officiel, ou confirmé par écrit.
- [ ] §6 et §7 : formalités CIL accomplies ou réponse écrite indiquant qu'aucune n'est requise ; registre validé.
- [ ] §8 : position ARCEP connue.
- [ ] §9 : facture de commission validée par le comptable.
- [ ] §11 : CGU et conditions de commission validées.
- [ ] Mode B : **§2 rempli** (accord écrit + avis juridique). Sinon, le mode B reste désactivé, ce qui n'empêche pas d'ouvrir G-ARGENT pour le mode A.

| Rôle | Nom | Date | Visa |
|---|---|---|---|
| Responsable Telecom Universel | | | |
| Juriste | | | |
| Comptable | | | |

---

## 13. Historique

| Date | Modification | Auteur |
|---|---|---|
| 10/11/2026 | Création du gabarit ; report des constats réglementaires de la phase 0 (aucun texte BCEAO lu directement) | Agent (phase 0) |
