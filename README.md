# Kalloud

[![CI](https://github.com/EzkaMehdi/Kalloud/actions/workflows/ci.yml/badge.svg)](https://github.com/EzkaMehdi/Kalloud/actions/workflows/ci.yml)

Caisse, stock et pilotage pour un établissement de type lounge à chicha, café
ou petite restauration.

- Vision produit et audit : [`VISION_PRODUIT_ET_AUDIT.md`](./VISION_PRODUIT_ET_AUDIT.md)
- Plan d'exécution canonique (backlog, priorités, définition de terminé) : [`tasks.md`](./tasks.md)
- Décisions métier bloquantes (Phase 0) : [`docs/decisions/`](./docs/decisions/)

Ce README documente uniquement **comment installer, développer et exploiter**
le projet. Pour le "pourquoi" (portée du MVP, règles métier, rôles), consultez
les documents ci-dessus.

## Prérequis

- [Node.js](https://nodejs.org/) 20.9 ou supérieur (`node -v`)
- [pnpm](https://pnpm.io/) 10 (`corepack enable` ou `npm install -g pnpm`)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (pour PostgreSQL en local)

Aucune installation manuelle de PostgreSQL n'est nécessaire : `pnpm dev`
démarre un conteneur Docker automatiquement s'il n'en trouve pas déjà un
accessible sur `DATABASE_URL`.

## Démarrage rapide

```bash
git clone https://github.com/EzkaMehdi/Kalloud.git
cd Kalloud
cp .env.example .env
pnpm install
pnpm dev
```

Ouvrez [http://localhost:3000](http://localhost:3000). C'est tout : la
commande `pnpm dev` déclenche automatiquement (hook `predev`) :

1. `scripts/ensure-db.mjs` — démarre PostgreSQL via `docker compose` si
   `DATABASE_URL` n'est pas déjà accessible (refuse de le faire si l'URL ne
   ressemble pas à une base locale) ;
2. `scripts/migrate.mjs up` — applique les migrations manquantes ;
3. `scripts/seed.mjs` — insère un établissement de démonstration si la base
   est vide (sans effet si elle contient déjà des données).

### Comptes de développement

Le seed crée un établissement « Kalloud Démo » avec un compte par rôle,
tous avec le mot de passe `Kalloud123!` (développement uniquement — jamais
utilisé en production) :

| Rôle       | E-mail                  |
| ---------- | ------------------------ |
| `OWNER`    | `owner@kalloud.test`     |
| `MANAGER`  | `manager@kalloud.test`   |
| `CASHIER`  | `cashier@kalloud.test`   |

## Variables d'environnement

Voir [`.env.example`](./.env.example) pour la liste complète et les
commentaires associés. Les deux variables principales :

| Variable            | Rôle                                                             |
| -------------------- | ----------------------------------------------------------------- |
| `DATABASE_URL`       | Base applicative (développement ou production).                  |
| `DATABASE_URL_TEST`  | Base dédiée à `pnpm test:integration`, jamais celle du développement. |

`.env` n'est jamais suivi par Git (voir `.gitignore`) ; seul
`.env.example` sert de gabarit.

## Base de données et migrations

Le schéma est défini exclusivement par les fichiers numérotés de
[`migrations/`](./migrations), appliqués dans l'ordre par
`scripts/migrate.mjs`. Aucun autre mécanisme (script SQL ad hoc,
`docker-entrypoint-initdb.d`) ne doit modifier le schéma applicatif.

```bash
pnpm db:up               # démarre uniquement PostgreSQL (docker compose)
pnpm db:migrate          # applique les migrations en attente
pnpm db:migrate:status   # liste les migrations appliquées/en attente
pnpm db:seed             # seed idempotent (sans effet si déjà peuplé)
pnpm db:reset            # supprime tout le schéma public (dev local uniquement)
pnpm db:down             # arrête le conteneur PostgreSQL
```

Pour ajouter une évolution de schéma : créer un nouveau fichier
`migrations/000N_description.sql` (jamais modifier un fichier déjà appliqué),
puis `pnpm db:migrate`.

`pnpm db:reset` refuse de s'exécuter si `DATABASE_URL` ne pointe pas vers un
hôte local (`localhost`/`127.0.0.1`/`postgres`), sauf à définir explicitement
`ALLOW_DESTRUCTIVE_DB_RESET=true`.

## Qualité et tests

```bash
pnpm lint            # ESLint (non interactif)
pnpm format          # Prettier — corrige
pnpm format:check    # Prettier — vérifie sans modifier
pnpm typecheck        # tsc --noEmit
pnpm test             # tests unitaires + intégration (Vitest)
pnpm test:unit        # uniquement les tests unitaires
pnpm test:integration # uniquement les tests d'intégration (PostgreSQL réel)
pnpm test:e2e         # parcours navigateur (Playwright)
pnpm build            # build de production Next.js
```

- Les tests **unitaires** (`tests/unit/`) ne touchent ni au réseau ni à la
  base.
- Les tests **d'intégration** (`tests/integration/`) utilisent
  `DATABASE_URL_TEST` — une base dédiée, migrée automatiquement avant la
  suite et réinitialisable via `tests/integration/helpers/reset-database.ts`.
  Ils ne modifient jamais la base de développement.
- Les tests **navigateur** (`tests/e2e/`) démarrent leur propre serveur
  Next.js sur le port `3100` et s'appuient sur les comptes de démonstration
  du seed ; ils s'exécutent contre la base de développement (`DATABASE_URL`).
  Si l'un d'eux échoue avec une erreur de limitation de débit après
  plusieurs exécutions locales rapprochées, réinitialisez la base :
  `pnpm db:reset && pnpm db:migrate && pnpm db:seed`.

## Intégration continue

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) exécute à chaque
push sur `main` et chaque pull request : installation, lint, format,
typecheck, migrations, tests unitaires/intégration, build, tests navigateur
et audit de sécurité (`pnpm audit --audit-level=high`). Toute étape en échec
bloque le workflow ; le rapport Playwright est conservé comme artefact.

## Architecture

- **Framework** : Next.js 16 (App Router), API intégrée via des Route
  Handlers sous `app/api/**` — voir
  [`docs/decisions/DEC-02-architecture-execution.md`](./docs/decisions/DEC-02-architecture-execution.md).
- **Base de données** : PostgreSQL, accès via `pg` avec des requêtes
  paramétrées (pas d'ORM). Toute donnée métier est scopée par
  établissement (`lib/repositories/*`, voir `SEC-06` dans `tasks.md`).
- **Authentification** : sessions serveur (cookie httpOnly + jeton haché en
  base), voir `lib/auth/*`.
- **Autorisations** : matrice de rôles `OWNER`/`MANAGER`/`CASHIER` codée dans
  `lib/authz.ts`, alignée sur
  [`docs/decisions/DEC-07-roles-permissions.md`](./docs/decisions/DEC-07-roles-permissions.md).
- **Journalisation** : logs JSON structurés et corrélés par requête
  (`lib/logger.ts`).
- **Sécurité réseau** : en-têtes, vérification d'origine et limitation de
  débit dans `proxy.ts`.

```
app/
  api/           Route Handlers (contrôleurs minces)
  caisse|stock|bilan/   Pages authentifiées
  login|forgot-password|reset-password/  Pages d'authentification
components/      Composants React (UI partagée sous components/ui/)
lib/
  repositories/  Accès base scopé par établissement
  services/      Logique métier multi-tables (encaissement, clôture, KPI)
  auth/          Authentification, sessions, mots de passe
  client/        Utilitaires côté navigateur (fetch, hooks)
migrations/      Schéma versionné (SQL numéroté)
scripts/         Bootstrap local (base, migrations, seed)
tests/
  unit/          Tests purs (aucune E/S)
  integration/   Tests contre PostgreSQL réel
  e2e/           Parcours navigateur (Playwright)
docs/decisions/  Notes de décision produit (Phase 0)
```

## Dépannage

| Symptôme | Piste |
| --- | --- |
| `pnpm dev` échoue avec une erreur Docker | Vérifiez que Docker Desktop est lancé (`docker info`). |
| `DATABASE_URL is not set` | Avez-vous bien exécuté `cp .env.example .env` ? |
| Un test d'intégration échoue avec `DATABASE_URL_TEST is not set` | Idem — `.env` doit définir les deux variables. |
| Les tests E2E échouent avec « Trop de tentatives de connexion » | Le limiteur anti-force-brute (`SEC-03`) a été déclenché par des exécutions répétées ; réinitialisez la base (`pnpm db:reset && pnpm db:migrate && pnpm db:seed`). |
| Port `5433` déjà utilisé | Un autre PostgreSQL local écoute déjà ce port ; arrêtez-le ou modifiez le port dans `docker-compose.yml` et `.env`. |
| Port `3000` déjà utilisé | Un autre `next dev` tourne déjà ; arrêtez-le avant de relancer `pnpm dev` (Next.js refuse d'en démarrer un second sur le même dossier). |

## État du projet

Les phases 0 (décisions métier), 1 (fondations reproductibles) et 2
(sécurité, isolation multi-tenant, fondations UX) du plan d'exécution sont
terminées — voir [`tasks.md`](./tasks.md) pour le détail tâche par tâche et
les phases suivantes (intégrité transactionnelle, salle, configuration,
caisse/stock, cockpit, mise en production).
