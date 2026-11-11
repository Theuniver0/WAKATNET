# 09 — Disconnect et CoA : émetteur et déclencheur

**PRD** : `../PRD.md` · **Matrice** : T9 (partie serveur), T12 (coupure au volume) · **Dépend de** : 08

## À livrer
- **Émetteur** (module réutilisable par le futur worker) :
  - Disconnect-Request et CoA-Request vers l'IP overlay du routeur ;
  - port porté par le routeur en base (§1.1 : 1700 d'après la doc, 3799 ailleurs) ;
  - secret lu par le seul rôle `wk_coa` ;
  - Message-Authenticator ;
  - authentificateur de la réponse **vérifié** ;
  - retentatives bornées ;
  - aucun secret en ligne de commande ni dans les journaux (S1).
- **Déclencheur minimal** hors du processus FreeRADIUS (règle 1), selon l'ADR 0006 point 17 : il lit les sessions « à couper » (volume épuisé, suspension, remboursement) et émet le Disconnect. Il émet aussi un CoA de changement de débit à la demande.
- **Faux NAS** de test (FreeRADIUS) : vérifie explicitement la présence du Message-Authenticator, le secret et l'IP source.

## Critères d'acceptation
- **T12 de bout en bout** : un Interim épuise le volume → la session est inscrite → Disconnect reçu par le faux NAS en moins d'un intervalle d'Interim.
- Le Disconnect porte `Acct-Session-Id` et `User-Name`, avec un secret valide et un Message-Authenticator.
- Mauvais secret côté faux NAS : aucune réponse, puis exactement N retentatives, comptées par le faux NAS.
- Réponse avec un authentificateur faux : rejetée par l'émetteur.
- CoA de débit : `Mikrotik-Rate-Limit` reçu par le faux NAS.

## Piste B
**T9 sur CHR** : session réellement coupée, puis Stop reçu ; port réel de `/radius incoming`.
