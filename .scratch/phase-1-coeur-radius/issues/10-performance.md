# 10 — Mesure de performance

**PRD** : `../PRD.md` · **Matrice** : objectifs du §5.6 · **Dépend de** : 07 (peut passer avant 08 et 09)

## À livrer
- **Jeu de données** :
  - 50 routeurs (charge visée à 12 mois), plus un essai à ×10 ;
  - 100 000 tickets ;
  - sessions ouvertes ;
  - `auth_log` sur 90 jours au profil de 300 connexions par jour et par routeur.
- **Mesures**, CHAP avec Message-Authenticator, CPU épinglés (`cpuset`) et générateur de charge sur d'autres cœurs :
  - p95 de `authorize`, par `log_min_duration_statement = 0` ou `auto_explain` (pas `pg_stat_statements`, qui ne donne pas de p95) ;
  - authentifications par seconde, Accept et Reject séparés (`reject_delay` neutralisé pour la mesure, et noté) ;
  - débit de rattrapage du lecteur `detail` (enregistrements par seconde), et temps pour vider une heure de panne ;
  - coût de `post_auth`.
- Index et plans d'exécution justifiés.

## Critères d'acceptation
- `radius/tests/perf/RAPPORT.md` : chiffres mesurés, matériel, commande de rejeu.
- Objectifs de la spec (p95 < 50 ms, 200 auth/s sur 4 vCPU) **mesurés, pas promis**. Un écart est signalé avec sa cause et une piste de correction.
- Temps de rattrapage du `detail` comparé à la perte de données maximale de 5 min visée (§10.2).
