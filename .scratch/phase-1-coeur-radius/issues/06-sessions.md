# 06 — Appareils simultanés, sessions fantômes, Accounting-On/Off, bind_mac

**PRD** : `../PRD.md` · **Matrice** : T5, T8 · **Dépend de** : 05

## À livrer
- Contrôle côté serveur du nombre d'appareils (ADR 0006, point 9) : sessions ouvertes + Accept récents sans Start. Refus `trop_d_appareils`. `Port-Limit` est envoyé en plus.
- Sessions fantômes (rôle `wk_maint`) :
  - fermeture sans Interim depuis 3 intervalles, l'intervalle étant **mémorisé sur la session** ;
  - calcul fondé sur l'instant de **réception** du dernier Interim ;
  - **aucune purge tant que le `detail` n'est pas vidé**.
- Interim ou Stop arrivés après une fermeture d'office : mise à jour des compteurs, sans réouverture.
- `acct_on_off` : ferme les sessions démarrées **avant** l'instant de réception, et incrémente l'époque du routeur.
- `bind_mac` au point d'écriture fixé par l'ADR 0006.
- Planification (ADR 0006, point 17) : la fonction SQL est testée directement. L'unité systemd est vérifiée par `systemd-analyze verify`, ou son rejeu est renvoyé au nœud Debian.

## Critères d'acceptation
- **T5** : deuxième appareil sur un ticket à 1 appareil → `trop_d_appareils`. **Course** : deux Access-Request depuis deux routeurs avant tout Start, avec le comportement documenté et testé.
- **T8** : routeur redémarré sans Stop → sessions fermées au délai ; reconnexion acceptée ; temps consommé jusqu'au dernier Interim conservé.
- Purge lancée pendant le rejeu d'un backlog : **aucune** fermeture à tort.
- Accounting-On rejoué après de nouveaux Start : les nouvelles sessions restent ouvertes.
- `Acct-Session-Id` réutilisé après Accounting-On : deux sessions distinctes.
- `bind_mac` : un second appareil est refusé avec la cause fixée par l'ADR ; le premier appareil est de nouveau accepté.

## Piste B
`mac-cookie` avec RADIUS (LABO). LABO-18.
