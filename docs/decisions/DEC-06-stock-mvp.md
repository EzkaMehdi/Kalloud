# `DEC-06` — Définir le stock du MVP

- Statut : validé.
- Date : 4 août 2026.
- Dépend de : [`DEC-01`](./DEC-01-perimetre-mvp.md).

## Décision

Le MVP suit des **produits finis**, pas des recettes/ingrédients. Une vente de « Chicha
Signature » décrémente une unité du produit « Chicha Signature », sans décomposition en
tabac/charbon/embout. Les recettes, ingrédients, unités de mesure et rendements sont du
post-MVP (`P2-STK-01`), après validation du modèle par le pilote.

## Unités

Une seule unité par défaut : **la pièce**. Pas de gestion de sous-unités (cl, g, kg) au
MVP.

## Types de mouvement de stock

| Type | Sens | Déclencheur |
| --- | --- | --- |
| `OPENING_BALANCE` | entrant | Initialisation du solde d'un produit (migration ou création) |
| `SALE` | sortant | Encaissement d'une commande (`SALE-03`) |
| `RECEIPT` | entrant | Réception de marchandise (`STK-06`) |
| `CORRECTION` | entrant ou sortant | Ajustement motivé d'un écart constaté (`STK-06`) |
| `LOSS` | sortant | Casse, péremption, perte (`STK-06`) |
| `RETURN` | entrant | Retour client ou fournisseur (`STK-06`) |

Chaque mouvement porte une quantité signée, un motif, un auteur, un produit, un
établissement et, si applicable, une référence à la commande ou à l'inventaire
d'origine (`STK-01`).

## Règle de stock négatif

**Interdit par défaut.** Toute opération qui ferait passer le solde d'un produit sous
zéro est refusée par le serveur avec un message explicite, y compris en cas de doublons
d'un même produit dans une même commande (agrégés avant contrôle, `API-01`/`STK-03`).

Seule une `CORRECTION` autorisée (rôle `MANAGER` ou `OWNER`) peut ramener un solde
erroné à une valeur cohérente, y compris négative dans le cas exceptionnel d'une
correction de rattrapage documentée — mais ce cas doit rester l'exception motivée, pas
un mode de fonctionnement normal de la vente.

## Méthode d'inventaire

Comptage physique ponctuel (`STK-07`, phase 5B) : l'utilisateur saisit la quantité
comptée pour un produit, le système calcule l'écart avec le solde théorique et génère un
mouvement `CORRECTION` référençant l'inventaire, avec auteur et horodatage.

## Solde dérivé vs matérialisé

Choix retenu : **solde matérialisé** sur `products.stock_quantity`, pour des lectures
rapides côté caisse et cockpit (pas de `SUM()` sur l'historique complet à chaque affichage
de la grille produits).

Garantie d'intégrité : le solde matérialisé est mis à jour **dans la même transaction**
que l'insertion du mouvement de stock qui le justifie (`STK-01`/`STK-03`). Un test
d'invariant (`STK-09`) vérifie en continu que :

```
products.stock_quantity == SUM(stock_movements.quantity) WHERE product_id = X
```

Si cet invariant est un jour violé (bug, intervention manuelle en base), le solde peut
être entièrement reconstruit à partir du ledger `stock_movements`, qui reste la source de
vérité en cas de divergence.

## Acceptation

- [x] Décision produit fini retenue (pas de recettes/ingrédients au MVP).
- [x] Unités, types de mouvements, règle de stock négatif et méthode d'inventaire
      définis.
- [x] Choix du solde matérialisé (avec ledger comme source de vérité) documenté.
