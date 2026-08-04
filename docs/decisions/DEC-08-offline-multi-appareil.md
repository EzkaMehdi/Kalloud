# `DEC-08` — Décider le niveau de fonctionnement hors ligne et multi-appareil

- Statut : validé.
- Date : 4 août 2026.
- Dépend de : [`DEC-01`](./DEC-01-perimetre-mvp.md).

## Décision

**Pas d'encaissement hors ligne pour le MVP.** Un établissement pilote doit disposer
d'une connexion réseau fonctionnelle pour encaisser. Le mode hors ligne complet
(`P2-OFF-01`) est reporté post-MVP : il exige une stratégie de résolution de conflits et
un modèle de synchronisation qui dépassent le périmètre d'un pilote initial.

## Comportement attendu lors d'une perte réseau

| Moment | Comportement |
| --- | --- |
| **Avant** l'encaissement | Le bouton d'encaissement reste utilisable, mais toute tentative échoue avec un message explicite (« Connexion perdue, réessayez ») ; aucune vente locale simulée n'est comptabilisée. L'état réseau est visible dans l'interface (`UX-01`). |
| **Pendant** l'encaissement (requête envoyée, réponse non reçue) | Le client ne sait pas si le serveur a traité la demande. Il ne doit **jamais** renvoyer automatiquement une requête différente : le retry réutilise la **même clé d'idempotence** (`API-02`, phase 3). Le serveur garantit qu'une même clé ne produit jamais deux encaissements. |
| **Après** un encaissement server-side réussi mais dont la réponse a été perdue | Un retry avec la même clé d'idempotence renvoie le résultat déjà enregistré (même commande, mêmes montants) au lieu de dupliquer la vente ou d'échouer silencieusement. |

Cette règle est implémentée concrètement en phase 3 (`SALE-08`) ; elle est actée ici pour
que l'architecture (identifiants de requête, table d'idempotence) soit prévue dès les
fondations (`FND-07`, `OPS-01`).

## Multi-appareil

- Plusieurs appareils (tablette en salle, poste de caisse fixe, mobile du manager)
  peuvent être connectés simultanément sur le même établissement : ce n'est **pas** une
  session unique verrouillée.
- Après toute mutation réussie sur un appareil (vente, mouvement de caisse, changement de
  stock), les autres appareils doivent pouvoir se resynchroniser à leur prochaine
  interaction ou rafraîchissement — jamais rester bloqués sur une valeur locale
  obsolète sans le signaler (`SALE-06`, `CASH-07`, `STK-08`).
- Les conflits d'édition concurrente sur un même ticket (deux appareils modifient la même
  commande ouverte) sont gérés par un contrôle de version optimiste plutôt que par un
  verrou global bloquant : la deuxième écriture concurrente est rejetée avec un message
  explicite invitant à recharger l'état courant (`ORD-05`, phase 4A).
- Aucune donnée locale n'écrase silencieusement une donnée serveur plus récente.

## Acceptation

- [x] Décision explicite : pas d'encaissement hors ligne pour le MVP.
- [x] Comportement attendu lors d'une perte réseau avant, pendant et après un
      encaissement est défini.
- [x] Nombre d'appareils simultanés : illimité côté produit, avec resynchronisation et
      gestion de conflit explicites plutôt qu'un verrou unique.
