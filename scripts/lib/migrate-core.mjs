import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const migrationsDir = path.join(__dirname, "..", "..", "migrations");

export async function loadMigrationFiles() {
  const entries = await readdir(migrationsDir);
  return entries.filter((file) => file.endsWith(".sql")).sort();
}

export async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function getAppliedMigrations(client) {
  const { rows } = await client.query("SELECT id FROM schema_migrations ORDER BY id");
  return new Set(rows.map((row) => row.id));
}

export async function applyMigration(client, file) {
  const sql = await readFile(path.join(migrationsDir, file), "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Migration ${file} failed and was rolled back: ${reason}`);
  }
}

/**
 * Applies every migration that is not yet recorded in schema_migrations, in
 * filename order, each in its own transaction. Returns the list of files
 * that were actually applied (empty if the schema was already current).
 * Shared by the CLI runner (scripts/migrate.mjs) and the integration test
 * global setup so both guarantee the exact same schema.
 */
export async function runPendingMigrations(client) {
  await ensureMigrationsTable(client);
  const files = await loadMigrationFiles();
  const applied = await getAppliedMigrations(client);
  const pending = files.filter((file) => !applied.has(file));
  for (const file of pending) {
    await applyMigration(client, file);
  }
  return pending;
}
