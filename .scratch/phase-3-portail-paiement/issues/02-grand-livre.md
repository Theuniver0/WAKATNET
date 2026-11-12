# 02 — Grand livre

**Dépend de** : 01 · **Règles** : A1, A2, A3, A4, A6

## À livrer
- Schéma `ledger` : comptes, transactions, écritures, en partie double.
- Ajout seul, imposé par les droits et par un déclencheur, propriétaire des tables compris.
- `ledger.ecrire(...)` : idempotente sur sa clé, et équilibrée à la validation.
- Commission et frais : fonctions d'arrondi testées sur 100, 150, 200, 300, 500 et 1 000 F, et sur 0 F pour le plancher.

## Critères d'acceptation
- Tests de propriétés (§8.4) sur PostgreSQL réel :
  - Σ débits = Σ crédits, par transaction et en tout ;
  - le rejeu d'un journal reconstruit les mêmes soldes ;
  - la même clé ne compte jamais deux fois ;
  - une écriture déséquilibrée est refusée.
- `UPDATE` et `DELETE` refusés sur `ledger.*`, propriétaire des tables compris.
- Relecture par un second agent (règle 4).
