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

## 2. Démarrer Postgres

```bash
npm run db:up   # docker compose up -d postgres
```

## 3. Dépendances npm

Si `node_modules/` est absent (erreurs `Cannot find package 'pg'` etc. au
`predev`) :

```bash
npm install
```

## 4. Lancer le serveur de dev

```bash
npm run dev
```

`predev` s'exécute automatiquement avant `next dev` : vérifie que la DB est
joignable, applique les migrations (`scripts/migrate.mjs up`), puis seed les
données de démo (`scripts/seed.mjs`). Lancer en arrière-plan et attendre la
ligne `✓ Ready in ...` dans les logs avant de continuer, plutôt que de
supposer un délai fixe.

L'app est alors servie sur **http://localhost:3000** (ou un autre port si
3000 est déjà pris — lire le log pour l'URL réelle).

## 5. Comptes de démo (créés par le seed)

Mot de passe unique : `Kalloud123!`

| Rôle    | Email                  |
|---------|-------------------------|
| OWNER   | owner@kalloud.test     |
| MANAGER | manager@kalloud.test   |
| CASHIER | cashier@kalloud.test   |

`http://localhost:3000` redirige vers `/login?next=/caisse` tant qu'on n'est
pas authentifié.

## 6. Vérifier visuellement (screenshot headless)

Playwright est déjà en devDependency (`@playwright/test`), mais le package
direct `playwright` ne l'est pas — importer `playwright-core`, qui est déjà
présent en dépendance transitive. Le navigateur Chromium doit être installé
une fois par machine (no-op si déjà fait) :

```bash
npx playwright install chromium
```

**Piège de résolution de module** : Node résout `node_modules` par rapport à
l'emplacement du *fichier* du script, pas au `cwd`. Écrire le script
temporaire **à l'intérieur du repo** (ex. `scripts/tmp-screenshot.mjs`), pas
dans un dossier externe (temp système, scratchpad…), sinon
`Cannot find package 'playwright-core'`.

```js
// scripts/tmp-screenshot.mjs — supprimer après usage, ne pas committer
import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://localhost:3000';
const out = process.argv[3] || 'screenshot.png';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
console.log('status:', res.status(), 'url:', page.url(), 'title:', await page.title());
await page.screenshot({ path: out, fullPage: true });
await browser.close();
```

```bash
node scripts/tmp-screenshot.mjs http://localhost:3000 /chemin/vers/screenshot.png
rm scripts/tmp-screenshot.mjs
```

Puis lire l'image produite pour l'inspecter visuellement — ne pas se
contenter du code de sortie du process comme preuve que l'UI fonctionne.

## Nettoyage

Après usage, seul `package-lock.json` (si `npm install` a été nécessaire)
doit apparaître dans `git status` — tout autre fichier modifié ou resté en
place (comme le script temporaire de capture) est suspect et doit être
retiré avant de rendre la main.
