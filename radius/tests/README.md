# Matrice T automatisée — WAKATNET

```bash
radius/tests/run.sh
```

Ce que fait le script : il part d'une pile **neuve** (PostgreSQL 16.15, FreeRADIUS 3.2.10 avec la configuration de production, conteneur de test), applique les migrations de production, vérifie la version et `radiusd -C`, lance pytest, exige la trace du rejet T10 dans le journal, puis cherche les secrets de test dans toutes les sorties. Il sort en code non nul au premier échec.

- Arguments : transmis à pytest, par exemple `run.sh -k t02`.
- `GARDER_PILE=1 run.sh` : conserve la pile et `jeu.secrets` pour un diagnostic **local**. Les sorties de diagnostic ne sont jamais publiées.
- Exige Docker et Docker Compose. Sur Windows : depuis WSL2 (bash).

| Fichier | Contenu |
|---|---|
| `compose.yml` | Pile de test : réseaux `overlay` (10.213.0.0/16), `hors` (hors overlay), `arriere` (base). |
| `Dockerfile.testeur` | Image de test : celle de FreeRADIUS 3.2.10 (même `radclient`), plus Python, pytest, Hypothesis et psycopg. |
| `radlib.py` | Émetteur RADIUS : IP source au choix, Message-Authenticator facultatif, réponse vérifiée. |
| `conftest.py` | Données déterministes et rôle de test `wk_test` (jamais dans les migrations). |
| `surcharges/` | Liste fermée des différences entre test et production. |
| `test_*.py` | Une ligne de la matrice T, ou un garde-fou des ADR, par fichier. |
