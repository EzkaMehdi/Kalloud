#!/usr/bin/env node
// OPS-03: takes one backup of the application database and applies DEC-10's
// retention. Intended to be run daily by the host's scheduler — see
// docs/sauvegarde-restauration.md for the cron entry and for why the
// freshness of what this produces is checked by OPS-02 rather than assumed.
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import {
  BACKUP_DIR,
  backupName,
  connectionArgs,
  ensureDirectory,
  listBackups,
  removeBackup,
  resolveTool,
  run,
  selectExpired,
  sha256,
  writeManifest,
} from "./lib/backup-core.mjs";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("[backup] DATABASE_URL is not set.");
  process.exit(1);
}

const startedAt = Date.now();
const tool = await resolveTool("pg_dump", connectionString);
const { args, env, database } = connectionArgs(connectionString, tool);
const name = backupName();

await ensureDirectory(BACKUP_DIR);
const dumpPath = join(BACKUP_DIR, `${name}.dump`);

console.log(`[backup] pg_dump via ${tool.via} → ${dumpPath}`);
const output = createWriteStream(dumpPath);
// Attached *before* the run: piping the child's stdout ends this stream, so
// `finish` can already have fired by the time `run` resolves, and a
// listener added afterwards would wait for an event that will never come.
const written = new Promise((resolve, reject) => {
  output.on("finish", resolve).on("error", reject);
});
await run(
  tool,
  // Custom format: compressed, and restorable selectively by pg_restore.
  // `--no-owner`/`--no-acl` so a restore into an isolated database owned by
  // a different role does not fail on roles that only exist in production —
  // a backup that only restores onto its own server is not a backup.
  [...args, "-Fc", "--no-owner", "--no-acl"],
  { env, onStdout: output },
);
await written;

const { size } = await stat(dumpPath);
if (size === 0) {
  await removeBackup(BACKUP_DIR, name);
  console.error("[backup] pg_dump produced an empty file — backup discarded.");
  process.exit(1);
}

// The schema version is recorded with the dump: restoring a backup taken
// before a migration into an application that expects the newer schema is a
// failure worth predicting rather than discovering at 3am.
const client = new Client({ connectionString });
await client.connect();
let schemaVersion = null;
try {
  const { rows } = await client.query("SELECT MAX(id) AS version FROM schema_migrations");
  schemaVersion = rows[0]?.version ?? null;
} catch {
  console.warn("[backup] schema_migrations unreadable — version not recorded.");
} finally {
  await client.end();
}

const manifest = {
  name,
  takenAt: new Date().toISOString(),
  database,
  schemaVersion,
  bytes: size,
  sha256: await sha256(dumpPath),
  format: "pg_dump custom (-Fc)",
  tool: tool.via,
  durationMs: Date.now() - startedAt,
};
await writeManifest(BACKUP_DIR, name, manifest);

console.log(
  `[backup] ${name} — ${(size / 1024 / 1024).toFixed(2)} Mo, schéma ${schemaVersion ?? "inconnu"}, ${manifest.durationMs} ms`,
);

// DEC-10 retention, applied after the new backup exists so a failure above
// never deletes anything.
const expired = selectExpired(await listBackups(BACKUP_DIR));
for (const stale of expired) await removeBackup(BACKUP_DIR, stale);
console.log(
  expired.length > 0
    ? `[backup] Rétention DEC-10 : ${expired.length} sauvegarde(s) expirée(s) supprimée(s).`
    : "[backup] Rétention DEC-10 : rien à supprimer.",
);
