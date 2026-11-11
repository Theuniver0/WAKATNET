# 02 — T2 de bout en bout : un ticket neuf est accepté avec le bon Session-Timeout

**PRD** : `../PRD.md` · **Matrice** : T2 (authentification), T10 · **Dépend de** : 01

## À livrer
- `infra/sql/radius/` :
  - migrations du schéma minimal (ADR 0008) ;
  - création des tickets (générateur cryptographique, unicité par propriétaire) ;
  - `client_lookup` (avec l'exigence de Message-Authenticator par routeur) et `authorize` (cas « ticket neuf ») ;
  - rôles `wk_radius` et `wk_acct` ;
  - `search_path` fixé sur chaque fonction `SECURITY DEFINER`.
- `infra/freeradius/` (configuration de production) :
  - `dynamic_clients` avec `&FreeRADIUS-Client-Require-MA` tiré de `client_lookup` (E-FR-2), `lifetime` à 300 s ;
  - CHAP et PAP ;
  - `require_message_authenticator = yes` et `limit_proxy_state = yes` ;
  - un seul appel SQL par requête ;
  - `auth_goodpass = no` et `auth_badpass = no`.
- `radius/tests/run.sh` :
  - pile neuve ;
  - garde de version (≥ 3.2.10, jamais 3.2.9) ;
  - `radiusd -C` sur la configuration de production seule ;
  - au moins deux routeurs avec des IP et des secrets distincts ;
  - recherche de secrets dans les sorties.

## Critères d'acceptation
- **T2**, en CHAP **et** en PAP : un ticket « 1 h, jamais activé » donne un Accept avec `Session-Timeout = 3600`, plus `Mikrotik-Rate-Limit`, `Port-Limit` et `Acct-Interim-Interval` tirés de la copie figée.
- **Chaque Accept et chaque Reject porte un Message-Authenticator.**
- Mauvais mot de passe : Reject avec la cause fixée par l'ADR 0006.
- **T10** :
  - une Access-Request sans Message-Authenticator ne reçoit aucune réponse, **y compris le tout premier paquet** d'une IP pas encore en cache ;
  - preuve : la ligne « Packet does not contain required Message-Authenticator » dans le journal ;
  - contrôle positif dans le même passage : le même paquet avec l'attribut reçoit une réponse.
- **Clients** (rejeu de L1 et L4) :
  - IP inconnue, routeur inactif, IP hors overlay, mauvais secret : ignorés ;
  - désactivation en base effective après `lifetime`, réduit en test.
- `wk_radius` ne lit aucune table (L2 rejoué). `authorize` passe dans une transaction `READ ONLY`.
- Le test passe au rouge, puis au vert. Les sorties publiées ne contiennent que des valeurs de test jetables.

## Piste B
Connexion par ticket sur CHR 7.15 et sur la stable courante, avec Message-Authenticator dans l'Accept (LABO-00).
