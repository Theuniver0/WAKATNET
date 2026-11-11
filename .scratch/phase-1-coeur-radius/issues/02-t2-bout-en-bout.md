# 02 — T2 de bout en bout : un ticket neuf est accepté avec le bon Session-Timeout

**PRD** : `../PRD.md` · **Matrice** : T2 (partie authentification), T10 · **Dépend de** : 01

## Objectif
Première tranche verticale : radclient → FreeRADIUS 3.2.10 → `radius.authorize` → Access-Accept avec le `Session-Timeout` exact.

## À livrer
- `infra/sql/radius/` :
  - migrations du schéma minimal fixé par l'ADR 0008 ;
  - `radius.client_lookup` et `radius.authorize`, limitée au cas « ticket neuf » ;
  - rôles `wk_radius` (EXECUTE seul) et `wk_acct`.
- `infra/freeradius/` (configuration de production, distincte de `infra/dev/`) :
  - serveur virtuel `dynamic_clients` avec `&FreeRADIUS-Client-Require-MA = yes` (E-FR-2) et `lifetime` à 300 s ;
  - module `sql` sur PostgreSQL ;
  - CHAP et PAP ;
  - `require_message_authenticator = yes` et `limit_proxy_state = yes`.
- `radius/tests/` :
  - lanceur `run.sh` (une commande, code de sortie non nul en cas d'échec) ;
  - T2 et T10 automatisés. T10 réutilise `infra/lab/freeradius/tools/radreq.py` ou `Message-Authenticator !* ANY` en 3.2.10.
- La pile de dev (`infra/docker-compose.yml`) monte `infra/freeradius/` et applique les migrations.

## Critères d'acceptation
- T2 : un ticket « 1 h de temps, jamais activé » renvoie un Accept avec `Session-Timeout = 3600`, plus `Mikrotik-Rate-Limit` et `Port-Limit` issus de la copie figée du forfait.
- T10 : une Access-Request sans Message-Authenticator ne reçoit aucune réponse.
- Le rôle `wk_radius` ne peut lire aucune table (test L2 rejoué).
- Le test passe d'abord au rouge, puis au vert. La commande et sa sortie sont dans la PR.

## Piste B
Aucune pour ce ticket.
