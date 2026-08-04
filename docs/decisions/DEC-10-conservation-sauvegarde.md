# `DEC-10` — Définir conservation, sauvegarde et suppression

- Statut : validé.
- Date : 4 août 2026.
- Dépend de : [`DEC-01`](./DEC-01-perimetre-mvp.md).

## Conservation

- Les données transactionnelles (commandes, lignes, paiements, mouvements de caisse,
  mouvements de stock, journal d'audit) sont conservées **au minimum 6 ans**, en ligne
  avec les obligations comptables usuelles françaises, sauf demande de suppression de
  compte traitée selon la section « Suppression » ci-dessous.
- Les données de compte (utilisateurs, memberships) sont conservées tant que le compte
  est actif, puis traitées selon la politique de suppression.
- Aucune donnée de démonstration ou de test ne partage l'environnement ou la base des
  données pilote réelles (`FND-14`).

## Sauvegarde

- Sauvegarde automatique **quotidienne** de la base PostgreSQL (dump ou snapshot managé
  selon l'hébergeur retenu), déclenchée en dehors des heures de service si possible.
- Rétention : 30 jours glissants de sauvegardes quotidiennes, puis une sauvegarde
  hebdomadaire conservée 3 mois.
- Les sauvegardes sont chiffrées au repos et accessibles uniquement à l'équipe
  d'exploitation.
- La procédure de sauvegarde et sa vérification opérationnelle sont mises en œuvre en
  phase 7 (`OPS-03`).

## Restauration — RPO / RTO cibles

- **RPO (perte de données maximale tolérée)** : 24 heures pour le pilote (fréquence de
  sauvegarde quotidienne). Une amélioration vers un RPO horaire est envisageable
  post-pilote si le volume ou la criticité le justifient.
- **RTO (temps de restauration maximal toléré)** : 4 heures ouvrées pour restaurer un
  environnement pilote fonctionnel à partir d'une sauvegarde.
- La restauration doit être testée sur un environnement isolé (jamais directement en
  production) avant toute mise en service (`OPS-03`, acceptation).

## Suppression de compte

- Sur demande explicite du client, les données personnelles des utilisateurs
  (nom, e-mail, identifiants de connexion) sont anonymisées sous **30 jours**.
- Les données agrégées nécessaires à une obligation légale (comptabilité) sont
  conservées sous forme anonymisée jusqu'à l'expiration du délai de conservation légal.
- En l'absence d'obligation légale applicable, une purge complète peut être réalisée sur
  confirmation explicite du client.
- Le comportement précis (export préalable, délais, réversibilité) est implémenté et
  testé en phase 7 (`OPS-04`), sans casser les obligations comptables retenues
  ci-dessus.

## Exigences minimales de confidentialité

- Les mots de passe ne sont jamais stockés en clair (hachage `bcrypt`, `SEC-03`).
- Les journaux applicatifs (`OPS-01`) ne contiennent jamais de mot de passe, de jeton de
  session en clair ni de numéro de moyen de paiement.
- L'accès aux sauvegardes et à la base de production est restreint à l'équipe
  d'exploitation désignée ; toute action sensible (export massif, restauration) est
  tracée dans le journal d'audit (`SEC-09`).

## Responsabilités opérationnelles

- Un responsable d'exploitation est désigné avant le pilote (`OPS-09`, phase 7) pour :
  déclencher/vérifier les sauvegardes, réaliser les demandes de suppression, et être le
  point de contact en cas d'incident de données.

## Acceptation

- [x] Durées de conservation, politique de sauvegarde, restauration, suppression de
      compte, RPO et RTO cibles sont écrits.
- [x] Exigences minimales de confidentialité et responsabilités opérationnelles sont
      écrites.
