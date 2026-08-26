import { Pool, type PoolClient } from "pg";

/**
 * Anything a repository can run a parameterized query against: either the
 * shared pool for a one-off statement, or a PoolClient borrowed inside
 * withTransaction() so several repository calls share one transaction.
 * Every repository function takes this as its first argument (SEC-06):
 * there is exactly one way into the database, and it is never exposed
 * directly to a route handler without a location_id-scoped query built
 * around it.
 */
export type Queryable = Pool | PoolClient;

declare global {
  // `var` is required by TypeScript's global augmentation syntax here.
  var __kalloudPgPool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env, or configure it in your deployment environment.",
    );
  }
  return new Pool({ connectionString, max: 10 });
}

// Next.js' dev server reloads route modules on every change; without this,
// each reload would create a brand new Pool (and eventually exhaust
// Postgres' max_connections) instead of reusing the same one.
export const pool: Pool = globalThis.__kalloudPgPool ?? createPool();

if (process.env.NODE_ENV !== "production") {
  globalThis.__kalloudPgPool = pool;
}

/**
 * Runs `fn` with a single checked-out client wrapped in BEGIN/COMMIT, rolling
 * back on any thrown error. Use whenever more than one write must succeed or
 * fail together (e.g. closing a business day and opening the next one).
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {
      // The connection may already be unusable (e.g. it dropped); the
      // original error is what matters and is rethrown below regardless.
    });
    throw error;
  } finally {
    client.release();
  }
}

/** Quick reachability probe used by the readiness healthcheck (FND-09). */
export async function pingDatabase(): Promise<void> {
  await pool.query("SELECT 1");
}

/**
 * BI-12: every `list*History`/`listSoldItems` repository function (`BI-02`)
 * takes an optional `limit`/`offset` — present, they paginate exactly as
 * before; both absent, the query returns every row the filter matches, the
 * shape `BI-12`'s CSV export needs (a page-schema's own `limit` is capped at
 * 200, far short of "everything this quarter"). One shared builder rather
 * than the same `if (limit !== undefined) { push; append "LIMIT $n" }`
 * written out in each of the four functions, which is exactly the kind of
 * near-duplicate this codebase's own "one formula" principle exists to
 * catch, even for a concern this small.
 *
 * Mutates `values` (appends the bound parameters in place, matching how
 * every repository function here already builds its own parameter array)
 * and returns the SQL fragment to append after `ORDER BY`.
 */
export function buildLimitOffsetClause(
  values: unknown[],
  limit: number | undefined,
  offset: number | undefined,
): string {
  let clause = "";
  if (limit !== undefined) {
    values.push(limit);
    clause += ` LIMIT $${values.length}`;
  }
  if (offset !== undefined) {
    values.push(offset);
    clause += ` OFFSET $${values.length}`;
  }
  return clause;
}
