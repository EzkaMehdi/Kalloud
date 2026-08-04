# `DEC-04` — Définir la journée de caisse

- Statut : validé.
- Date : 4 août 2026.
- Dépend de : [`DEC-01`](./DEC-01-perimetre-mvp.md).

## Décision

Une « journée de caisse » (`business_day`) est une **session de caisse**, pas un jour
calendaire strict. Elle commence à une ouverture explicite et se termine à une clôture
explicite, réalisées par un utilisateur autorisé (`DEC-07`). Une session peut dépasser
minuit sans se clôturer automatiquement.

- Fuseau horaire métier : celui configuré par établissement (`location_settings.timezone`,
  `CFG-00`), par défaut `Europe/Paris`. Tous les horodatages sont stockés en `timestamptz`
  (UTC) et convertis à l'affichage avec ce fuseau.
- Une seule journée peut être `OPEN` à la fois par établissement (contrainte unique en
  base, déjà présente dans `002-business-days.sql` et reconduite dans `FND-05`).
- Agrégation « journée » : toujours par `business_day_id`, jamais par date calendaire. Le
  bilan « Aujourd'hui » (`BI-03`) affiche donc la session de caisse active, quelle que soit
  l'heure qu'il est.

## Comptage : aveugle ou non

Choix retenu : **comptage non aveugle**. Le montant d'espèces attendu est visible avant la
saisie du montant compté.

Justification : à ce stade du pilote, la priorité est la détection immédiate d'une erreur
de caisse et la rapidité de clôture pour un petit établissement, plutôt qu'un contrôle
anti-fraude renforcé qui suppose une équipe plus grande. Un mode de comptage aveugle
(le caissier saisit d'abord son comptage, le système ne révèle l'écart qu'ensuite) reste
une amélioration post-MVP si le pilote démontre un besoin de contrôle interne renforcé.

Ordre d'affichage retenu dans l'écran de clôture (`CASH-05`) :

1. Fond de caisse d'ouverture ;
2. Ventes espèces, entrées, sorties (détail du calcul) ;
3. **Espèces attendues** (calculées, affichées) ;
4. **Espèces comptées** (saisie utilisateur) ;
5. Écart (`comptées − attendues`), avec justification obligatoire au-delà du seuil
   configuré (`CFG-00`).

## Ouverture, clôture, réouverture

- **Ouverture** : action explicite « Ouvrir le service », distincte de la clôture
  (`CASH-02`). Un fond de caisse initial est saisi à l'ouverture.
- **Clôture** : action explicite « Compter et clôturer la caisse ». Elle exige la saisie
  des espèces comptées et calcule l'écart. Une fois clôturée, une journée est
  **définitive** : elle ne peut pas être rouverte. Toute correction ultérieure passe par
  un mouvement de caisse motivé sur la journée courante, jamais par une modification
  rétroactive d'une journée clôturée.
- **Réouverture** : non supportée au MVP. Après clôture, une nouvelle journée peut être
  ouverte immédiatement (proposé par l'interface) mais reste un choix explicite de
  l'utilisateur, jamais automatique (contrairement à l'ancien bouton « Nouvelle journée »
  qui combinait les deux actions sans confirmation distincte).

## Traitement des tickets ouverts à la clôture

La clôture d'une journée est **bloquée** tant qu'il existe des commandes `OPEN`
rattachées à l'établissement. L'écran de clôture affiche la liste des tickets bloquants
et propose d'y accéder directement (implémenté en `CASH-06`, phase 5A). Aucune clôture ne
peut annuler ou encaisser silencieusement un ticket ouvert à la place de l'utilisateur.

## Acceptation

- [x] Il s'agit d'une session de caisse, pas d'un jour calendaire strict ; fuseau horaire
      et passage de minuit définis.
- [x] Comptage non aveugle retenu, avec justification et ordre d'affichage
      compté/attendu explicite.
- [x] Ouverture, clôture, absence de réouverture et traitement des tickets ouverts sont
      définis.
