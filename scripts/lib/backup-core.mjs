import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isLocalDatabaseUrl } from "./pg-wait.mjs";

/**
 * `OPS-03`: the shared pieces of taking and restoring a backup, so the two
 * scripts cannot drift on the one thing that must match — the dump format
 * and the manifest that describes it. A backup written one way and read
 * another is a backup that only fails on the day it is needed.
 */

export const BACKUP_DIR = process.env.BACKUP_DIR ?? "backups";

/**
 * `pg_dump`/`pg_restore` are not installed on every machine that runs this
 * project — this one has Postgres only inside its Docker Compose service —
 * so the tool is located rather than assumed, and the chosen path is
 * printed. A backup script that silently does nothing because a binary is
 * missing is the worst possible failure mode: it looks like it worked.
 *
 * The container fallback runs *inside* Postgres' own container, where the
 * URL's host and port no longer apply, so it is refused for anything that
 * is not obviously a local database — the same guard `reset-db.mjs` uses
 * before destroying a schema. Dumping a managed production database through
 * a local container would silently dump the local one instead and hand back
 * a backup of the wrong data.
 */
export async function resolveTool(tool, connectionString) {
  if (await canRun(tool, ["--version"])) {
    return { command: tool, args: [], via: "PATH", containerised: false };
  }
  const composeArgs = ["compose", "exec", "-T", "postgres", tool];
  if (await canRun("docker", [...composeArgs, "--version"])) {
    if (!isLocalDatabaseUrl(connectionString)) {
      throw new Error(
        `${tool} n'est disponible que dans le conteneur Docker local, mais DATABASE_URL ne ` +
          `pointe pas vers une base locale. Installez les outils clients PostgreSQL sur cette machine.`,
      );
    }
    return { command: "docker", args: composeArgs, via: "docker compose", containerised: true };
  }
  throw new Error(
    `${tool} introuvable : ni sur le PATH, ni dans le service Docker "postgres". ` +
      `Installez les outils clients PostgreSQL, ou démarrez la base avec \`pnpm db:up\`.`,
  );
}

function canRun(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Connection details for the tool: the user and database as arguments, the
 * password only ever through the environment.
 *
 * Command-line arguments are readable by every process on the host (`ps`),
 * so a `-d postgresql://user:password@…` would publish the database
 * password to anyone with a shell. Inside the container the local socket
 * needs no password at all, so none is passed.
 */
export function connectionArgs(connectionString, tool) {
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(url.username);
  const args = ["-U", user, "-d", database];
  if (tool.containerised) return { args, env: process.env, database, user };
  return {
    args: [...args, "-h", url.hostname, "-p", url.port || "5432"],
    env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
    database,
    user,
  };
}

/** Runs the tool, optionally streaming its stdout into `onStdout`. */
export function run(tool, args, { env = process.env, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool.command, [...tool.args, ...args], {
      stdio: ["ignore", onStdout ? "pipe" : "inherit", "pipe"],
      env,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    if (onStdout) child.stdout.pipe(onStdout);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${tool.command} ${args.join(" ")} a échoué (code ${code}) :\n${stderr.trim()}`,
          ),
        );
    });
  });
}

/** UTC, sortable, and unambiguous across the timezone the operator happens to sit in. */
export function backupName(now = new Date()) {
  return `kalloud-${now.toISOString().replace(/[:.]/g, "-")}`;
}

export async function sha256(path) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", resolve)
      .on("error", reject);
  });
  return hash.digest("hex");
}

export async function writeManifest(directory, name, manifest) {
  await writeFile(join(directory, `${name}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function readManifest(directory, name) {
  return JSON.parse(await readFile(join(directory, `${name}.json`), "utf8"));
}

/** Every backup present, newest first, with the manifest that describes it. */
export async function listBackups(directory = BACKUP_DIR) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  const backups = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const name = entry.slice(0, -".json".length);
    try {
      const manifest = await readManifest(directory, name);
      const dump = join(directory, `${name}.dump`);
      const info = await stat(dump);
      backups.push({ name, manifest, path: dump, bytes: info.size });
    } catch {
      // A manifest with no dump beside it (an interrupted run) is skipped
      // rather than reported as a backup: listing it would let the freshness
      // check pass on something that cannot be restored.
    }
  }
  return backups.sort((a, b) => b.manifest.takenAt.localeCompare(a.manifest.takenAt));
}

/**
 * `DEC-10`'s retention, applied literally: 30 rolling days of dailies, then
 * one backup per ISO week kept for 3 months.
 *
 * Deletion is the part that has to be conservative — a retention bug that
 * deletes too much is indistinguishable from having no backups at all — so
 * this returns the names to delete and the caller does the removing, and
 * anything it cannot classify is kept.
 */
export function selectExpired(backups, now = new Date()) {
  const DAY = 86_400_000;
  const keepDailyUntil = now.getTime() - 30 * DAY;
  const keepWeeklyUntil = now.getTime() - 92 * DAY;

  const weeklyKeeper = new Map();
  for (const backup of backups) {
    const takenAt = new Date(backup.manifest.takenAt).getTime();
    if (Number.isNaN(takenAt) || takenAt >= keepDailyUntil) continue;
    const week = isoWeekKey(new Date(takenAt));
    // The newest backup of each week is the one kept.
    const current = weeklyKeeper.get(week);
    if (!current || takenAt > current.takenAt)
      weeklyKeeper.set(week, { name: backup.name, takenAt });
  }

  const expired = [];
  for (const backup of backups) {
    const takenAt = new Date(backup.manifest.takenAt).getTime();
    if (Number.isNaN(takenAt)) continue;
    if (takenAt >= keepDailyUntil) continue;
    if (takenAt < keepWeeklyUntil) {
      expired.push(backup.name);
      continue;
    }
    const week = isoWeekKey(new Date(takenAt));
    if (weeklyKeeper.get(week)?.name !== backup.name) expired.push(backup.name);
  }
  return expired;
}

function isoWeekKey(date) {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc - yearStart) / 86_400_000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true });
}

export async function removeBackup(directory, name) {
  await unlink(join(directory, `${name}.dump`)).catch(() => {});
  await unlink(join(directory, `${name}.json`)).catch(() => {});
}
