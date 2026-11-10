# ADR 0003 — Versions de RouterOS acceptées (décision D5)

- **Statut** : accepté par Yacouba le 10/11/2026, porte G0.
- **Références** : `docs/SPEC.md` §1.1, §2.3, §3 (D5), §4 (règle 1), §6, §11, §12, §13 (règles 3 et 6) ; `docs/LABO.md` (LABO-00, E-ROS-6).
- **Écart assumé avec la spec** : le §2.3 place RouterOS 6 hors v1, et le §11 classe son enrôlement parmi les limites à refuser. Cette décision de Yacouba les remplace pour RouterOS 6, dans les limites ci-dessous. Le texte de `docs/SPEC.md` n'est pas modifié ; c'est cet ADR qui fait foi sur ce point.

## Contexte

- WireGuard n'existe qu'à partir de RouterOS 7 ; la spec en fait l'overlay (§6.1).
- Le Message-Authenticator côté RouterOS serait présent depuis la 7.15, et aussi en 6.49.18 d'après un extrait de changelog. **Non vérifié** (LABO-00).
- Une part du parc des petites WiFi Zones tourne probablement sur des modèles bas de gamme (hAP lite, hAP ac lite : MIPS, 16 Mo de flash), souvent en RouterOS 6. Cette part n'est pas chiffrée.

## Décisions

1. **RouterOS 7 : minimum 7.15.** Le script d'enrôlement refuse toute version inférieure, avec un message clair et la procédure de mise à jour.
2. **RouterOS 6 : accepté, en phase 2b**, c'est-à-dire après la preuve complète du chemin v7 (phase 2) et **avant l'enrôlement des propriétaires pilotes tiers**. Le pilote sur les sites de Telecom Universel se fait en v7.
   - Versions : **6.49.x long-term uniquement**. Minimum 6.49.18 si LABO-00 confirme qu'elle porte le Message-Authenticator ; sinon, la version minimale est décidée par un ADR à partir des résultats du labo.
   - **Un seul type de tunnel** pour la v6 : L2TP/IPsec ou SSTP, choisi par le labo (tenue derrière le CGNAT Starlink et 4G, coût CPU sur MIPS). Deux tunnels, vers les nœuds A et B, comme en v7.
3. **Support : toute version ≥ au minimum est acceptée et supportée**, sans distinction entre versions testées et non testées.

## Conséquences

### Obligation née du point 3

Promettre le support de versions non testées n'est tenable qu'avec un **rejeu systématique** :
- chaque nouvelle version **stable** ou **long-term** de RouterOS 7 repasse la matrice T (§5.6) et l'enrôlement / désinstallation (§6.2) sur CHR, **dans les jours qui suivent sa sortie** ;
- toute régression déclenche une alerte aux propriétaires concernés et un avertissement dans le tableau de bord (« ne pas passer en X.Y ») ;
- le délai cible de rejeu est à fixer dans `docs/RUNBOOK.md`.

Précédent qui justifie cette obligation : la régression RadSec signalée par des tiers après la 7.15 (§1.1).

### Architecture (RouterOS 6, phase 2b)

- **Deuxième logiciel de tunnel sur les nœuds** (par exemple strongSwan + xl2tpd, ou accel-ppp), donc sur le chemin critique. C'est un écart avec la règle 1 (« chemin critique court ») : il est assumé, et isolé. Les routeurs v6 doivent sortir dans la même plage overlay `10.213.0.0/16` (un /32 par routeur), pour que FreeRADIUS et `radius.*` ne fassent aucune différence.
- **Message-Authenticator par routeur** : `radius.client_lookup` doit pouvoir renvoyer l'exigence par routeur (positionnée dans `&FreeRADIUS-Client-Require-MA`, voir E-FR-2). Elle vaut `yes` pour tout routeur qui le supporte, et ne devient `no` qu'à titre d'exception tracée.
- **Second script d'enrôlement** (syntaxe v6), soumis aux mêmes exigences que le §6.2 (idempotent, additif, anti-lockout, activation en dernier, réversible). Il est testé sur CHR 6.49.x vierge et déjà configuré (règle 6).
- **`wg-agent`** se généralise en agent de tunnels, ou un agent séparé gère les sessions L2TP/SSTP. À trancher par un ADR en phase 2b.

### Labo

- Ajouter **un vrai routeur bas de gamme** (hAP lite ou hAP ac lite) : un CHR x86 ne prouve rien sur la mémoire, la flash ni le débit du tunnel d'un routeur MIPS. Cela vaut pour la v7 sur ces modèles comme pour la v6.
- Matrice T complète à rejouer sur 6.49.x : attributs hotspot, CoA / Disconnect, `mac-cookie`, sens de l'accounting.

### Planning

La phase 2b allonge le chemin vers G-PILOTE (enrôlement de routeurs tiers). Elle n'affecte ni la phase 1, ni le pilote sur les sites de Telecom Universel.

## Question ouverte

- **Quelle part du parc ciblé est en RouterOS 6, et sur quels modèles ?** Si beaucoup de ces routeurs peuvent passer en 7.15 ou plus, la phase 2b devient moins prioritaire. À estimer par Yacouba à partir de son parc et de celui des propriétaires pilotes.
