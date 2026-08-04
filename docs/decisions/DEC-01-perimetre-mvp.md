# `DEC-01` — Figer le périmètre du MVP

- Statut : validé.
- Date : 4 août 2026.
- Dépend de : aucune.

## Décision

Kalloud MVP cible les lounges à chicha, cafés et petits établissements de restauration
(brunch, snacking) opérant **un établissement (`location`) par organisation**. Le modèle
de données reste compatible avec plusieurs établissements par organisation pour ne pas
bloquer le post-MVP (`P2-SAAS-01`), mais aucune interface de consolidation multi-site
n'est livrée au pilote.

Trois rôles composent le MVP : `OWNER`, `MANAGER`, `CASHIER` (matrice détaillée dans
[`DEC-07`](./DEC-07-roles-permissions.md)).

## Cible commerciale et critère de succès du pilote

- Cible commerciale : 1 à 3 établissements pilotes indépendants (lounge à chicha ou café)
  utilisant Kalloud pour la totalité d'un service réel, avec de l'argent réel.
- Indicateur directeur de succès (repris de `VISION_PRODUIT_ET_AUDIT.md`, section 3) :
  **pourcentage de journées clôturées sans écart de caisse inexpliqué et avec toutes les
  ventes, paiements et sorties de stock réconciliés.**
- Le pilote est considéré concluant si au moins 90 % des journées de service sont
  clôturées le jour même avec un écart de caisse expliqué ou nul.

## Parcours obligatoires du MVP

1. créer son compte et son établissement (onboarding, phase 7) ;
2. inviter des utilisateurs avec les rôles `OWNER`, `MANAGER`, `CASHIER` ;
3. configurer ses tables et son catalogue ;
4. ouvrir un service (journée de caisse) ;
5. ouvrir, reprendre, modifier et annuler un ticket ;
6. encaisser en espèces, carte ou paiement mixte sans incohérence ;
7. décrémenter et expliquer le stock par des mouvements traçables ;
8. enregistrer les mouvements de caisse ;
9. compter, rapprocher et clôturer la caisse ;
10. consulter un cockpit fondé uniquement sur des données réelles ;
11. utiliser le produit sur mobile, tablette et desktop avec des erreurs explicites ;
12. garantir qu'aucun client ne peut lire ou modifier les données d'un autre.

## Inclus / exclus

### Inclus au MVP

| Domaine | Fonction |
| --- | --- |
| Identité | Authentification, organisation/établissement unique, rôles `OWNER`/`MANAGER`/`CASHIER`, isolation multi-tenant |
| Salle | Plan de table, ticket persistant (ouverture, reprise, modification, annulation), vente directe unique |
| Encaissement | Catalogue réel scopé, paiement espèces/carte/mixte, calcul serveur, idempotence |
| Stock | Produits finis, mouvements signés et motivés, solde reconstructible, alertes de rupture |
| Caisse | Ouverture/clôture de service, mouvements d'entrée/sortie, comptage et écart |
| Pilotage | Cockpit avec CA net, commandes, panier moyen, alertes, rapprochement caisse, stock à risque, export CSV |
| Exploitation | Migrations, CI, sauvegarde/restauration, logs structurés, audit métier |

### Explicitement hors périmètre MVP (post-MVP, section 15 de `tasks.md`)

- recettes, ingrédients et rendements (`P2-STK-01`) ;
- fournisseurs, commandes d'achat et réceptions (`P2-STK-02`) ;
- coûts, valorisation, marge et pertes (`P2-STK-03`) ;
- prévision avancée des ruptures et jours de couverture (`P2-STK-04`) ;
- objectifs configurables (`P2-BI-01`) ;
- marge et coût matière au cockpit (`P2-BI-02`) ;
- consolidation multi-établissements (`P2-SAAS-01`) ;
- abonnement, essai et facturation SaaS (`P2-SAAS-02`) ;
- mode hors ligne (`P2-OFF-01`, voir aussi [`DEC-08`](./DEC-08-offline-multi-appareil.md)) ;
- intégrations comptables (`P2-INT-01`) ;
- planning du personnel (`P2-OPS-01`) ;
- benchmark anonymisé (`P2-DATA-01`).

## Acceptation

- [x] Chaque fonction listée ci-dessus est marquée MVP ou post-MVP.
- [x] Cible commerciale et critère de succès du pilote sont explicites.
- [x] Le périmètre « un établissement par organisation » est acté tout en gardant un
      modèle de données prêt pour plusieurs établissements.
