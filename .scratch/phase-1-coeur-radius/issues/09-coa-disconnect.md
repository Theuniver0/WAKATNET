# 09 — Émission de Disconnect et de CoA

**PRD** : `../PRD.md` · **Matrice** : T9 (partie serveur) · **Dépend de** : 08

## À livrer
- Outil d'émission (module réutilisable par le futur worker) :
  - Disconnect-Request et CoA-Request vers l'IP du routeur, port fixé explicitement (§1.1 : 1700 d'après la doc 7.25, 3799 ailleurs ; valeur portée par le routeur en base) ;
  - secret propre au routeur, Message-Authenticator inclus.
- Lecture du secret : uniquement par une fonction `radius.*` (C7). Aucun secret en ligne de commande ni dans les journaux (S1).
- Cas d'usage :
  - coupure d'une session : volume épuisé (ticket 05), suspension, remboursement ;
  - changement de débit (`Mikrotik-Rate-Limit`).
- Test côté serveur : un FreeRADIUS de test joue le NAS (serveur virtuel CoA), reçoit la requête, vérifie le secret et les attributs, et répond ACK ou NAK.

## Critères d'acceptation
- Un Disconnect reçu par le faux NAS porte `Acct-Session-Id` et `User-Name`, avec un secret valide et un Message-Authenticator valide.
- NAK ou absence de réponse : erreur journalisée et retentatives bornées.

## Piste B
**T9 sur CHR** : session réellement coupée, puis Stop reçu. Avec le port réel de `/radius incoming`.
