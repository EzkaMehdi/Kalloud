import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "./db";

/**
 * OPS-05: does the database this process is talking to match the code in
 * this image?
 *
 * Readiness used to answer only "is Postgres reachable", which is the
 * question that matters on a first deploy and the wrong one on a rollback.
 * Migrations here are forward-only (`scripts/migrate.mjs up`, no `down`), so
 * rolling an image back leaves the previous release running against a
 * *newer* schema. Most of the time that appears to work — the old code
 * simply ignores the new columns — right up to the query that hits a
 * renamed one, mid-service, with a queue at the till.
 *
 * So the two mismatches are reported differently, because they are
 * different situations:
 *
 * - **Missing** migrations: the image is ahead of the database. The deploy
 *   has not finished, or migrations failed. Not ready — serving traffic
 *   would hit columns that do not exist yet.
 * - **Unknown** migrations: the database is ahead of the image. That is a
 *   rollback, and it is a decision someone made. Reported, and readiness
 *   still refuses: an orchestrator must not quietly send customers to a
 *   release running on a schema it has never seen.
 */

const MIGRATIONS_DIR = join(process.cwd(), "migrations");

export interface SchemaVersionStatus {
  expected: number;
  applied: number;
  /** In the image, not in the database — the deploy is incomplete. */
  missing: string[];
  /** In the database, not in the image — something was rolled back. */
  unknown: string[];
  matches: boolean;
}

export async function getSchemaVersionStatus(): Promise<SchemaVersionStatus> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((entry) => entry.endsWith(".sql")).sort();

  const { rows } = await pool.query<{ id: string }>("SELECT id FROM schema_migrations");
  const applied = new Set(rows.map((row) => row.id));

  const missing = files.filter((file) => !applied.has(file));
  const unknown = [...applied].filter((id) => !files.includes(id)).sort();

  return {
    expected: files.length,
    applied: applied.size,
    missing,
    unknown,
    matches: missing.length === 0 && unknown.length === 0,
  };
}
