# Décisions métier — Kalloud

Ce dossier contient les notes de décision `DEC-*` requises par la phase 0 de
[`tasks.md`](../../tasks.md). Chaque fichier documente une décision produit bloquante,
sa justification et ses critères d'acceptation.

| ID | Titre | Dépend de |
| --- | --- | --- |
| [`DEC-01`](./DEC-01-perimetre-mvp.md) | Figer le périmètre du MVP | — |
| [`DEC-02`](./DEC-02-architecture-execution.md) | Choisir l'architecture d'exécution | `DEC-01` |
| [`DEC-03`](./DEC-03-cycle-vie-commande.md) | Définir le cycle de vie d'une commande | `DEC-01` |
| [`DEC-04`](./DEC-04-journee-caisse.md) | Définir la journée de caisse | `DEC-01` |
| [`DEC-05`](./DEC-05-regles-monetaires.md) | Définir les règles monétaires | `DEC-01` |
| [`DEC-06`](./DEC-06-stock-mvp.md) | Définir le stock du MVP | `DEC-01` |
| [`DEC-07`](./DEC-07-roles-permissions.md) | Définir les rôles et permissions | `DEC-01`, `DEC-05` |
| [`DEC-08`](./DEC-08-offline-multi-appareil.md) | Niveau hors ligne et multi-appareil | `DEC-01` |
| [`DEC-09`](./DEC-09-kpi-exports.md) | KPI et exports du MVP | `DEC-04`, `DEC-05`, `DEC-06` |
| [`DEC-10`](./DEC-10-conservation-sauvegarde.md) | Conservation, sauvegarde, suppression | `DEC-01` |
| [`DEC-11`](./DEC-11-categories-mouvements-caisse.md) | Catégoriser les mouvements de caisse | `DEC-04`, `DEC-05` |

Ces décisions sont la source de vérité pour l'implémentation des phases 1 à 7. Toute
évolution doit être proposée comme une modification de ces fichiers, pas comme un
changement silencieux dans le code.
