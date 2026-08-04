/**
 * In-memory sliding-window limiter for proxy.ts (SEC-07 "limitation de
 * débit sur authentification/mutations sensibles"). This complements, it
 * does not replace, the DB-backed login-attempt ledger in
 * lib/auth/rate-limit.ts, which is what actually decides whether *this
 * specific* login attempt is blocked. This module exists to cheaply reject
 * obvious hammering (any route, any reason) before it even reaches a route
 * handler.
 *
 * Known limitation, documented rather than hidden: state is per-process, so
 * horizontally scaling the app to multiple instances would let an attacker
 * get one bucket's worth of requests per instance. Fine for the MVP's
 * single-instance deployment target (DEC-02); revisit with a shared store
 * (e.g. the database or Redis) before scaling out.
 */

interface Bucket {
  count: number;
  windowStartedAt: number;
}

const buckets = new Map<string, Bucket>();

// Periodically forget stale buckets so this Map cannot grow without bound
// for the lifetime of a long-running server process.
const MAX_TRACKED_KEYS = 10_000;

export function isRateLimited(key: string, options: { windowMs: number; max: number }): boolean {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || now - existing.windowStartedAt >= options.windowMs) {
    if (buckets.size >= MAX_TRACKED_KEYS) {
      buckets.clear();
    }
    buckets.set(key, { count: 1, windowStartedAt: now });
    return false;
  }

  existing.count += 1;
  return existing.count > options.max;
}
