/**
 * OPS-02: operational telemetry — availability, latency and errors, counted
 * in the process itself.
 *
 * Deliberately not the same thing as `lib/metrics/dictionary.ts`, which is
 * the *business* KPI registry (BI-01/DEC-09). These numbers describe how the
 * software is behaving, never how the establishment is trading, and the two
 * vocabularies are kept apart so nobody reads a p95 as a business figure or
 * a revenue drop as an outage.
 *
 * In-process and per-instance on purpose. There is no metrics backend in
 * this deployment (OPS-05 provisions a single application instance), so a
 * counter here is exactly as durable as the process: it resets on restart
 * and it describes one instance only. That is stated in the payload
 * (`process.startedAt`) rather than hidden, because a rate computed across
 * a restart would be silently wrong — and a wrong availability figure is
 * worse than no figure at all.
 */

export type Outcome = "ok" | "client_error" | "server_error";

interface RouteStats {
  ok: number;
  client_error: number;
  server_error: number;
  durationCount: number;
  durationSumMs: number;
  durationMaxMs: number;
  /** Sorted-insert reservoir, capped — see `recordRequest`. */
  durations: number[];
}

/**
 * Bounded so a single route cannot grow without limit. 512 samples is
 * plenty for a p95 on this traffic and costs a few kilobytes; beyond it the
 * oldest sample is dropped, which biases the percentile towards recent
 * behaviour — the right bias for an alert about what is happening *now*.
 */
const MAX_DURATION_SAMPLES = 512;

/**
 * Cardinality guard. A route key comes from the URL path, and paths carry
 * ids (`/api/team/42`), so an unnormalised key would create one bucket per
 * row the product has ever touched — an unbounded memory leak dressed as
 * observability. Numeric segments collapse to `:id`.
 */
export function normalizeRoute(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => (/^\d+$/.test(segment) ? ":id" : segment))
    .join("/");
}

interface Registry {
  routes: Map<string, RouteStats>;
  counters: Map<string, number>;
  startedAt: Date;
}

declare global {
  // `var` is required by TypeScript's global augmentation syntax here.
  var __kalloudOpsRegistry: Registry | undefined;
}

/**
 * Held on `globalThis`, for the same reason `lib/db.ts` holds the pool
 * there — and it is not a dev-only nicety here. Route handlers are bundled
 * per route, so a plain module-level Map gives each endpoint its own
 * private registry: `/api/health/metrics` would then report only the
 * requests made to `/api/health/metrics`. That is exactly how this first
 * behaved — the endpoint answered `requests: 0` on a server that had just
 * served a dozen — and a monitoring endpoint that under-reports is worse
 * than one that is absent, because it reads as "all quiet".
 */
const registry: Registry = (globalThis.__kalloudOpsRegistry ??= {
  routes: new Map<string, RouteStats>(),
  counters: new Map<string, number>(),
  startedAt: new Date(),
});

const { routes, counters } = registry;

function statsFor(route: string): RouteStats {
  let stats = routes.get(route);
  if (!stats) {
    stats = {
      ok: 0,
      client_error: 0,
      server_error: 0,
      durationCount: 0,
      durationSumMs: 0,
      durationMaxMs: 0,
      durations: [],
    };
    routes.set(route, stats);
  }
  return stats;
}

/**
 * Classifies a response, and this is where "aucun bruit excessif" is
 * actually decided.
 *
 * A 400, 401, 403, 404, 409 or 429 is the product **working**: a refused
 * permission (SEC-05), a rejected payload (API-01), a duplicate idempotency
 * key (API-02), a rate limit (SEC-07). Counting those as errors would make
 * the error rate track how often people mistype a password, and the first
 * on-call page would teach everyone to ignore the next one. Only 5xx —
 * something the establishment did nothing to cause and cannot fix — counts
 * as a server error.
 */
export function classify(statusCode: number): Outcome {
  if (statusCode >= 500) return "server_error";
  if (statusCode >= 400) return "client_error";
  return "ok";
}

export function recordRequest(pathname: string, statusCode: number, durationMs: number): void {
  const stats = statsFor(normalizeRoute(pathname));
  stats[classify(statusCode)] += 1;
  stats.durationCount += 1;
  stats.durationSumMs += durationMs;
  stats.durationMaxMs = Math.max(stats.durationMaxMs, durationMs);
  stats.durations.push(durationMs);
  if (stats.durations.length > MAX_DURATION_SAMPLES) stats.durations.shift();
}

/** Named events that are not requests (a database that went away, a closing). */
export function incrementCounter(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: with few samples this returns an observed value rather
  // than an interpolation between two that never happened.
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

export interface RouteSnapshot {
  route: string;
  requests: number;
  ok: number;
  clientErrors: number;
  serverErrors: number;
  averageMs: number;
  p95Ms: number;
  maxMs: number;
}

export interface ProcessSnapshot {
  startedAt: string;
  uptimeSeconds: number;
  requests: number;
  serverErrors: number;
  clientErrors: number;
  serverErrorRate: number;
  p95Ms: number;
  routes: RouteSnapshot[];
  counters: Record<string, number>;
}

export function snapshotProcess(): ProcessSnapshot {
  const perRoute: RouteSnapshot[] = [];
  const allDurations: number[] = [];
  let requests = 0;
  let serverErrors = 0;
  let clientErrors = 0;

  for (const [route, stats] of routes) {
    const total = stats.ok + stats.client_error + stats.server_error;
    requests += total;
    serverErrors += stats.server_error;
    clientErrors += stats.client_error;
    allDurations.push(...stats.durations);
    perRoute.push({
      route,
      requests: total,
      ok: stats.ok,
      clientErrors: stats.client_error,
      serverErrors: stats.server_error,
      averageMs: stats.durationCount ? Math.round(stats.durationSumMs / stats.durationCount) : 0,
      p95Ms: percentile(stats.durations, 0.95),
      maxMs: stats.durationMaxMs,
    });
  }

  perRoute.sort((a, b) => b.requests - a.requests);

  return {
    startedAt: registry.startedAt.toISOString(),
    uptimeSeconds: Math.round((Date.now() - registry.startedAt.getTime()) / 1000),
    requests,
    serverErrors,
    clientErrors,
    serverErrorRate: requests === 0 ? 0 : serverErrors / requests,
    p95Ms: percentile(allDurations, 0.95),
    routes: perRoute,
    counters: Object.fromEntries(counters),
  };
}

/** Test-only: the registry is module state, and cases must not leak into each other. */
export function resetMetrics(): void {
  routes.clear();
  counters.clear();
}
