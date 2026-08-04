# `DEC-09` — Définir les KPI et exports du MVP

- Statut : validé.
- Date : 4 août 2026.
- Dépend de : [`DEC-04`](./DEC-04-journee-caisse.md), [`DEC-05`](./DEC-05-regles-monetaires.md), [`DEC-06`](./DEC-06-stock-mvp.md).

## Dictionnaire des KPI

Toutes les formules utilisent le fuseau horaire de l'établissement
(`location_settings.timezone`) et s'appuient exclusivement sur des données persistées
(aucune valeur calculée uniquement côté client ne fait foi).

| KPI | Formule | Source | Période |
| --- | --- | --- | --- |
| **CA net** | `SUM(commandes PAID.total) − SUM(remboursements)` | `orders`, `payments` | Service en cours / jour / mois / année / plage |
| **Nombre de commandes** | `COUNT(commandes PAID non annulées)` | `orders` | idem |
| **Panier moyen** | `CA net / nombre de commandes` | dérivé | idem |
| **Espèces attendues** | `fond initial + ventes espèces nettes + entrées − sorties` (les ventes nettes intègrent les remboursements espèces) | `business_days`, `cash_movements`, `payments` | Service en cours |
| **Écart de caisse** | `espèces comptées − espèces attendues` | `business_days` | À la clôture |
| **Alerte de rupture** | `stock_quantity = 0` sur un produit actif | `products` | Instantané |
| **Alerte de seuil** | `0 < stock_quantity <= alert_threshold` | `products` | Instantané |

Chaque KPI exposé par l'API porte explicitement sa source, sa période, son fuseau horaire
et sa fraîcheur (`BI-01`, phase 6) : un cockpit n'affiche jamais un nombre sans pouvoir
répondre à « d'où vient-il, sur quelle période, à quelle heure a-t-il été calculé ? ».

## Comparaisons

Comparaison retenue : **période précédente comparable**, pas simplement « la veille ».
Pour un service quotidien, un lundi se compare à la moyenne des lundis récents (ou au
lundi précédent à défaut d'historique suffisant), afin de lisser l'effet du jour de la
semaine. Pour une période mensuelle/annuelle, la comparaison se fait sur la période
équivalente précédente (mois précédent, année précédente).

## Fuseau horaire

Toutes les périodes (« Aujourd'hui », « Ce mois », « Cette année », plage libre) sont
calculées dans le fuseau horaire de l'établissement, jamais en UTC brut ni dans le fuseau
du navigateur client. « Aujourd'hui » dans le cockpit correspond à la session de caisse
active au sens de `DEC-04`, pas au jour calendaire strict.

## Format d'export CSV

- Encodage **UTF-8 avec BOM** (compatibilité Excel FR/Windows par défaut).
- Séparateur `;` (convention tableur francophone).
- Montants exportés en valeurs numériques brutes à point décimal (`12.50`), pas en texte
  formaté avec virgule ni symbole monétaire, pour rester ré-important-able sans ambiguïté
  par un tableur ou un outil comptable.
- Dates au format ISO 8601 avec décalage explicite (`2026-08-04T19:30:00+02:00`).
- Une ligne d'en-tête nommée en français, un fichier par type d'export (ventes,
  paiements, caisse, stock), livré en phase 6 (`BI-12`).

## Acceptation

- [x] CA net, commandes, panier moyen, espèces attendues, écart de caisse et alertes de
      stock sont définis avec source et formule.
- [x] Règle de comparaison (période précédente comparable) et fuseau horaire actés.
- [x] Format CSV validé (encodage, séparateur, montants, dates).
