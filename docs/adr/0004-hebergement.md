# ADR 0004 — Hébergement des nœuds (décision D6)

- **Statut** : accepté par Yacouba le 10/11/2026, porte G0.
- **Références** : `docs/SPEC.md` §0 (exigence 1), §3 (D6, D7), §4, §6.1, §10.2, §12 (G-PILOTE) ; `docs/LABO.md` (E-FR-1) ; ADR 0003.

## Contexte

- La spec demande 2 VPS Debian stable chez **2 hébergeurs différents**, avec IP fixes et un nom de domaine (D6). FreeRADIUS, PostgreSQL et WireGuard y tournent en natif sous systemd (D7).
- Yacouba a déjà un compte **Hetzner**. À ma connaissance, Hetzner n'a de datacenters qu'en Europe, aux États-Unis et à Singapour, pas en Afrique : **à revérifier**.
- Aucune mesure de latence n'existe depuis des routeurs au Burkina (fibre, 4G, Starlink) vers les datacenters candidats.
- Phase 0 (E-FR-1) : FreeRADIUS **≥ 3.2.10** requis, **3.2.9 interdite** (lecteur `detail`). La version livrée par Debian 13 n'a pas été vérifiée.

## Décisions

1. **Nœud A chez Hetzner**, dans un datacenter européen. Le choix entre Falkenstein, Nuremberg et Helsinki se fait sur mesure (point 4).
2. **Nœud B chez Hetzner aussi, mais seulement pour le lancement et le pilote sur les sites de Telecom Universel**, dans un **autre datacenter** que A.
3. **Avant G-PILOTE** (avant tout routeur d'un tiers), le nœud B est **migré chez un autre hébergeur**, avec un autre réseau, une autre facturation et un autre compte. C'est une **condition bloquante de G-PILOTE**, ajoutée aux preuves de la phase 5 :
   - B tourne chez l'autre hébergeur ;
   - le test T13 est rejoué avec ce B ;
   - la procédure de promotion de B est rejouée (`docs/RUNBOOK.md`).
4. **Mesure avant achat.** Avant de choisir les datacenters (A, B Hetzner, puis B définitif), on mesure pendant 48 h la latence et la perte depuis 2 ou 3 routeurs réels au Burkina (fibre, 4G, Starlink) vers chaque candidat. Le protocole est à rédiger dans `docs/LABO.md`. Les résultats servent aussi à régler le `timeout` de `/radius` (§6.2).
5. **FreeRADIUS** : **paquets officiels de l'éditeur de FreeRADIUS** (dépôt APT pour Debian), version épinglée (≥ 3.2.10, jamais 3.2.9) ; compilation depuis le tag officiel en repli.
   - Le dépôt exact (nom de l'éditeur, URL, clé de signature) est **à vérifier** : l'éditeur a peut-être changé de nom.
   - Le choix est confirmé par un ADR après un essai sur une VM Debian 13 : version installée, signature du dépôt vérifiée, présence de `rlm_sql_postgresql`, rejeu de `infra/lab/freeradius/run-lab.sh` adapté.

## Conséquences et risques

- **Risque accepté pendant le pilote** : un point de défaillance commun à A et B (compte Hetzner, facturation, incident propre à Hetzner). Il ne met en jeu que les ventes de Telecom Universel. Il **ne doit jamais** s'étendre aux propriétaires tiers (point 3).
- **Hygiène du compte Hetzner**, puisqu'il porte tout pendant le pilote : double authentification activée, moyen de paiement de secours, contact de facturation à jour. À noter dans `docs/RUNBOOK.md`.
- **Données personnelles hors du Burkina** (MAC, numéro du payeur, sessions) : obligations éventuelles auprès de la CIL pour un hébergement en Europe, **[À CONFIRMER]** dans `docs/CONFORMITE.md` (registre des traitements, transferts). Ce n'est pas un avis juridique.
- **Latence** : si les mesures montrent qu'un datacenter d'Afrique de l'Ouest est nettement meilleur, le B définitif (point 3) y va de préférence.
- **IP fixes** : les Primary IP de Hetzner Cloud servent de points de terminaison WireGuard (§6.1 : pas de DNS dynamique sur le chemin critique). Migrer B change son IP ; les routeurs déjà enrôlés reçoivent le nouveau pair par le script d'entretien (§6.2, étape 3), sans réenrôlement.

## Questions ouvertes

- Quel second hébergeur pour le B définitif ? Le choix se fera après les mesures de latence et avant G-PILOTE.
- Le nom de domaine de la plateforme (portail, API, enrôlement) : propriété de Telecom Universel, registrar, DNS chez un tiers indépendant de Hetzner.
