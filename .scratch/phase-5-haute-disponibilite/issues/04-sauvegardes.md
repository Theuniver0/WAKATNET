# 04 — Sauvegardes chiffrées, restauration chronométrée, essai mensuel

## Critères d'acceptation
- pgBackRest, dépôt chiffré, archive des WAL, sauvegarde prise sur la réplique.
- Restauration chronométrée sur le jeu de données de charge. La durée est notée au journal.
- `essai-restauration.sh` : migrations, équilibre du grand livre, comparaison du grand livre avec la base vivante. Une écriture modifiée après la sauvegarde est détectée (test).
- Minuterie systemd mensuelle (`systemd-analyze verify`).
