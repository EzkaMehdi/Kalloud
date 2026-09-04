# Sauvegarde et restauration (`OPS-03`)

Met en œuvre la politique de [`DEC-10`](./decisions/DEC-10-conservation-sauvegarde.md) :
sauvegarde quotidienne, rétention 30 jours + hebdomadaires 3 mois, **RPO 24 h**,
**RTO 4 h ouvrées**, restauration testée sur un environnement isolé.

## Prendre une sauvegarde

```bash
pnpm db:backup
```

Produit deux fichiers dans `backups/` (ignoré par git — un dump contient toute
la base, empreintes de mots de passe et journal d'audit compris) :

- `kalloud-<horodatage UTC>.dump` — format `pg_dump` custom (`-Fc`), compressé,
  `--no-owner --no-acl` pour qu'il se restaure sur un serveur où les rôles de
  production n'existent pas. Une sauvegarde qui ne se restaure que sur sa
  propre machine n'est pas une sauvegarde.
- `kalloud-<horodatage UTC>.json` — le manifeste : instant de prise, base,
  **version de schéma**, taille, empreinte SHA-256, durée.

La version de schéma est enregistrée avec le dump parce que restaurer une
sauvegarde antérieure à une migration dans une application qui attend le
schéma plus récent est un échec qu'il vaut mieux prévoir que découvrir à 3 h
du matin.

`pg_dump` est cherché sur le `PATH`, puis dans le service Docker `postgres`.
Le repli conteneur est **refusé** si `DATABASE_URL` ne pointe pas vers une base
locale : sinon, sauvegarder une base managée passerait par le conteneur local
et rendrait un dump de la mauvaise base.

## Automatiser (quotidien, hors heures de service)

`DEC-10` demande une sauvegarde quotidienne déclenchée hors service. Exemple
d'entrée `crontab` sur l'hôte applicatif :

```
0 4 * * *  cd /srv/kalloud && /usr/bin/node --env-file=.env scripts/backup.mjs >> /var/log/kalloud-backup.log 2>&1
```

La rétention est appliquée par le script lui-même, **après** l'écriture de la
nouvelle sauvegarde, pour qu'un échec de dump ne supprime jamais rien.

## Vérifier que ça tourne vraiment

C'est la partie que l'on oublie, et la seule qui compte : une planification que
personne ne vérifie se découvre cassée le jour où l'on en a besoin — le seul
jour où elle ne peut plus être réparée.

`GET /api/health/metrics` (`OPS-02`) lit l'instant de prise dans les manifestes
et lève une alerte **critique** :

| Alerte | Condition | Destinataire |
| --- | --- | --- |
| `backup_missing` | aucune sauvegarde restaurable trouvée | astreinte |
| `backup_overdue` | la plus récente dépasse 26 h | astreinte |

Les deux sont distinctes à dessein : une planification qui n'a jamais tourné
n'est pas le même problème qu'une planification qui s'est arrêtée, et la
personne réveillée à 3 h ne devrait pas avoir à le deviner. Le seuil est à 26 h
et non 24 h pour qu'un travail nocturne décalé de quelques minutes ne réveille
personne chaque nuit.

L'âge est lu dans le manifeste, jamais dans la date du fichier : un dump peut
être copié ou synchronisé longtemps après sa prise, et un RPO calculé sur
« quand ce fichier a bougé » annoncerait une sauvegarde fraîche sur une
planification arrêtée depuis des semaines.

## Restaurer

```bash
pnpm db:restore -- --list                          # ce qui est disponible
pnpm db:restore -- --into kalloud_restore_drill     # la plus récente, base isolée
pnpm db:restore -- --backup <nom> --into <base>     # une sauvegarde précise
```

Déroulé : vérification de l'empreinte SHA-256 → `DROP`/`CREATE` de la base
cible → `pg_restore --single-transaction` → relecture (version de schéma,
nombre d'organisations, commandes, paiements, événements d'audit) → durée.

Trois refus, dans le script et pas seulement dans cette page :

1. **Jamais par-dessus la base applicative.** `DEC-10` l'écrit (« jamais
   directement en production ») ; la faute que cela empêche est un drapeau
   oublié à 3 h du matin. Contournable en conscience par
   `ALLOW_RESTORE_OVER_APPLICATION_DB=true`.
2. **Empreinte vérifiée avant toute destruction.** Un dump corrompu découvert
   *après* avoir vidé la cible ne laisse plus rien du tout.
3. **`--single-transaction`.** La restauration arrive entière ou laisse une
   base vide. Une base à moitié restaurée qui répond aux requêtes est le
   résultat le plus facile à confondre avec une base saine.

## Les cibles, et ce que ce script en couvre

- **RPO 24 h** — tenu par la planification quotidienne, et *vérifié* par
  l'alerte ci-dessus.
- **RTO 4 h ouvrées** — pour l'environnement **complet**. Ce script n'en couvre
  que l'étape base de données, qu'il chronomètre et affiche ; le reste
  (application, secrets, DNS, certificats) relève d'`OPS-05`. La distinction
  est faite explicitement dans la sortie du script pour que personne ne lise
  « 0,4 s » comme un RTO tenu.

## L'exercice, automatisé

`tests/integration/backup-restore.test.ts` fait le tour complet à chaque
exécution de la suite : écriture de données distinctives, `pg_dump` réel,
restauration dans une base créée pour l'occasion, puis relecture des données —
organisations, empreintes de mots de passe intactes, événement d'audit,
contraintes de clés étrangères, table des migrations. Les deux refus (base
applicative, empreinte incorrecte) sont vérifiés en cassant volontairement le
script : sans eux, deux tests tombent.

Une sauvegarde que personne n'a restaurée est une hypothèse, pas une
sauvegarde.

## Ce qui reste à `OPS-05`

Chiffrement au repos et stockage hors machine (`DEC-10` : « chiffrées au repos
et accessibles uniquement à l'équipe d'exploitation »). En local, les dumps sont
en clair sur le disque et ignorés par git. Le transfert vers un stockage
chiffré, sa politique d'accès et la restriction d'accès à la base de production
relèvent du déploiement, pas de ce script.
