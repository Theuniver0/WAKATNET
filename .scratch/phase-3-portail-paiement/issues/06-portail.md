# 06 — Portail captif

**Dépend de** : 03, 04 · **Matrice** : P6 · **Spec** : §7.1, §7.2 ; ADR 0005

## À livrer
- Pages rendues côté serveur, de moins de 100 Ko, sans ressource externe :
  - accueil (« J'ai un ticket » ou « Acheter ») ;
  - choix du forfait et de l'opérateur ;
  - attente, interrogation toutes les 3 s pendant 3 min au plus ;
  - ticket et auto-connexion ;
  - récupération.
- Page de redirection `login.html` du hotspot vers le portail (variables du §7.1).
- Récupération par jeton d'appareil, ou par numéro et 4 derniers caractères de la référence, avec une limite de tentatives.
- Numéro du payeur sous trois formes : en clair avec date de purge, HMAC et masqué.

## Critères d'acceptation
- P6 : la page fermée pendant `PENDING`, le ticket est proposé au retour.
- Jamais la MAC seule pour la récupération.
- Poids mesuré de chaque page.
