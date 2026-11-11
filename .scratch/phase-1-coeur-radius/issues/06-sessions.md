# 06 — Appareils simultanés, sessions fantômes, Accounting-On/Off

**PRD** : `../PRD.md` · **Matrice** : T5, T8 · **Dépend de** : 05

## À livrer
- Contrôle côté serveur du nombre d'appareils : sessions ouvertes du ticket comparées à `devices`, en plus de `Port-Limit` envoyé au routeur (§5.4). Refus `trop_d_appareils`.
- Sessions fantômes : fermeture d'office sans Interim depuis 3 intervalles, par une tâche planifiée (fonction SQL appelée par un timer systemd, ou par le worker plus tard). Le temps consommé jusqu'au dernier Interim reste compté.
- `radius.acct_on_off` : ferme les sessions ouvertes du routeur.
- `bind_mac` : un ticket lié au premier appareil refuse un second appareil. La MAC n'est jamais la seule clé d'accès.

## Critères d'acceptation
- T5 : un deuxième appareil sur un ticket à 1 appareil donne Reject et `trop_d_appareils`.
- T8 : un routeur redémarré sans Stop voit ses sessions fermées au délai, et la reconnexion est de nouveau acceptée.
- Accounting-On reçu : sessions du routeur fermées, compteurs intacts.

## Piste B
Comportement de `mac-cookie` avec RADIUS (LABO), sur CHR.
