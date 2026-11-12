# Mise en production des nœuds

- **Références** : ADR 0004, 0015, 0016 ; `infra/ansible/README.md` ; `docs/RUNBOOK.md`.
- **Qui** : Yacouba, à la main, étape par étape. Chaque étape se vérifie avant la suivante. L'agent ne se connecte à aucune machine de production.
- **État** : procédure **prouvée sur des conteneurs Ubuntu 24.04** (`infra/ansible/essais/essai.sh`, neuf étapes). Elle n'a **pas** été jouée sur Debian 13 ni sur un vrai VPS.

## 0. Avant de commencer

| Prérequis | Référence |
|---|---|
| Deux VPS Debian 13, IP fixes, B chez un **autre** hébergeur avant G-PILOTE | ADR 0004 |
| Nom de domaine : `api.` et `portail.` (le portail sur une IP dédiée, si l'hébergeur le permet) | ADR 0013 §10, ADR 0016 §2 |
| Accès console de chaque VPS (en cas de coupure SSH) | RUNBOOK §6 |
| Compte **Backblaze B2** (double authentification, distinct du compte Hetzner) ; bucket privé, région EU Central, **Object Lock activé à la création**, rétention par défaut **conformité 30 jours**, cycle de vie « versions masquées effacées après 31 jours » ; clé d'application limitée à ce bucket, sans droit sur ses réglages | ADR 0018, REVUE_SECURITE M8 |
| Clé PGDG et clé de l'éditeur de FreeRADIUS téléchargées **et vérifiées** (empreinte) dans `infra/ansible/cles/` | ADR 0004 point 5 |
| Bot Telegram et salon d'alertes | ADR 0015 §6 |
| Compte **Brevo** (double authentification) ; sous-domaine expéditeur `notif.DOMAINE` authentifié (SPF, DKIM selon la console Brevo, DMARC `p=quarantine`) ; clé API dans `/etc/wakatnet/api.env` : `WAKATNET_COURRIEL=brevo`, `WAKATNET_BREVO_CLE`, `WAKATNET_COURRIEL_DE=ne-pas-repondre@notif.DOMAINE` ; si Brevo le permet, clé limitée aux IP de A et B ; **suivi des ouvertures et des clics désactivé** | ADR 0019 |

## 1. Secrets, posés à la main sur chaque nœud

Liste et droits : `infra/ansible/README.md`. Un fichier par service, jamais dans le dépôt, jamais sur une ligne de commande. Générer chaque mot de passe ainsi :

```bash
head -c 24 /dev/urandom | base64
```

Garder hors des nœuds, dans un coffre :
- la phrase de passe de pgBackRest ;
- les clés `WAKATNET_CLE_MARCHANDS` et `WAKATNET_CLE_HMAC`. Sans elles, les comptes marchands sont illisibles après une restauration.

## 2. Premier déploiement

1. Inventaire : copier `infra/ansible/inventaire.exemple.yml` en `inventaire.yml`, puis renseigner les IP, les clés publiques WireGuard et les variables `frontal_*` (noms, `frontal_courriel_acme`).
2. Les DNS de `api.` et `portail.` pointent vers A **avant** le premier passage : c'est la condition du défi Let's Encrypt.
3. A, en primaire :

   ```bash
   ansible-playbook site.yml --limit noeud_a
   ```

4. B, en réplique. Sur une installation neuve, le répertoire de données de B est **effacé** :

   ```bash
   ansible-playbook site.yml --limit noeud_b -e postgresql_reconstruire_replique=true
   ```

5. Vérifier la réplication (RUNBOOK §1), puis la page `https://api.DOMAINE/etat`.
6. Super-admin, sur A. Le mot de passe est lu au clavier, sans écho ni historique. La clé de chiffrement est lue dans `/etc/wakatnet/api.env` par le shell de root, jamais passée en argument (visible dans `ps`) :

   ```bash
   read -r ADRESSE && read -rs MDP && printf '%s\n%s\n' "$ADRESSE" "$MDP" | sudo bash -c 'set -a; . /etc/wakatnet/api.env; set +a; export WAKATNET_ADMIN_DATABASE_URL=postgresql:///wakatnet; cd /opt/wakatnet/apps/api && exec runuser -u postgres -- node src/admin-creer.ts'; unset MDP
   ```

   Scanner une seule fois l'URI `otpauth://` affichée.

   **E-mail** (ADR 0019) : avec Brevo réglé, chaque propriétaire confirme son adresse par le lien reçu, puis se connecte (quota de 2 routeurs). Le super-admin le valide (Administration, **Valider l'adresse**) pour porter son quota à 10 et le sortir des plafonds des comptes non validés. Sans `WAKATNET_COURRIEL`, aucun e-mail ne part : un propriétaire inscrit ne peut pas se connecter tant que le super-admin n'a pas validé son adresse, après l'avoir vérifiée par un autre moyen (téléphone).

   Premier essai d'envoi : créer un compte d'essai avec une adresse à soi, vérifier la réception (et le dossier indésirables), le lien, puis la connexion.
7. Sauvegarde, sur A :

   ```bash
   sudo -u postgres pgbackrest --stanza=wakatnet stanza-create
   ```

   ```bash
   sudo -u postgres pgbackrest --stanza=wakatnet check
   ```

   ```bash
   sudo systemctl start wakatnet-sauvegarde.service
   ```

   ```bash
   sudo systemctl start wakatnet-essai-restauration.service
   ```

   L'alerte « essai de restauration » reste levée tant qu'aucun essai n'a réussi : on le lance donc dès le déploiement.

   **Exercice d'effacement, une fois, avant G-PILOTE** (ADR 0018) : sur un bucket B2 **d'essai**, réglé comme celui de production, refaire les étapes de `infra/noeud/essais/sauvegarde-s3.sh` à la main. Ce sont la sauvegarde, `stanza-delete --force`, une tentative d'effacement définitif d'une version (elle doit être refusée), puis la restauration avec `--repo-target-time` (RUNBOOK §7). Noter le résultat au journal du pilote. Le bucket d'essai reste facturé pendant ses 30 jours de verrou : quelques centimes.
8. Alertes : arrêter `wakatnet-wg-agent` une minute sur B, vérifier que l'alerte puis sa résolution arrivent sur Telegram, et le redémarrer.

## 3. Avant d'ouvrir la vente en ligne (G-ARGENT)

- Adaptateur réel en production, avec clés de production : seulement après G-ARGENT (`docs/PILOTE.md` §2).
- Compte marchand du propriétaire enregistré, webhook déclaré chez l'agrégateur (`https://api.DOMAINE/webhooks/...`).
- Un achat réel de 100 F, puis un rapprochement du jour (`docs/PILOTE.md` §4).

## 4. Mise à jour

Un nœud à la fois, B d'abord (RUNBOOK §5) :

```bash
ansible-playbook site.yml --limit noeud_b
```

```bash
ansible-playbook site.yml --limit noeud_a
```

Le pare-feu public programme son retour arrière avant d'être appliqué : une erreur de port SSH se corrige seule en 5 minutes.

Ordre quand une mise à jour touche le schéma : **migrations, puis API, puis `wg-agent`**. Ansible enchaîne les deux premières (l'API redémarre après les migrations) ; le binaire de `wg-agent` se remplace ensuite, à la main. Un `wg-agent` plus récent que le schéma ne fait que journaliser une erreur à chaque tour ; plus ancien, il ne note pas l'IP des routeurs (alerte `ip_routeurs`), et les hotspots retombent sur la garde de la migration 0031.

## 5. Retour arrière d'une mise à jour

- **Code** : repasser Ansible depuis l'étiquette Git précédente, dans le dépôt de contrôle.
- **Migration SQL** : on ne revient pas en arrière, puisque les migrations sont immuables. On écrit une migration corrective, et le schéma ne fait qu'avancer.
- **Base abîmée** : restauration (RUNBOOK §7).
