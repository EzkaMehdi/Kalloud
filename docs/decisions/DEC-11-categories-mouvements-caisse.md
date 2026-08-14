# `DEC-11` — Catégoriser les mouvements de caisse

- Statut : validé.
- Date : 15 août 2026.
- Dépend de : [`DEC-04`](./DEC-04-journee-caisse.md), [`DEC-05`](./DEC-05-regles-monetaires.md).

## Contexte

`CASH-03` demande qu'un mouvement de caisse porte une **catégorie**, et que « un retrait
de fin de service soit une catégorie de sortie ». Jusqu'ici un mouvement n'avait qu'un
sens (`IN`/`OUT`) et un motif en texte libre : deux sorties de 200 € étaient
indiscernables, qu'il s'agisse d'un achat de consommables ou du retrait du tiroir en fin
de service. Deux tâches en dépendent directement, et aucune ne peut se contenter d'un
texte libre :

- `CASH-04` doit calculer les espèces attendues « sans double comptage des retraits ».
  Cela suppose de reconnaître un retrait de fin de service par autre chose qu'une
  correspondance sur le motif saisi à la main.
- `CASH-07` doit filtrer le journal de la journée.

## Décision

Un mouvement porte un `type` (le **sens**, qui décide du signe) et une `category` (la
**nature**, qui décide de la lecture métier). Les deux sont contraints ensemble : une
catégorie n'est valable que pour son sens, et la base l'impose (`CHECK`), pas seulement
l'application.

| `type` | `category` | Sens métier |
| --- | --- | --- |
| `OPENING` | `OPENING_FLOAT` | Fond de caisse d'ouverture (`CASH-02`) |
| `IN` | `FUND_TOPUP` | Apport de monnaie en cours de service |
| `IN` | `OTHER` | Toute autre entrée, justifiée par le motif |
| `OUT` | `END_OF_SERVICE_WITHDRAWAL` | Retrait du tiroir en fin de service |
| `OUT` | `PURCHASE` | Achat ou dépense réglée en espèces |
| `OUT` | `BANK_DEPOSIT` | Dépôt en banque |
| `OUT` | `OTHER` | Toute autre sortie, justifiée par le motif |

`OTHER` est volontairement conservé dans les deux sens : une liste fermée qui ne prévoit
pas l'imprévu pousse à ranger un mouvement dans une catégorie fausse, ce qui est pire
qu'une catégorie explicitement générique. Le motif reste obligatoire dans tous les cas —
la catégorie le complète, elle ne le remplace pas.

`OPENING_FLOAT` n'est pas saisissable par l'API : `CASH_MOVEMENT_TYPES` exclut déjà
`OPENING` des types acceptés en entrée, et seul le service d'ouverture (`CASH-02`) crée
cette ligne. Un client ne peut donc pas fabriquer un fond de caisse.

## Ce que la catégorie ne fait pas

Elle ne porte **aucun signe**. Le montant reste toujours positif (`CHECK amount >= 0`,
déjà en place) et c'est le `type` qui décide de l'addition ou de la soustraction. Une
catégorie mal choisie fausse une lecture, jamais un solde.

Elle ne rend pas non plus un mouvement modifiable : un mouvement reste **immuable**
(`CASH-03`). Il n'existe aucun endpoint de modification ou de suppression, et une erreur
de catégorie se corrige comme une erreur de montant — par un mouvement inverse motivé,
jamais par une réécriture (même principe que la journée clôturée en `DEC-04`).

## Acceptation

- [x] Chaque mouvement porte une catégorie, contrainte en base par rapport à son sens.
- [x] Le retrait de fin de service est une catégorie de sortie identifiable, sur laquelle
      `CASH-04` peut s'appuyer sans deviner.
- [x] Le motif libre reste obligatoire et n'est remplacé par aucune catégorie.
