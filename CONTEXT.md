# Glossaire WAKATNET

Termes du domaine, sans détail d'implémentation. Les décisions sont dans `docs/adr/`, la spécification dans `docs/SPEC.md`.

| Terme | Définition |
|---|---|
| **Plateforme** | WAKATNET, exploitée par Telecom Universel. |
| **Propriétaire** (tenant) | Exploitant de WiFi Zone, client de la plateforme. Il possède un ou plusieurs sites. |
| **Site** | Lieu d'une WiFi Zone ; il porte un ou plusieurs routeurs. |
| **Routeur** | MikroTik du propriétaire, raccordé par un tunnel à la plateforme et identifié par son adresse dans ce tunnel. |
| **Point de vente** | Lieu ou personne qui remet des tickets papier pour un propriétaire. |
| **Gérant / vendeur** | Sous-compte d'un propriétaire, rattaché à un point de vente. |
| **Client final** | Personne qui achète un forfait. Elle n'a pas de compte ; elle n'est identifiée que par le numéro du payeur. |
| **Forfait** (plan) | Offre définie par un propriétaire : prix, durée, validité, volume, débit, nombre d'appareils, portée. |
| **Ticket** (voucher) | Code qui donne accès à un forfait. Il porte une **copie figée** du forfait au moment de sa création. |
| **Lot de tickets** | Tickets générés ensemble pour la vente en espèces. |
| **Activation** | Première utilisation d'un ticket : premier début de session enregistré par le serveur. |
| **Temps consommé** | Temps de connexion déjà utilisé ; il ne court pas quand le client est déconnecté. |
| **Validité** | Fenêtre continue qui commence à l'activation. |
| **Expiration absolue** | Date au-delà de laquelle un ticket ne vaut plus rien, activé ou non. |
| **Session** | Période de connexion d'un appareil, de son début à sa fin. |
| **Session fantôme** | Session restée ouverte sans nouvelle du routeur (coupure de courant, par exemple), fermée d'office. |
| **Nœud** | Serveur de la plateforme (A, puis B) qui authentifie les routeurs. |
| **Mode A** | Chaque propriétaire encaisse sur son propre compte marchand (ADR 0001). |
| **Mode B** | Collecte centralisée par la plateforme. Verrouillé. |
| **Mode C** | Partage automatique de chaque paiement par le prestataire de paiement. Cible pour les propriétaires tiers. |
| **Crédits** | Solde prépayé d'un propriétaire, sur lequel la plateforme prélève sa commission et les frais sur tickets papier. |
| **Découvert** | Solde de crédits négatif autorisé jusqu'à un plafond (3 000 F au départ). |
| **Frais papier** | Prélèvement à l'activation d'un ticket vendu en espèces : le plus grand de 10 % du prix et 10 F (ADR 0002). |
| **Commission** | Part de la plateforme sur chaque vente (10 % par défaut). |
| **Porte** | Point d'arrêt obligatoire entre deux phases (G0, G-ARGENT, G-PILOTE). |
