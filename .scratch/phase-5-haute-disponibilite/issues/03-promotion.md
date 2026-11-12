# 03 — Promotion manuelle de B et retour de A en réplique

## Critères d'acceptation
- `promouvoir-b.sh` refuse si le PostgreSQL de A répond, et exige une confirmation tapée.
- Après la promotion, B accepte les écritures, et le spool de B s'y vide.
- `rejoindre-en-replique.sh` ramène A en réplique de B (`pg_rewind`, ou `pg_basebackup` en repli). Le spool de A se vide dans B.
- La durée totale est chronométrée dans la pile de test.
- `docs/RUNBOOK.md` décrit la procédure : bascule, retour, applications, DNS.
