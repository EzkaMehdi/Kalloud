# `DEC-02` — Choisir l'architecture d'exécution

- Statut : validé.
- Date : 4 août 2026.
- Dépend de : [`DEC-01`](./DEC-01-perimetre-mvp.md).

## Décision

L'API est **intégrée à Next.js** sous forme de Route Handlers (`app/api/**/route.ts`),
au lieu de conserver le serveur Express autonome (`server/index.js`). Le serveur Express
est supprimé.

Justification :

- un seul déploiement, un seul runtime Node, un seul jeu de variables d'environnement ;
- appels **same-origin** entre le client et l'API : plus d'URL `http://localhost:3001`
  codée en dur, plus de configuration CORS multi-origine à maintenir ;
- partage direct des types TypeScript entre couche serveur et client ;
- Next.js 16 est la version *Active LTS* au moment de la décision (GA le 21 octobre 2025,
  16.2.x en maintenance courante mi-2026) : c'est la cible retenue pour `FND-02`.

## Stack retenue

| Composant | Choix |
| --- | --- |
| Framework | Next.js 16 (App Router, Route Handlers, Turbopack par défaut) |
| Langage | TypeScript 5.9 |
| Base de données | PostgreSQL 16, accès via `pg` (requêtes paramétrées, pas d'ORM) |
| Migrations | Système maison basé sur des fichiers SQL numérotés (`FND-05`) |
| Auth | Sessions serveur (cookies signés httpOnly) stockées en base, pas de fournisseur tiers pour le MVP |
| Validation | `zod` pour les schémas d'entrée/sortie |
| Tests | Vitest (unitaire + intégration Postgres réel), Playwright (parcours navigateur) |
| Lint / format | ESLint (config plate) + Prettier |
| CI | GitHub Actions |

## Cibles d'environnement

### Local

- `docker-compose.yml` démarre uniquement PostgreSQL.
- `pnpm dev` déclenche un script `predev` qui s'assure que Postgres tourne et que les
  migrations sont appliquées, puis lance `next dev`.
- Une seule commande après `pnpm install` : `pnpm dev` (voir `FND-10`).

### CI

- GitHub Actions démarre un service Postgres éphémère, applique les migrations de test,
  puis exécute lint, format check, typecheck, tests et build (`FND-11`).

### Production

- Un seul artefact de déploiement Next.js (runtime Node, pas Edge, car l'accès `pg` et
  les sessions nécessitent le runtime Node complet).
- Postgres managé externe (URL fournie via `DATABASE_URL`).
- Les migrations sont exécutées comme étape explicite de déploiement, **avant** le
  démarrage du nouveau processus applicatif (`OPS-05`, phase 7).
- HTTPS de bout en bout, secrets exclusivement via variables d'environnement de la
  plateforme d'hébergement (jamais commités).

## Stratégie d'URL, secrets et migrations

- **URL** : le client web appelle exclusivement des chemins relatifs (`/api/...`). Aucune
  variable d'URL d'API publique n'est nécessaire pour le MVP. Si un client mobile natif
  ou un accès cross-origin devient nécessaire post-MVP, une variable
  `NEXT_PUBLIC_API_BASE_URL` sera introduite avec une allowlist CORS explicite
  (`SEC-07`).
- **Secrets** : `DATABASE_URL`, secret de session, éventuels secrets tiers vivent dans
  `.env` en local (non suivi par Git, `FND-01`) et dans les variables d'environnement de
  la plateforme en production/CI. `.env.example` documente les clés attendues sans valeur
  réelle.
- **Migrations** : un seul système canonique (`FND-05`) remplace la séparation fragile
  entre `database/schema.sql`, `database/002-business-days.sql` et les scripts
  concurrents. Toute évolution du schéma passe par un nouveau fichier de migration
  numéroté, jamais par une modification manuelle de la base.

## Acceptation

- [x] Décision actée entre Route Handlers Next.js et API Express autonome : Next.js retenu.
- [x] Cibles locale, CI et production documentées.
- [x] Stratégie d'URL, secrets et migrations définie.
