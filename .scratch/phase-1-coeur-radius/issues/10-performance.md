# 10 — Mesure de performance

**PRD** : `../PRD.md` · **Matrice** : objectifs du §5.6 · **Dépend de** : 09

## À livrer
- Jeu de données réaliste : 50 routeurs (la charge visée à 12 mois), 100 000 tickets et des sessions ouvertes. On teste aussi ×10 pour avoir de la marge.
- Mesure côté serveur :
  - p95 de `radius.authorize` (`EXPLAIN ANALYZE` et `pg_stat_statements`) ;
  - authentifications par seconde (radclient en parallèle, ou radperf s'il est disponible) ;
  - nombre de vCPU noté.
- Index et plans d'exécution justifiés.

## Critères d'acceptation
- Rapport `radius/tests/perf/RAPPORT.md` : chiffres mesurés, matériel, commande de rejeu.
- Objectifs de la spec : p95 < 50 ms et 200 auth/s sur 4 vCPU. Ils sont **mesurés, pas promis**. Un écart est signalé avec sa cause et une piste de correction.
