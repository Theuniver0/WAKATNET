# Raccorder un routeur MikroTik à WAKATNET (procédure du propriétaire)

- **Pour qui** : le propriétaire d'une zone Wi-Fi, ou Yacouba pour le pilote.
- **Références** : SPEC §2.2 (parcours 1), §6.2 (enrôlement en une commande) ; ADR 0012 ; `docs/AUDIT_SCRIPTS_ROUTEROS.md`.
- **État** : le parcours a été joué dans le tableau de bord (e2e de la phase 4). Les scripts RouterOS ont été audités, mais **pas encore exécutés sur un CHR**, ni sur un routeur vierge ni sur un routeur déjà configuré (§13, règle 6). À faire avant le premier routeur d'un tiers (G-PILOTE).

## Ce qu'il faut

- Un routeur MikroTik sous **RouterOS 7.15 ou plus récent** (`/system resource print`). RouterOS 6 n'est pas pris en charge.
- Un accès Internet sortant sur le routeur. Fibre, 4G ou Starlink conviennent : le tunnel part du routeur, aucun port n'est à ouvrir.
- Un accès administrateur au routeur : Winbox, ou le terminal par SSH.
- Une adresse e-mail et un mot de passe de 10 caractères au moins.

## 1. Créer son compte

1. Ouvrir `https://api.DOMAINE/tableau/`, puis **Créer mon compte** : nom de la zone Wi-Fi, adresse, mot de passe.
2. **Sites et routeurs** : saisir le nom du site (par exemple « Maquis du marché »), puis **Ajouter le site**.

## 2. Raccorder le routeur

1. Sur la ligne du site, cliquer **Raccorder un routeur**. Une commande s'affiche.
   - Elle est **valable 30 minutes** et ne sert **qu'une fois**.
   - Ne la partagez pas : elle permet d'enrôler un routeur sur votre compte.
2. Ouvrir le **Terminal** du routeur (Winbox : *New Terminal*), coller la commande, puis Entrée.
3. Le routeur :
   - télécharge son script de raccordement (certificat vérifié) ;
   - crée son tunnel WireGuard vers les deux nœuds de WAKATNET ;
   - déclare les deux serveurs d'authentification.
   
   Vos utilisateurs locaux et votre configuration de hotspot existants ne sont pas effacés.
4. Revenir au tableau de bord : le routeur apparaît dans la liste, avec la date d'enrôlement.

## 3. Page de connexion du hotspot

1. Sur la ligne du site, cliquer **Page de connexion du hotspot**, ce qui télécharge `login.html`.
2. Dans Winbox, *Files* : remplacer `hotspot/login.html` (ou le dossier HTML de votre profil de hotspot) par ce fichier.
3. Vérifier depuis un téléphone connecté au Wi-Fi : la page du portail WAKATNET s'ouvre.

## 4. Forfaits et vente

- **Forfaits** : nom, prix, durée de connexion, validité, débit, nombre d'appareils, puis **Créer le forfait**.
- **Vente en ligne** : par le portail, dès que le compte marchand est enregistré. Ce réglage arrivera avec l'adaptateur de paiement réel ; voir `docs/PILOTE.md` §2.
- **Vente en espèces** :
  1. **Points de vente**, puis **Tickets papier** et **Générer les tickets** ;
  2. **Imprimer (PDF)**, 10 tickets par page A4 ;
  3. **Marquer remis** quand le lot est donné au vendeur.
  
  Chaque ticket activé prélève les frais papier sur votre solde de crédits (ADR 0002).

## 5. En cas de problème

| Constat | Cause probable | Que faire |
|---|---|---|
| La commande répond « jeton expiré » ou « déjà utilisé » | Plus de 30 minutes, ou commande déjà collée | Cliquer de nouveau sur **Raccorder un routeur** |
| Le routeur n'apparaît pas | Pas d'Internet sortant, ou RouterOS antérieur à 7.15 | `/ping 1.1.1.1`, puis `/system resource print` |
| Les clients voient « serveur sans réponse » | Tunnel coupé | `/interface wireguard peers print` : l'échange doit dater de moins de 3 minutes |
| Code refusé alors qu'il est valable | Routeur d'un autre site, ou forfait limité à un site | Vérifier le site du forfait |

## 6. Retirer un routeur

1. Sur la ligne du routeur, **Script de désinstallation**, puis le coller dans le terminal du routeur. Il retire le tunnel, les serveurs d'authentification et la page de connexion de WAKATNET.
2. Dans le tableau de bord, **Révoquer**, puis **Confirmer la révocation**. Le routeur ne peut plus authentifier, même si la désinstallation n'a pas été faite.
