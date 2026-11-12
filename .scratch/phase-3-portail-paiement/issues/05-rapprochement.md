# 05 — Rapprochement et expiration

**Dépend de** : 03 · **Matrice** : P3, P7, P8

## À livrer
- Tâche périodique : `verify()` pour tout paiement `PENDING` depuis plus de 2 min, puis toutes les 5 min pendant 24 h ; passage à `EXPIRED` après le délai du portail (3 min).
- Unité et minuterie systemd.

## Critères d'acceptation
- P3 : un webhook jamais reçu donne un ticket créé par le rapprochement.
- P7 : un succès après `EXPIRED` crée le ticket, et l'événement est journalisé.
- P8 : un agrégateur en panne donne un message clair, tandis que les tickets existants et RADIUS restent intacts.
