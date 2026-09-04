# Déploiement de production (`OPS-05`)

Environnement, secrets, HTTPS, migrations, rollback et sondes de santé.
Le déploiement tient en une commande, la même sur toute machine — c'est ce que
« reproductible » doit vouloir dire.

## L'image

`Dockerfile`, trois étapes. Ce qui part en production ne contient ni la chaîne
de compilation ni les `devDependencies` : surface d'attaque réduite, et un
contenu déterminé par le fichier de verrouillage plutôt que par ce qui se
trouvait installé sur la machine de construction. Le serveur est la sortie
`standalone` de Next (`next.config.ts`), donc l'image ne contient même pas
`pnpm`. Elle tourne en utilisateur non privilégié (~293 Mo).

Les migrations **et leur exécuteur voyagent dans l'image** : le schéma qu'une
version attend fait partie de cette version. C'est la même raison qui fait que
la sonde de disponibilité compare les deux.

Node et pnpm sont épinglés. `corepack enable` sans épinglage récupérait la
dernière version publiée : cette image est montée sur pnpm 11 alors que la CI
épinglait 10, et a échoué sur un fichier de verrouillage que le projet
considère parfaitement valide. Une construction dont le résultat dépend du jour
où on la lance est l'inverse de ce que ce ticket livre. La version vit
désormais dans `packageManager` (`package.json`), que corepack honore partout.

## La pile

```bash
cp .env.production.example .env.production   # puis remplir les secrets
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

Trois services :

- **postgres** — volume nommé, `pg_isready` comme sonde, **non publié sur
  l'hôte** : l'application l'atteint par le réseau interne, et rien d'autre ne
  doit l'atteindre du tout.
- **migrate** — service à usage unique, exécuté avant l'application. Séparé de
  l'entrée de l'application pour deux raisons : plusieurs répliques se
  disputeraient sinon la même base, et une migration en échec doit **arrêter le
  déploiement** plutôt que laisser un conteneur boucler sur des redémarrages
  alors que la version précédente est déjà partie.
- **app** — démarre par `scripts/check-env.mjs` puis sert. Publié sur
  `127.0.0.1` uniquement : le reverse proxy est devant.

## HTTPS

TLS se termine **au reverse proxy**, pas ici (`DEC-02`). Mettre des certificats
dans cette pile dupliquerait la responsabilité à deux endroits, ce qui est la
manière dont l'un des deux finit expiré.

L'application fait sa part, à condition que le proxy transmette
`X-Forwarded-Proto: https` :

- cookies `Secure` en production (`lib/auth/cookies.ts`) ;
- `Strict-Transport-Security` (2 ans, sous-domaines inclus) émis dès que la
  requête est reconnue comme HTTPS (`proxy.ts`) ;
- CSP, `X-Frame-Options: DENY`, `nosniff` sur toutes les réponses.

## Secrets — « aucune variable de développement »

`scripts/check-env.mjs` refuse de démarrer sur une configuration de
développement. Il tourne dans la commande de l'application, et devrait tourner
aussi dans la chaîne de livraison.

Il refuse, entre autres : `NODE_ENV` autre que `production` ; une base sur la
boucle locale ; le mot de passe `kalloud_dev_password` de `docker-compose.yml` ;
un `OPS_METRICS_TOKEN` absent, d'exemple ou de moins de 32 caractères ; les
trois échappatoires locales (`ALLOW_DEMO_SEED`,
`ALLOW_DESTRUCTIVE_DB_RESET`, `ALLOW_RESTORE_OVER_APPLICATION_DB`) ; et
`AUTH_RATE_LIMIT_MAX=1000`, le plafond de la suite de tests — en production ce
n'est pas une limite de débit, c'est une porte ouverte avec un panneau dessus.

Il **avertit** sans bloquer quand `DATABASE_URL` ne force pas TLS : sur un
réseau privé déjà chiffré c'est un choix légitime, ailleurs c'est un oubli.

Chaque problème est rapporté d'un coup : un opérateur veut la liste complète,
pas un élément par redémarrage.

## Sondes de santé

| Sonde | Répond | À utiliser pour |
| --- | --- | --- |
| `/api/health/live` | le processus répond | *liveness* — redémarrer un processus bloqué |
| `/api/health/ready` | base joignable **et schéma conforme à cette image** | *readiness* — router du trafic |

La distinction n'est pas cosmétique : une panne de base ne doit pas faire tuer
et redémarrer en boucle un serveur applicatif parfaitement sain.

## Rollback

Les migrations sont **en avant seulement** (`migrate.mjs up`, pas de `down`).
Revenir à l'image précédente laisse donc la version antérieure face à un schéma
plus récent. La plupart du temps cela *semble* fonctionner — l'ancien code
ignore les nouvelles colonnes — jusqu'à la requête qui touche une colonne
renommée, en plein service, avec la queue au comptoir.

C'est pourquoi la sonde de disponibilité compare le schéma de la base aux
migrations présentes dans l'image, et distingue les deux cas :

| Situation | Message | Ce que ça veut dire |
| --- | --- | --- |
| Migrations **manquantes** | « Migrations non appliquées » | l'image est en avance : le déploiement n'est pas terminé |
| Migrations **inconnues** | « La base est en avance sur cette version » | la base est en avance : quelqu'un a fait un rollback |

Dans les deux cas, `/api/health/ready` répond `503`, Docker marque le conteneur
`unhealthy` et l'orchestrateur cesse de lui envoyer du trafic — pendant que
`/api/health/live` reste vert, donc le processus n'est pas tué en boucle.

### Procédure

1. **Rollback applicatif seul** (le cas courant : le schéma n'a pas changé) —
   redéployer l'image précédente. `ready` repasse au vert immédiatement.
2. **Rollback après une migration incompatible** — l'application refusera de se
   déclarer prête, et c'est voulu. Il faut alors restaurer la base à son état
   d'avant migration :
   ```bash
   pnpm db:restore -- --backup <sauvegarde d'avant déploiement> --into <base de secours>
   ```
   puis basculer l'application sur la base restaurée. Voir
   [sauvegarde et restauration](./sauvegarde-restauration.md) — RTO cible de
   `DEC-10` : 4 h ouvrées.
3. Prendre une sauvegarde **avant chaque déploiement** portant une migration.
   C'est la seule chose qui rend le point 2 possible.

## Ce qui a été vérifié ici, et ce qui ne peut pas l'être

Vérifié en conditions réelles sur cette machine : construction de l'image,
démarrage de la pile complète, migrations appliquées (19), `live` et `ready`
verts, page de connexion servie, en-têtes de sécurité présents, HSTS émis
derrière un `X-Forwarded-Proto: https`, refus de démarrage sur configuration de
développement, et **les deux directions du désaccord de schéma** — base en
avance et image en avance — jusqu'au conteneur marqué `unhealthy` par Docker,
puis retour au vert.

Ne peut pas l'être sans hébergeur : un vrai certificat TLS, un vrai nom de
domaine, le reverse proxy, le stockage de sauvegardes hors machine et son
chiffrement au repos (`DEC-10`), et le rollback de bout en bout sur une
plateforme réelle. La mécanique qui rend ce rollback sûr est testée ; le
déploiement lui-même attend une plateforme.
