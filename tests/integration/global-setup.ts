import { Client } from "pg";
// @ts-expect-error -- plain JS module shared with the CLI runner, see scripts/lib/migrate-core.mjs
import { runPendingMigrations } from "../../scripts/lib/migrate-core.mjs";

/**
 * Vitest `globalSetup` for the `integration` project (FND-04/FND-05): brings
 * the dedicated `kalloud_test` database to the latest schema exactly once
 * before any integration test file runs, using the same migration runner as
 * `pnpm db:migrate`. This is what lets `DEC-02`'s promise hold: a fresh and
 * an existing database always converge on the same schema.
 */
export default async function globalSetup() {
  const connectionString = process.env.DATABASE_URL_TEST;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL_TEST is not set. Copy .env.example to .env (it points at a dedicated kalloud_test database).",
    );
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const applied = await runPendingMigrations(client);
    if (applied.length > 0) {
      console.log(`[integration setup] applied ${applied.length} migration(s) to kalloud_test`);
    }
  } finally {
    await client.end();
  }
}
