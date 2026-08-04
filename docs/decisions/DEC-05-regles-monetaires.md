# `DEC-05` — Définir les règles monétaires

- Statut : validé.
- Date : 4 août 2026.
- Dépend de : [`DEC-01`](./DEC-01-perimetre-mvp.md).

## Devise

EUR pour le pilote. Le champ `location_settings.currency` (`CFG-00`) rend le choix
configurable par établissement dans le modèle de données, sans qu'une interface
multi-devise soit livrée au MVP.

## TVA et TTC/HT

- Les prix produits sont saisis et affichés **TTC** (prix payé par le client), cohérent
  avec un commerce grand public (lounge, café, snacking).
- Chaque produit ou catégorie peut être rattaché à une **classe fiscale**
  (`tax_classes`, `CFG-00`) qui porte un taux (ex. 10 % restauration sur place, 20 %
  taux standard).
- **Règle de repli** : si un produit n'a pas de classe fiscale assignée, celle de sa
  catégorie s'applique ; si la catégorie n'en a pas non plus, la classe fiscale par
  défaut de l'établissement (`location_settings.default_tax_rate`) s'applique. Ce repli
  est résolu côté serveur, jamais côté client.
- La part de TVA d'une ligne est calculée par extraction :
  `taxe = prix_ttc − (prix_ttc / (1 + taux))`, arrondie au centime (voir arrondis
  ci-dessous). Le justificatif (`ORD-09`) affiche le sous-total HT, la TVA et le total
  TTC par taux applicable.

## Arrondis

- Tous les montants sont stockés en unités monétaires décimales à 2 décimales
  (`DECIMAL(10,2)`), jamais en flottant binaire.
- Arrondi *half up* (arrondi commercial standard) au centime, appliqué :
  - au prix unitaire × quantité de chaque ligne ;
  - au montant de TVA extrait de chaque ligne.
- Le total de la commande est la **somme des lignes déjà arrondies**, jamais un
  recalcul global qui diverge du détail affiché au client.
- Cas limite illustré : un produit à 4,995 € (prix mal saisi) est refusé à la saisie
  (`API-01` impose 2 décimales exactes) ; un total de 3 articles à 3,33 € TTC donne
  9,99 € (3 × 3,33), pas 10,00 €, afin que la somme des lignes affichées corresponde
  toujours exactement au total encaissé.

## Paiements autorisés

`CASH`, `CARD`, `MIXED`. Le paiement mixte est retenu pour le MVP : c'est un cas réel
observé (un client règle une partie en espèces, une partie en carte) et l'interface
actuelle l'expose déjà sans le supporter correctement (anomalie `P0-02`).

Règle serveur non négociable : **`somme des paiements (cash + card) = total TTC` de la
commande**, vérifiée avant toute validation, en centimes entiers (pas de tolérance
d'arrondi). Pour `CASH`, `cardAmount = 0` et `cashAmount = total` ; pour `CARD`,
`cashAmount = 0` et `cardAmount = total` ; pour `MIXED`, les deux montants sont saisis
explicitement par l'utilisateur et leur somme doit égaler le total. C'est la correction
directe de l'anomalie `P0-02`, mise en œuvre en phase 3 (`SALE-03`).

## Remise

- Une remise est encadrée : montant fixe ou pourcentage, motif obligatoire, réservée aux
  rôles `MANAGER` et `OWNER` (`DEC-07`).
- Elle est appliquée avant le calcul de la taxe (recalcul TTC/HT/TVA après remise) afin que
  le justificatif reste cohérent avec les montants réellement encaissés.
- Elle est incluse dans le total de la commande, le justificatif et l'audit (`ORD-11`,
  phase 4A, `P1`).

## Remboursement

- Total ou partiel, toujours associé à un motif et à une commande `PAID` existante.
- Crée une ligne de paiement `REFUND` liée à la commande d'origine ; ne supprime ni ne
  modifie jamais les lignes de paiement `CHARGE` d'origine.
- Réservé aux rôles `MANAGER` et `OWNER`.
- Impacte le calcul des espèces attendues (`CASH-04`) et le chiffre d'affaires net
  (`DEC-09`) de façon explicite et testée.

## Acceptation

- [x] Devise, TVA, TTC/HT, arrondis, paiements autorisés, paiement mixte, remise et
      remboursement sont définis.
- [x] Taux par classe fiscale et règle de repli définis.
- [x] Formules et cas limites illustrés.
- [x] `somme des paiements = total` est une règle serveur obligatoire.
