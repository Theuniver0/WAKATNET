# 05 — Supervision, alertes, page d'état

## Critères d'acceptation
- Collecteur `sante.ts` : métriques du §10.3 au format texte de Prometheus, sur chaque nœud.
- Rôle `wk_sante` en lecture seule, par des fonctions dédiées.
- Alertes au changement d'état, vers Telegram (testé contre un faux serveur HTTPS). Aucune donnée personnelle dans une alerte.
- `GET /etat` publique, sans donnée de propriétaire.
- `logrotate` des compteurs de silence.
