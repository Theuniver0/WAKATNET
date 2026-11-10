# ADR 0002 — Frais sur les tickets vendus en espèces (décision D4)

- **Statut** : accepté par Yacouba le 10/11/2026, porte G0. Les valeurs par défaut sont révisables après le pilote.
- **Références** : `docs/SPEC.md` §3 (D3, D4), §4 (règles 1, 2 et 5), §5.2, §8.1, §8.2, §11 ; ADR 0001.

## Contexte

L'ADR 0001 ouvre la plateforme à tout propriétaire, même sans compte marchand. Sans règle, un propriétaire qui ne vend que des tickets papier utilise RADIUS, les forfaits et le suivi sans rien payer.

Le §11 de la spec interdit de prélever une commission sur des espèces **sans mesure côté serveur**. Ici, une mesure existe : un ticket est activé à son premier Accounting-Start, que le serveur enregistre (§5.2). Le montant réellement encaissé en espèces reste inconnu, mais l'activation est un fait observé par le serveur, pas une déclaration.

## Décision

1. **Frais par ticket papier activé** : `offline_fee_bps` du prix figé du forfait (la copie figée portée par le ticket, §5.3), avec un **plancher en F**. On retient la plus grande des deux valeurs.
2. **Valeurs par défaut** : `offline_fee_bps = 1000` (10 %), plancher **10 F**. C'est le même taux que la vente en ligne : « 10 % sur chaque ticket, en ligne ou papier ». Les deux valeurs sont réglables par propriétaire.
3. **Prélèvement** sur le solde de crédits prépayés du propriétaire (mêmes comptes que l'ADR 0001), à l'activation.

| Prix du forfait | Frais |
|---|---|
| 0 F (forfait déclaré gratuit) | 10 F (plancher) |
| 50 F | 10 F (plancher) |
| 100 F | 10 F |
| 300 F | 30 F |
| 1 000 F | 100 F |

Arrondi : la règle du §8.1 s'applique (au franc le plus proche, 0,5 vers le haut). Elle est à tester avec les montants du §8.1 et avec un forfait à 0 F.

## Règles de mise en œuvre (non négociables)

- **Le frais ne touche jamais au chemin d'authentification** (règles 1 et 2). Il est calculé lors du rejeu de l'accounting (lecteur `detail` → PostgreSQL), jamais dans `radius.authorize`. Un solde insuffisant ne transforme jamais un Access-Accept en refus.
- **Un ticket papier déjà généré s'active toujours**, même solde épuisé : le client a payé en espèces. Le frais passe alors en découvert.
- **Au plafond du découvert**, le propriétaire ne peut plus **générer de nouveaux lots** de tickets (et sa vente en ligne est suspendue, ADR 0001). Les tickets existants restent valides.
- **Idempotence** : un seul frais par ticket, quelle que soit la répétition des Accounting-Start (clé : identifiant du ticket ; propriété testée comme au §8.4).
- **Écritures en ajout seul** dans le grand livre, avec le taux et le plancher figés au moment de l'activation (§8.1).
- Les tickets importés depuis Mikhmon (§6.3) suivent la même règle dès leur activation sur la plateforme.

## Conséquences et risques

- **Fuite vers Mikhmon.** Un propriétaire qui vend surtout en papier peut garder ses tickets en utilisateurs locaux du routeur pour éviter le frais, si la base locale est consultée avant RADIUS (LABO-08, non tranché). C'est un indicateur à suivre pendant le pilote : part des connexions locales par rapport aux connexions RADIUS, si elle est mesurable.
- **Comparaison pour le propriétaire**, avec des frais d'agrégateur supposés à 3 % (non vérifié) : sur 100 F, il touche 87 F en ligne et 90 F en papier, avant la marge éventuelle d'un revendeur. Le papier reste un peu plus avantageux pour lui ; c'est la praticité de la vente en ligne qui doit convaincre, pas le prix.
- **Plancher.** Il ferme la faille du forfait déclaré à 0 F, mais fait payer 10 F sur tout forfait de moins de 100 F. Un propriétaire qui fait des tickets d'essai gratuits paiera 10 F par essai activé : à réexaminer s'il le signale.
- **Modèle de données.** `tenant` porte `offline_fee_bps` et le plancher (`offline_fee_min`, en `BIGINT` XOF) ; `voucher_batch` doit pouvoir être refusé au plafond.
