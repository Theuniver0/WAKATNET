# 04 — Accounting découplé : detail → lecteur → radius.acct_* idempotents

**PRD** : `../PRD.md` · **Matrice** : T7, T2 (activation au Start) · **Dépend de** : 03

## À livrer
- FreeRADIUS : la section accounting écrit **seulement** dans un fichier `detail` et répond tout de suite (règle 2, C3). Déjà prouvé en L6 ; à reproduire avec la configuration de production.
- Lecteur `detail` : serveur virtuel de rejeu FreeRADIUS, ou petit service. Il appelle `radius.acct_start / acct_interim / acct_stop` avec le rôle `wk_acct`. Choix dans l'ADR 0006, ou dans une note d'ADR ajoutée ici.
- `radius.acct_*` :
  - idempotentes, avec pour clé le routeur et `Acct-Session-Id` ;
  - compteurs mis à jour **par différence** avec la dernière valeur reçue (octets + gigawords, `Acct-Session-Time`) ;
  - activation du ticket au premier Start, horodatée avec l'instant de la base.
- Sens des octets : **paramétrable par configuration** (§1.1, LABO). Valeur par défaut documentée comme non vérifiée.

## Critères d'acceptation
- T7 : un Stop reçu deux fois laisse les compteurs inchangés au second.
- T2 (fin) : `activated_at` est posé au premier Start et à lui seul. Un Start rejoué ne le change pas.
- Interim reçus dans le désordre ou rejoués : aucun double comptage. Test de propriété sur une séquence aléatoire.
- Base arrêtée : l'accounting est quand même répondu, et rejoué au retour de la base sans perte ni doublon.

## Piste B
Sens réel entrée / sortie des octets, observé sur CHR (LABO, accounting).
