#!/usr/bin/env node
// Developer convenience only: drops every object in the public schema and
// lets the next `pnpm db:migrate` rebuild it from scratch. This is distinct
// from the guarded demo-data reset (FND-14); it is gated purely on "does
// this look like a local database" because it destroys the entire schema,
// not just seeded rows.
import { Client } from "pg";
import { isLocalDatabaseUrl } from "./lib/pg-wait.mjs";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("[reset-db] DATABASE_URL is not set.");
  process.exit(1);
}

const allowed =
  isLocalDatabaseUrl(connectionString) || process.env.ALLOW_DESTRUCTIVE_DB_RESET === "true";
if (!allowed) {
  console.error(
    "[reset-db] Refusing to reset a database that is not local. If you are " +
      "absolutely certain, re-run with ALLOW_DESTRUCTIVE_DB_RESET=true.",
  );
  process.exit(1);
}

const client = new Client({ connectionString });
await client.connect();
try {
  console.log("[reset-db] Dropping and recreating the public schema...");
  await client.query("DROP SCHEMA public CASCADE");
  await client.query("CREATE SCHEMA public");
  console.log("[reset-db] Done. Run `pnpm db:migrate` (or `pnpm dev`) to rebuild the schema.");
} finally {
  await client.end();
}
