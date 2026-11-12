# 06 — Déploiement reproductible d'un nœud (Ansible)

## Critères d'acceptation
- Rôles `socle`, `wireguard`, `postgresql`, `freeradius`, `pgbackrest`, `noeud_wakatnet` ; inventaire d'exemple, sans secret.
- `--syntax-check` et `ansible-lint` sans remarque.
- Exécution réelle sur deux conteneurs Debian 13 avec systemd ; un second passage ne change rien.
- Procédure de mise à jour un nœud à la fois dans `docs/RUNBOOK.md`.
