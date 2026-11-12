# 05 — wg-agent et pare-feu du nœud

**PRD** : `../PRD.md` · **Dépend de** : 02

## À livrer
- `apps/wg-agent` (Go) : réconciliation des pairs de `wg0` sur `app.wg_pairs()` ; réveil par `LISTEN wakatnet_pairs` et tour périodique ; garde anti-effacement ; journal sans clé privée.
- Migration SQL : rôle `wk_wg`, fonction `app.wg_pairs()`, déclencheur `NOTIFY`.
- `infra/nftables/wakatnet.nft` : aucun transfert `wg0 → wg0` ; entrées 1812/1813 et ICMP depuis `wg0` ; sorties 1700/3799 et ICMP vers `wg0`.
- Unité systemd `wakatnet-wg-agent.service`.

## Critères d'acceptation
- Tests Go (`-race`) sur une vraie interface WireGuard (wireguard-go) : ajout, suppression, clé changée, `AllowedIPs` = /32 exactement, pairs étrangers à la base retirés, interface jamais recréée.
- Base injoignable : aucun pair retiré.
- `nft -c -f` valide le fichier.
