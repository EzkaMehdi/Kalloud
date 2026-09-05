# Procédure de pilote (`OPS-09`)

Ce que la mise en service d'un premier client réel demande : importer ses
données, le former, savoir qui répond quand ça casse, et pouvoir revenir en
arrière.

## Responsable d'exploitation et canal d'incident

**Astreinte tournante entre Younes Fafi, Samir Elbouzidi et Mehdi Ezka.**

Une rotation n'existe que si le tour de garde est écrit. Sans calendrier
nominatif, « nous trois » veut dire personne : chacun suppose qu'un autre a
vu passer l'alerte. À fixer avant la mise en service, dans le groupe
ci-dessous, avec un nom par semaine :

| Semaine | De garde |
| --- | --- |
| _à compléter avant le lancement_ | |

Le responsable de la semaine :

- déclenche et **vérifie** les sauvegardes ([sauvegarde et
  restauration](./sauvegarde-restauration.md)) — l'alerte `backup_overdue`
  d'`OPS-02` le fait pour lui, encore faut-il que quelqu'un la lise ;
- traite les demandes de suppression et d'export
  ([conservation et suppression](./conservation-suppression.md)) ;
- est le point de contact en cas d'incident de données (`DEC-10`).

**Canal d'incident : un groupe WhatsApp dédié**, avec le gérant de
l'établissement et les trois d'entre nous.

C'est le bon choix pour ce pilote : un gérant en plein service ne va pas
ouvrir un outil de tickets, et WhatsApp est déjà sur son téléphone. Mais il
ne laisse **aucune trace exploitable** — un fil de conversation n'est pas un
historique d'incidents. Donc, à chaque incident, le responsable de garde
reporte dans un fichier partagé, le jour même : date, ce qui s'est passé, ce
qui a été fait, et si le client a perdu quelque chose. Sans cette
transcription, la revue de fin de pilote se fera de mémoire.

## Monter la base du pilote

Une base pilote se construit **par l'application, jamais par le seed**.

```bash
pnpm db:migrate          # le schéma, rien d'autre
# surtout PAS pnpm db:seed — il crée l'établissement de démonstration
```

Puis le client crée son propre établissement par le formulaire d'inscription
(`SAAS-01`), depuis `/signup`. C'est le parcours que `OPS-06` vérifie sur une
base neuve à chaque exécution de la suite.

### Vérifier la séparation démo / pilote

```bash
node --env-file=.env scripts/check-pilote.mjs
```

Refuse la base si elle contient les comptes ou l'établissement de
démonstration, ou des restes de tests (`Test table …`, `%@example.test`), et
affiche ce qu'elle contient réellement. `FND-14` et la porte de configuration
d'`OPS-05` sont **préventifs** — ils empêchent de créer la démo. Celui-ci
regarde la donnée, ce qui est la seule chose qui répond à « est-ce que c'est
là *maintenant* ? » : une base restaurée depuis le dump d'un développeur
passe les deux garde-fous et reste pleine de « Kalloud Lounge ».

À relancer **après chaque restauration**.

## Importer le catalogue et le plan de salle

Saisir quatre-vingts produits un par un n'est pas une mise en service, c'est
une soirée perdue.

```bash
IMPORT_PASSWORD='…' node scripts/import-pilote.mjs \
  --email patron@exemple.fr \
  --produits catalogue.csv \
  --tables salle.csv \
  --simulation
```

`--simulation` valide tout et affiche ligne par ligne ce qui serait créé,
**sans rien écrire**. Relancer sans le drapeau applique.

Colonnes attendues :

- **produits** : `nom`, `prix`, puis facultativement `categorie`, `unite`,
  `stock`, `seuil` ;
- **tables** : `nom`.

Ce que le lecteur accepte sans qu'on ait à préparer le fichier : le
séparateur `;` d'un tableur français **comme** la virgule ; les prix écrits
`2,50` ou `2.50` ; les noms contenant une virgule ou des guillemets ; les
retours à la ligne dans une cellule ; le marqueur d'octets d'Excel ; les
en-têtes avec majuscules, accents ou espaces. Le séparateur est **détecté sur
la ligne d'en-tête**, la seule qui ne peut pas contenir de décimale — les
accepter tous les deux à la fois transformait `2,50` en deux colonnes et
aurait tarifé le produit à 2 €.

Tout passe par l'**API, connecté comme le propriétaire** — jamais par SQL.
Les règles qui rendent un catalogue correct vivent dans les services derrière
ces endpoints : la chaîne de repli de TVA (`DEC-05`), le mouvement d'entrée
qui maintient `products.stock_quantity` égal à la somme de ses mouvements
(`DEC-06`), le journal d'audit, les permissions. Un import qui écrirait en
base devrait les réimplémenter, et s'en écarterait au premier changement.

L'import est **idempotent par nom** : relancé après correction de trois
lignes, il ne crée pas un second « Terrasse 1 ». Les lignes invalides sont
signalées avec leur numéro dans le fichier et n'interrompent pas les autres.

## Former le client

Une demi-journée sur site, dans l'ordre des écrans :

1. **Ouvrir le service** avec le fond de caisse — rien ne se vend avant.
2. **Prendre une commande** sur une table, l'encaisser, en annuler une.
3. **Le stock** : lire les alertes, réceptionner une livraison, faire un
   comptage.
4. **Clôturer** : compter le tiroir, comprendre l'écart et pourquoi un motif
   est demandé au-delà du seuil.
5. **Le bilan** : la journée, le mois, les exports.
6. **L'équipe** : ajouter un employé, choisir son rôle, le désactiver quand
   il part.

Les trois rôles n'ont pas les mêmes écrans (`DEC-07`) : montrer la caisse à
l'équipe, les réglages au seul propriétaire.

## Retour arrière

Trois niveaux, du moins au plus lourd :

| Situation | Geste |
| --- | --- |
| Une version casse quelque chose | Redéployer l'image précédente ([déploiement](./deploiement.md)) |
| Des données sont perdues ou corrompues | Restaurer la sauvegarde de la veille ([sauvegarde](./sauvegarde-restauration.md)), puis relancer `check-pilote.mjs` |
| Le client arrête le pilote | Export complet puis anonymisation ([conservation](./conservation-suppression.md)) — la purge reste refusée tant que les six ans comptables courent |

**Prendre une sauvegarde avant chaque déploiement portant une migration.**
C'est la seule chose qui rend le deuxième niveau possible : les migrations
sont en avant seulement.

## Collecte de feedback

Le canal WhatsApp sert aussi à ça, mais mélanger « la caisse ne s'ouvre
pas » et « ce serait bien d'avoir un bouton ici » fait perdre les deux. À
séparer :

- **incident** → WhatsApp, tout de suite, transcrit le jour même ;
- **suggestion** → notée à la fin de chaque semaine de garde, dans le même
  fichier partagé, sans engagement de délai.

Un point hebdomadaire de quinze minutes entre nous trois suffit à relire les
deux listes. Ce qui compte pour la revue de fin de pilote, ce n'est pas le
nombre de suggestions, c'est ce que le client a réellement fait ou n'a pas pu
faire pendant son service.
