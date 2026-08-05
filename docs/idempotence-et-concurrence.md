# Idempotence et contrôle de concurrence (`API-02`)

Note technique, pas une décision produit : elle décrit la mise en œuvre de la règle
fixée par [`DEC-08`](./decisions/DEC-08-offline-multi-appareil.md) — « le serveur
garantit qu'une même clé ne produit jamais deux encaissements ».

## Le problème

Il n'y a pas d'encaissement hors ligne au MVP. Quand la requête de paiement part mais
que la réponse n'arrive pas, le client **ne sait pas** si la vente a été enregistrée.
Ses deux options naïves sont mauvaises : abandonner risque de ne pas encaisser une
vente déjà servie ; renvoyer la requête risque de débiter deux fois. Même problème,
en plus courant, pour un double-clic sur « Encaisser ».

## L'en-tête `Idempotency-Key`

Obligatoire sur les opérations financières :

| Endpoint | En-tête requis |
| --- | --- |
| `POST /api/checkout` | `Idempotency-Key` |
| `POST /api/cash-movements` | `Idempotency-Key` |

Format : 16 à 200 caractères parmi `A-Z a-z 0-9 . _ : -` (un UUID v4 convient). Absent
ou mal formé ⇒ `400 VALIDATION_ERROR`.

**La règle côté client** : une clé par *opération voulue*, pas par requête HTTP. Elle est
générée quand l'utilisateur commence à saisir l'opération, **conservée à l'identique sur
chaque réessai**, et renouvelée seulement après un succès. Une clé régénérée à chaque
tentative annule toute la garantie. Voir `components/order-drawer.tsx` et
`components/cash-movement-modal.tsx`.

## Comportement serveur

| Situation | Réponse |
| --- | --- |
| Première requête avec cette clé | L'opération s'exécute ; `201` |
| Rejeu après succès, même payload | Réponse enregistrée rejouée à l'identique, `201` + `Idempotent-Replay: true` |
| Rejeu pendant que la première est en cours | `409 CONFLICT` — « déjà en cours de traitement » |
| Même clé, payload différent | `409 CONFLICT` — « déjà utilisée avec une requête différente » |
| L'opération a échoué (stock, journée fermée…) | La clé est libérée ; une requête corrigée avec la même clé passe |

Le payload est identifié par un SHA-256 de sa forme JSON **canonique** (clés triées
récursivement, ordre des tableaux conservé) : deux sérialisations du même contenu
donnent le même hash, donc un rejeu légitime n'est jamais pris pour une requête
différente.

## Le point d'implémentation qui compte

La réservation de la clé est **committée hors de la transaction métier**
(`lib/idempotency.ts`). Si l'`INSERT` qui réserve la clé vivait dans la même transaction
que la vente, un `ROLLBACK` l'effacerait — et deux requêtes concurrentes portant la même
clé passeraient toutes les deux. La séquence est donc :

1. `INSERT ... ON CONFLICT DO NOTHING` sur `idempotency_keys` (committé) — c'est l'index
   unique `(location_id, endpoint, idempotency_key)` qui départage atomiquement les
   concurrents, sans course lecture-puis-écriture ;
2. exécution de l'opération métier, dans sa propre transaction ;
3. enregistrement de la réponse et passage en `COMPLETED`, ou suppression de la
   réservation si l'opération a échoué.

Portée par établissement (`SEC-06`) : deux tenants peuvent employer la même valeur de clé
sans collision, et aucun ne peut observer la réponse stockée de l'autre.

TTL : 24 h, l'échelle d'un service ([`DEC-04`](./decisions/DEC-04-journee-caisse.md)).
Les lignes expirées sont purgées de façon opportuniste à chaque réservation — l'index sur
`expires_at` rend l'opération négligeable — plutôt que par une tâche planifiée que le MVP
devrait déployer et surveiller.

## Ordre de verrouillage

`performCheckout` fusionne les lignes d'un même produit puis les verrouille **triées par
identifiant de produit** (`mergeItemsByProduct`, `lib/services/checkout.ts`).

- **Fusion** : la vérification de stock s'exécute une fois sur la quantité totale. Sans
  elle, un ticket portant deux fois le même produit passait deux contrôles de 3 unités
  contre un stock de 5, puis décrémentait à −1.
- **Tri** : deux ventes simultanées portant sur les produits `{7, 12}` et `{12, 7}`
  prenaient leurs verrous `FOR UPDATE` en sens inverse et pouvaient se bloquer
  mutuellement. PostgreSQL tranche en tuant une transaction avec une erreur de deadlock
  sur laquelle le caissier n'a aucune prise.

La propriété de tri est vérifiée directement dans `tests/unit/checkout-items.test.ts` :
un test d'intégration ne peut pas la prouver, puisque provoquer un deadlock à la demande
suppose de suspendre une transaction entre ses deux verrous.

## Hors périmètre

- **L'expérience « état incertain » côté interface** (afficher qu'un paiement est en
  suspens, proposer une reprise) appartient à `SALE-08`. Ce document couvre la garantie
  serveur et le câblage minimal du client.
- **Le verrou optimiste sur un ticket ouvert modifié depuis deux appareils** appartient à
  `ORD-05`, avec sa propre colonne de version — c'est un autre problème que l'idempotence
  d'une opération unique.
