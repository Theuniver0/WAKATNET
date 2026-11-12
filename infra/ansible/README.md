# Déploiement des nœuds (Ansible)

- **Références** : ADR 0015 §7, `docs/RUNBOOK.md` §5. Ticket : `.scratch/phase-5-haute-disponibilite/issues/06-deploiement.md`.
- **Versions** : ansible-core 2.21.6, modules `ansible.builtin` seulement ; nœud de contrôle sous Linux ou WSL.
- **Usage**, un nœud à la fois, B d'abord :

```bash
ansible-playbook site.yml --limit noeud_b
```

```bash
ansible-playbook site.yml --limit noeud_a
```

## À poser à la main sur chaque nœud, avant le premier passage

Les rôles vérifient la **présence** et les droits de ces fichiers, jamais leur contenu. Aucun ne passe par Ansible ni par le dépôt.

| Fichier | Propriétaire, mode | Contenu |
|---|---|---|
| `/etc/wireguard/wk-noeuds.key` | root, 0600 | clé privée WireGuard du lien entre nœuds (`wg genkey`) |
| `/etc/wakatnet/freeradius.secrets` | root:freerad, 0640 | `WAKATNET_PG_RADIUS_PASSWORD`, `WAKATNET_PG_ACCT_PASSWORD` |
| `/etc/wakatnet/pg-roles.env` | root, 0600 | les mots de passe des rôles lus par `migrer.sh` (`WAKATNET_PG_*_PASSWORD`) |
| `/etc/wakatnet/api.env`, `coa.env`, `maint.env`, `sante.env`, `wg-agent.env` | root, 0600 | variables des unités (voir chaque unité dans `infra/systemd/`) |
| `/etc/pgbackrest/conf.d/secret.conf` | postgres, 0600 | `repo1-cipher-pass`, clés S3 ; **copie hors des nœuds obligatoire** |
| `~postgres/.pgpass` (**les deux nœuds**) | postgres, 0600 | lignes `wk_replication` et `wk_rewind` vers l'autre nœud (`wk_rewind` sert aussi à la garde contre le double primaire) |

Dans le dépôt de contrôle, non versionnés : `inventaire.yml` (copie de `inventaire.exemple.yml`), `cles/pgdg.asc`, et la clé de l'éditeur de FreeRADIUS. Ces clés publiques sont vérifiées à la main, empreinte comprise.

## Gardes

- Un nœud déclaré **réplique** qui n'en est pas une (ancien primaire, ou installation neuve) n'est jamais effacé. Pour une installation neuve, il faut passer `-e postgresql_reconstruire_replique=true`. Pour un ancien primaire, c'est `infra/noeud/rejoindre-en-replique.sh` (RUNBOOK §4).
- FreeRADIUS : la version est refusée si elle est inférieure à 3.2.10 ou égale à 3.2.9. Sans `freeradius_depot` (dépôt de l'éditeur, **[À CONFIRMER]**), les paquets de la distribution sont refusés.
- nftables : seules les tables de WAKATNET sont rechargées (jamais `flush ruleset`, qui effacerait les règles de Docker). SSH n'est jamais touché.

## Essai

```bash
WAKATNET_ANSIBLE_BIN=/chemin/du/venv/bin infra/ansible/essais/essai.sh
```

Le banc lance deux conteneurs Ubuntu 24.04 avec systemd, et rejoue les gardes, la réplication et l'idempotence.
- **Non couvert par l'essai** : `wireguard` (module du noyau), `noeud_wakatnet` (téléchargement de Node) et le dépôt PGDG.
- **Debian 13** reste à rejouer sur une VM avant G-PILOTE (ADR 0004 point 5).
