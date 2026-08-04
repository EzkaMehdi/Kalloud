import { Client } from "pg";

/** Tries a single short-lived connection to check whether Postgres is accepting queries. */
export async function isReachable(connectionString) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Polls until Postgres is reachable or the timeout elapses. Returns false on timeout. */
export async function waitUntilReachable(
  connectionString,
  { timeoutMs = 60_000, intervalMs = 1000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReachable(connectionString)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * Heuristic used to decide whether it is safe to auto-start Docker or run a
 * destructive reset: only ever true for hosts that can only plausibly be a
 * local developer machine or CI service container, never a managed database.
 */
export function isLocalDatabaseUrl(connectionString) {
  try {
    const { hostname } = new URL(connectionString);
    return ["localhost", "127.0.0.1", "::1", "postgres"].includes(hostname);
  } catch {
    return false;
  }
}
