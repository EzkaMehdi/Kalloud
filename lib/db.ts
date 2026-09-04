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

function resolvePool(): Pool {
  // Next.js' dev server reloads route modules on every change; without this,
  // each reload would create a brand new Pool (and eventually exhaust
  // Postgres' max_connections) instead of reusing the same one.
  const existing = globalThis.__kalloudPgPool;
  if (existing) return existing;
  const created = createPool();
  if (process.env.NODE_ENV !== "production") globalThis.__kalloudPgPool = created;
  return created;
}

/**
 * The shared pool, created on first use rather than on import (OPS-05).
 *
 * It used to be built at module load, which quietly made `DATABASE_URL` a
 * **build-time** requirement: `next build` imports every route module to
 * collect page data, so the build failed with "DATABASE_URL is not set" on
 * any machine without a `.env` — including a clean container image. Both CI
 * and local development hid it by writing one first.
 *
 * That is the wrong coupling for a deployment. A production image should be
 * buildable without production credentials: the build machine has no
 * business holding the database password, and the release artifact must not
 * depend on which database happened to be reachable when it was built. The
 * connection is genuinely not needed until a request runs, so it is opened
 * then — and the helpful error message survives, moved to first use.
 *
 * A Proxy rather than a `getPool()` function so every existing call site
 * (`pool.query`, `pool.connect`, `withTransaction`) keeps working unchanged;
 * methods are bound to the real pool so `this` stays correct.
 *
 * Every trap forwards, including the property-descriptor ones. That is not
 * completeness for its own sake: `tests/integration/validation.test.ts`
 * proves API-01's "avant l'accès base" by counting calls with
 * `vi.spyOn(pool, "query")`, and a Proxy that only forwards `get`/`set`
 * lets the spy be installed on the empty target while reads keep coming
 * from the real pool — so it records nothing and the test silently observes
 * zero queries for a checkout that ran. It caught this immediately.
 */
export const pool: Pool = new Proxy({} as Pool, {
  get(_target, property, receiver) {
    const actual = resolvePool();
    const value = Reflect.get(actual, property, receiver);
    return typeof value === "function" ? value.bind(actual) : value;
  },
  set(_target, property, value) {
    return Reflect.set(resolvePool(), property, value);
  },
  has(_target, property) {
    return Reflect.has(resolvePool(), property);
  },
  getOwnPropertyDescriptor(_target, property) {
    return Reflect.getOwnPropertyDescriptor(resolvePool(), property);
  },
  defineProperty(_target, property, descriptor) {
    return Reflect.defineProperty(resolvePool(), property, descriptor);
  },
  deleteProperty(_target, property) {
    return Reflect.deleteProperty(resolvePool(), property);
  },
  ownKeys() {
    return Reflect.ownKeys(resolvePool());
  },
  getPrototypeOf() {
    return Reflect.getPrototypeOf(resolvePool());
  },
});

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
