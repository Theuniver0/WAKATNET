# 02 — T13 de bout en bout : B authentifie sur sa réplique

## Critères d'acceptation
- La pile de test a deux nœuds : PostgreSQL A primaire, PostgreSQL B en réplique par flux avec un slot, un FreeRADIUS par nœud.
- `radius.post_auth` ne fait rien sur une réplique, sans erreur. Testé.
- PostgreSQL de A arrêté : un ticket vendu (avant la panne) obtient un Accept de B, avec le `Session-Timeout` exact.
- L'accounting reçu par B pendant la panne reste dans son spool, puis se vide dans A au retour de A. L'activation porte l'heure de réception d'origine.
- La coupure (ADR 0010) et les tâches de l'API sortent sans erreur sur la réplique.
