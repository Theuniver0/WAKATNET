# 04 — Accounting découplé : detail → lecteur → radius.acct_*

**PRD** : `../PRD.md` · **Matrice** : T7, T2 (activation) · **Dépend de** : 03

## À livrer
- Section accounting : **seulement** le module `detail` (`locking = yes`). Réponse immédiate (règle 2, C3).
- Lecteur `detail` conforme à l'ADR 0006, point 12 : serveur virtuel, instance `sql` séparée, rôle `wk_acct`, quarantaine des enregistrements en erreur.
- `acct_*` conformes aux points 7 et 8 :
  - instant de réception, époque du routeur ;
  - compteurs en max cumulé, avec gigawords ;
  - activation au premier Start, à l'instant de réception.
- Sens des octets réglé dans une table de paramètres SQL (C2). Valeur par défaut documentée comme non vérifiée.
- `acct_*` ne lèvent jamais d'exception à cause d'une donnée.
- Accroche pour la phase 3 : un événement d'activation idempotent, que le frais papier lira (ADR 0002). `wk_acct` n'a aucun droit sur `ledger`.

## Critères d'acceptation
- **T7** : un Stop reçu deux fois laisse les compteurs inchangés au second.
- **Activation** : `activated_at` est posé au premier Start, à l'**instant de réception**. Base arrêtée pendant 20 min avec un Start en attente : `activated_at` vaut l'instant de réception, pas celui du rejeu.
- **Test de propriété** : Interim rejoués et dans le désordre ; le total final égale la plus grande valeur cumulée, sans double ni sous-comptage. Un cas franchit 4 Gio, un cas n'a pas de gigawords.
- **Enregistrement empoisonné** au milieu du fichier : mis en quarantaine, les suivants passent.
- **Base arrêtée**, puis **base qui ne répond plus** (`docker compose pause`) : Accounting-Response toujours envoyée, rejeu complet au retour, sans perte ni doublon.
- **L9** (lecteur `detail`) rejoué sur 3.2.10.

## Piste B
Sens réel des octets, observé sur CHR. **LABO-18** : `Acct-Session-Id` après un redémarrage du routeur.
