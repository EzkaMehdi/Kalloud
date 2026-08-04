#!/usr/bin/env node
// FND-05: the single canonical migration runner. Replaces the old, fragile
// split between database/schema.sql, database/002-business-days.sql and
// whatever docker-compose happened to mount. Every schema change is a new,
// numbered file under migrations/; nothing else is allowed to change the
// schema. Thin CLI wrapper: the actual logic is shared with the integration
// test bootstrap via scripts/lib/migrate-core.mjs.
import { Client } from "pg";
import {
  loadMigrationFiles,
  getAppliedMigrations,
  ensureMigrationsTable,
  runPendingMigrations,
} from "./lib/migrate-core.mjs";

async function main() {
  const command = process.argv[2] ?? "up";
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("[migrate] DATABASE_URL is not set.");
    process.exitCode = 1;
    return;
  }
  if (command !== "up" && command !== "status") {
    console.error(`[migrate] Unknown command "${command}". Use "up" or "status".`);
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    if (command === "status") {
      await ensureMigrationsTable(client);
      const files = await loadMigrationFiles();
      const applied = await getAppliedMigrations(client);
      for (const file of files) {
        console.log(`${applied.has(file) ? "[applied]" : "[pending]"} ${file}`);
      }
      const pendingCount = files.filter((file) => !applied.has(file)).length;
      console.log(
        pendingCount > 0
          ? `\n${pendingCount} pending migration(s).`
          : "\nDatabase schema is up to date.",
      );
      return;
    }

    const applied = await runPendingMigrations(client);
    for (const file of applied) {
      console.log(`[migrate] applied ${file}`);
    }
    console.log(
      applied.length > 0
        ? `[migrate] Applied ${applied.length} migration(s).`
        : "[migrate] Nothing to apply, schema is up to date.",
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[migrate] Failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
