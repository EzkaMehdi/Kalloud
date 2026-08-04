# `DEC-07` — Définir les rôles et permissions

- Statut : validé.
- Date : 4 août 2026.
- Dépend de : [`DEC-01`](./DEC-01-perimetre-mvp.md), [`DEC-05`](./DEC-05-regles-monetaires.md).

## Rôles du MVP

- `OWNER` : propriétaire de l'établissement. Accès complet, y compris paramètres et
  gestion des utilisateurs.
- `MANAGER` : responsable de service. Accès opérationnel complet, sans les réglages
  structurants de l'établissement ni la gestion des comptes utilisateurs.
- `CASHIER` : employé de salle/caissier. Accès limité aux opérations d'encaissement, de
  caisse et de consultation de son propre service.

Chaque utilisateur a exactement un rôle par organisation (`memberships.role`), cohérent
avec le périmètre « un établissement par organisation » de `DEC-01`.

## Matrice de permissions

| Action | `OWNER` | `MANAGER` | `CASHIER` |
| --- | :---: | :---: | :---: |
| Modifier les réglages de l'établissement (fuseau, devise, seuils, classes fiscales) | ✅ | ❌ | ❌ |
| Gérer les utilisateurs et les rôles (inviter, désactiver, changer de rôle) | ✅ | ❌ | ❌ |
| Créer/modifier un produit, une catégorie, un prix | ✅ | ✅ | ❌ |
| Activer/désactiver un produit | ✅ | ✅ | ❌ |
| Gérer le plan de salle (créer/renommer/ordonner/désactiver une table) | ✅ | ✅ | ❌ |
| Ouvrir un service (journée de caisse) | ✅ | ✅ | ✅ |
| Ouvrir, reprendre, modifier un ticket | ✅ | ✅ | ✅ |
| Encaisser une vente (cash/carte/mixte) | ✅ | ✅ | ✅ |
| Annuler un ticket avant paiement | ✅ | ✅ | ✅ |
| Appliquer une remise | ✅ | ✅ | ❌ |
| Rembourser / annuler après encaissement | ✅ | ✅ | ❌ |
| Enregistrer un mouvement de caisse (entrée/sortie) | ✅ | ✅ | ✅ |
| Ajuster le stock (réception, correction, casse, retour) | ✅ | ✅ | ❌ |
| Compter et clôturer la caisse | ✅ | ✅ | ✅ |
| Consulter le cockpit (bilan, KPI, historique complet) | ✅ | ✅ | ❌ |
| Exporter des données (CSV) | ✅ | ✅ | ❌ |
| Consulter le journal d'audit | ✅ | ✅ | ❌ |

Un `CASHIER` reste capable de voir sa propre session de caisse en cours (solde, journal
du service actif) pour travailler, mais pas l'historique complet ni les KPI de gestion.

## Application technique

- La matrice est codée dans `lib/authz/permissions.ts` comme une table statique
  `Record<Permission, Role[]>`, testée unitairement (aucune permission implicite).
- Chaque route mutante vérifie le rôle **côté serveur** via un garde réutilisable
  (`requirePermission()`), après résolution du contexte de requête (`SEC-04`). Un refus
  renvoie `403` avec un message stable, jamais un masquage silencieux de bouton côté
  client uniquement.
- L'interface masque également les actions non permises (cohérence UX), mais ce n'est
  qu'un confort : la vérification serveur fait foi.

## Acceptation

- [x] Chaque rôle précise ses droits sur prix, stock, caisse, remboursement, clôture,
      utilisateurs et pilotage.
- [x] La matrice est codable directement en une table statique testable.
