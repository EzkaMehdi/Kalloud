---
name: run-app
description: Launch and visually verify the Kalloud app (Next.js + Postgres via Docker) in local dev — use when asked to run, start, preview, or screenshot the app, or to confirm a change works in the real UI.
---

# Lancer Kalloud en local

Procédure validée pour démarrer l'app et vérifier visuellement l'interface.
Suivre les étapes dans l'ordre, en s'adaptant à la machine sur laquelle on
tourne (ne pas supposer Windows/PowerShell) — détecter avant d'agir.

## 1. Docker doit tourner

`predev` (voir `package.json`) exécute des scripts qui ont besoin de
Postgres, donc du daemon Docker.

```bash
docker info >/dev/null 2>&1 && echo up || echo down
```

Si `down`, démarrer Docker selon la plateforme détectée, puis attendre que
`docker info` réussisse (poll, ne pas sleep en boucle bloquante) :

- **macOS** : `open -a Docker` (Docker Desktop)
- **Linux** : `systemctl start docker` (ou `sudo systemctl start docker`
  selon les droits), ou lancer le daemon `dockerd` si pas de systemd
- **Windows** : trouver l'exécutable réellement présent avant de le lancer,
  ex. `Get-Command "Docker Desktop.exe" -ErrorAction SilentlyContinue`, sinon
  chercher dans `C:\Program Files\Docker\Docker\` — ne pas supposer le
  chemin, vérifier qu'il existe d'abord.

Si Docker n'est pas installé du tout, le signaler à l'utilisateur plutôt que
de tenter une installation.

## 2. pnpm, jamais npm ni yarn

Le gestionnaire de paquets du projet est **pnpm** (voir `pnpm-lock.yaml`,
qui fait foi) — ne jamais lancer `npm install` ni `yarn` dessus : ça crée un
`package-lock.json`/`node_modules` incompatibles avec le lockfile pnpm.

Vérifier la présence de pnpm :

```bash
pnpm --version
```

S'il est absent, essayer `corepack enable` en premier. Si `corepack` lui
aussi est absent (retiré du core par défaut depuis Node 25+), le contourner
**sans installation globale** :

```bash
npx --yes corepack@latest pnpm --version
```

Si une install globale de `corepack` est tentée (`npm install -g corepack`)
et échoue sur un conflit de shim `yarnpkg` préexistant (`EEXIST`), ne pas
utiliser `--force` sans autorisation explicite — ça écraserait une
installation `yarn` globale de la machine sans rapport avec ce projet. Le
détour `npx corepack@latest pnpm ...` évite complètement ce problème.

## 3. Démarrer Postgres

```bash
npx corepack@latest pnpm run db:up   # docker compose up -d postgres
```

## 4. Dépendances

Si `node_modules/` est absent (erreurs `Cannot find package 'pg'` etc. au
`predev`) :

```bash
npx corepack@latest pnpm install
```

**Piège connu** : si `pnpm install` (ou tout `pnpm run <script>`) échoue
avec `[ERR_PNPM_IGNORED_BUILDS]` (ex. `unrs-resolver`, dépendance interne
d'ESLint, pas du runtime), pnpm modifie automatiquement
`pnpm-workspace.yaml` en y ajoutant un placeholder `allowBuilds` — et tant
que ce n'est pas remplacé par une vraie valeur (`true` ou `false`), **tout**
`pnpm run` (y compris `pnpm dev`) échoue avec exit code 1. Demander à
l'utilisateur s'il faut approuver (`true`, exécute le script natif) ou
refuser explicitement (`false`, suffit à débloquer sans exécuter de code
tiers) — ne pas se contenter d'annuler la modification, ça ne fait que
reporter le blocage. C'est un fichier versionné : ne pas committer sans
demander.

## 5. Lancer le serveur de dev

```bash
npx corepack@latest pnpm dev
```

`predev` s'exécute automatiquement avant `next dev` : vérifie que la DB est
joignable, applique les migrations (`scripts/migrate.mjs up`), puis seed les
données de démo (`scripts/seed.mjs`). Lancer en arrière-plan et attendre la
ligne `✓ Ready in ...` dans les logs avant de continuer, plutôt que de
supposer un délai fixe.

L'app est alors servie sur **http://localhost:3000** (ou un autre port si
3000 est déjà pris — lire le log pour l'URL réelle).

## 6. Comptes de démo (créés par le seed)

Mot de passe unique : `Kalloud123!`

| Rôle    | Email                  |
|---------|-------------------------|
| OWNER   | owner@kalloud.test     |
| MANAGER | manager@kalloud.test   |
| CASHIER | cashier@kalloud.test   |

`http://localhost:3000` redirige vers `/login?next=/caisse` tant qu'on n'est
pas authentifié.

## 7. Vérifier visuellement (screenshot headless)

Playwright est en devDependency (`@playwright/test`). **Sous pnpm (résolution
stricte, pas de hoisting à plat comme npm)**, `playwright-core` n'est pas
accessible directement depuis `node_modules/` malgré sa présence dans le
store — importer plutôt `chromium` depuis `@playwright/test`, qui
l'exporte :

```js
import { chromium } from '@playwright/test';   // pas 'playwright-core' sous pnpm
```

Le navigateur Chromium doit être installé une fois par machine (no-op si
déjà fait) :

```bash
npx --yes corepack@latest pnpm exec playwright install chromium
```

**Piège de résolution de module** : Node résout `node_modules` par rapport à
l'emplacement du *fichier* du script, pas au `cwd`. Écrire le script
temporaire **à l'intérieur du repo** (ex. `scripts/tmp-screenshot.mjs`), pas
dans un dossier externe (temp système, scratchpad…), sinon
`Cannot find package '@playwright/test'`.

```js
// scripts/tmp-screenshot.mjs — supprimer après usage, ne pas committer
import { chromium } from '@playwright/test';

const url = process.argv[2] || 'http://localhost:3000';
const out = process.argv[3] || 'screenshot.png';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
console.log('status:', res.status(), 'url:', page.url(), 'title:', await page.title());
await page.screenshot({ path: out, fullPage: true });
await browser.close();
```

Pour vérifier une connexion (pas juste le chargement d'une page), attendre
la redirection explicitement plutôt que `networkidle` seul juste après le
clic — un submit déclenche souvent une navigation asynchrone que
`networkidle` peut manquer si on la capture trop tôt :

```js
await page.click('button:has-text("Se connecter")');
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
```

```bash
node scripts/tmp-screenshot.mjs http://localhost:3000 /chemin/vers/screenshot.png
rm scripts/tmp-screenshot.mjs
```

Puis lire l'image produite pour l'inspecter visuellement — ne pas se
contenter du code de sortie du process comme preuve que l'UI fonctionne.

## Nettoyage

Après usage, `git status` ne doit montrer que ce qui a été explicitement
validé avec l'utilisateur :

- **jamais** de `package-lock.json` ni de `yarn.lock` à la racine (signe
  qu'npm/yarn a été utilisé par erreur — à supprimer, pas à committer) ;
- `pnpm-workspace.yaml` peut apparaître modifié seulement si le piège
  `ERR_PNPM_IGNORED_BUILDS` (section 4) a été rencontré et tranché avec
  l'utilisateur — ne pas committer sans lui demander ;
- tout script temporaire de capture (`scripts/tmp-*.mjs`) doit avoir été
  supprimé avant de rendre la main.
