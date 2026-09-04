import { beforeEach, describe, expect, it } from "vitest";
import {
  classify,
  incrementCounter,
  normalizeRoute,
  percentile,
  recordRequest,
  resetMetrics,
  snapshotProcess,
} from "../../lib/observability/collector";
import {
  BACKUP_MAX_AGE_HOURS,
  evaluateAlerts,
  MIN_REQUESTS_FOR_RATE,
  P95_LATENCY_THRESHOLD_MS,
  type OperationalFacts,
} from "../../lib/observability/alerts";

beforeEach(() => {
  resetMetrics();
});

const healthy: OperationalFacts = {
  databaseReachable: true,
  staleOpenBusinessDays: [],
  unexplainedVariances: [],
  closingsInWindow: 3,
  lastBackupAgeHours: 3,
};

function record(count: number, statusCode: number, durationMs = 10, route = "/api/products") {
  for (let index = 0; index < count; index += 1) recordRequest(route, statusCode, durationMs);
}

describe("OPS-02: what counts as an error", () => {
  it("treats business refusals as the product working, not as errors", () => {
    // Every one of these is a documented, intentional refusal: SEC-05,
    // API-01, API-02, SEC-07.
    for (const status of [400, 401, 403, 404, 409, 429]) {
      expect(classify(status), `${status} must not be a server error`).toBe("client_error");
    }
    expect(classify(500)).toBe("server_error");
    expect(classify(503)).toBe("server_error");
    expect(classify(200)).toBe("ok");
    expect(classify(201)).toBe("ok");
  });

  it("keeps refusals out of the server error rate entirely", () => {
    record(90, 403);
    record(10, 200);

    const snapshot = snapshotProcess();
    expect(snapshot.requests).toBe(100);
    expect(snapshot.clientErrors).toBe(90);
    expect(snapshot.serverErrors).toBe(0);
    expect(snapshot.serverErrorRate).toBe(0);
    expect(evaluateAlerts(snapshot, healthy)).toEqual([]);
  });
});

describe("OPS-02: route cardinality", () => {
  it("collapses ids so a path cannot create one bucket per row", () => {
    expect(normalizeRoute("/api/team/42")).toBe("/api/team/:id");
    expect(normalizeRoute("/api/products/7/stock")).toBe("/api/products/:id/stock");
    expect(normalizeRoute("/api/checkout")).toBe("/api/checkout");
  });

  it("groups requests to the same route under one key", () => {
    recordRequest("/api/team/1", 200, 5);
    recordRequest("/api/team/2", 200, 5);
    recordRequest("/api/team/3", 200, 5);

    const routes = snapshotProcess().routes;
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ route: "/api/team/:id", requests: 3 });
  });
});

describe("OPS-02: latency", () => {
  it("reports a percentile from observed values rather than an interpolation", () => {
    expect(percentile([10, 20, 30, 40, 50], 0.95)).toBe(50);
    expect(percentile([10], 0.95)).toBe(10);
    expect(percentile([], 0.95)).toBe(0);
  });

  it("does not let one slow request out of twenty move the p95", () => {
    record(19, 200, 10);
    record(1, 200, 900);

    const route = snapshotProcess().routes[0];
    // The slowest of twenty is the 100th percentile, not the 95th. That is
    // the point of measuring a percentile rather than a maximum: a single
    // cold start should not page anyone. `maxMs` still carries it, for
    // whoever is actually looking.
    expect(route.p95Ms).toBe(10);
    expect(route.maxMs).toBe(900);
    expect(route.averageMs).toBe(Math.round((19 * 10 + 900) / 20));
  });

  it("does move the p95 once slowness stops being a one-off", () => {
    record(18, 200, 10);
    record(2, 200, 900);

    expect(snapshotProcess().routes[0].p95Ms).toBe(900);
  });
});

describe("OPS-02: alert thresholds", () => {
  it("stays silent below the minimum sample size, whatever the rate", () => {
    record(MIN_REQUESTS_FOR_RATE - 1, 500);

    const snapshot = snapshotProcess();
    // A 100 % error rate, and deliberately no alert: two requests at 6am
    // are not an incident.
    expect(snapshot.serverErrorRate).toBe(1);
    expect(alertIds(evaluateAlerts(snapshot, healthy))).not.toContain("server_error_rate");
  });

  it("fires once the sample is big enough and the rate is crossed", () => {
    record(MIN_REQUESTS_FOR_RATE, 500);

    const alerts = evaluateAlerts(snapshotProcess(), healthy);
    const rate = alerts.find((alert) => alert.id === "server_error_rate");
    expect(rate).toMatchObject({ severity: "critical", recipient: "astreinte" });
    expect(rate?.observed).toContain("100.00 %");
  });

  it("does not fire on a rate that stays under the threshold", () => {
    record(999, 200);
    record(1, 500);

    expect(alertIds(evaluateAlerts(snapshotProcess(), healthy))).not.toContain("server_error_rate");
  });

  it("raises an unreachable database at any volume", () => {
    const alerts = evaluateAlerts(snapshotProcess(), { ...healthy, databaseReachable: false });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: "database_unreachable",
      severity: "critical",
      recipient: "astreinte",
    });
  });

  it("reports a single failed checkout, even when the global rate is fine", () => {
    record(999, 200);
    record(1, 500, 10, "/api/checkout");

    const alerts = evaluateAlerts(snapshotProcess(), healthy);
    expect(alertIds(alerts)).toContain("checkout_failures");
    expect(alertIds(alerts)).not.toContain("server_error_rate");
  });

  it("does not treat a refused checkout as a failed one", () => {
    // Insufficient stock (SALE-07) and a replayed idempotency key (API-02)
    // both surface as 4xx: the sale did not happen, and nothing is broken.
    record(50, 409, 10, "/api/checkout");
    record(50, 400, 10, "/api/checkout");

    expect(alertIds(evaluateAlerts(snapshotProcess(), healthy))).toEqual([]);
  });

  it("warns on latency, without calling it critical", () => {
    // Every sample slow, so the p95 is unambiguously over the threshold.
    record(MIN_REQUESTS_FOR_RATE, 200, P95_LATENCY_THRESHOLD_MS + 1);

    const latency = evaluateAlerts(snapshotProcess(), healthy).find(
      (alert) => alert.id === "latency_p95",
    );
    expect(latency).toMatchObject({ severity: "warning", recipient: "astreinte" });
  });

  it("addresses a service left open to the establishment, not to on-call", () => {
    const alerts = evaluateAlerts(snapshotProcess(), {
      ...healthy,
      staleOpenBusinessDays: [{ locationId: 4, openedAt: "2026-09-01T10:00:00Z", hoursOpen: 30 }],
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: "business_day_not_closed:4",
      severity: "warning",
      recipient: "etablissement",
    });
  });

  it("addresses an unexplained cash variance to the establishment", () => {
    const alerts = evaluateAlerts(snapshotProcess(), {
      ...healthy,
      unexplainedVariances: [{ locationId: 4, businessDayId: 9, variance: "-42.00" }],
    });
    expect(alerts[0]).toMatchObject({
      id: "cash_variance_unexplained:9",
      recipient: "etablissement",
    });
    expect(alerts[0].observed).toContain("-42.00");
  });

  it("says nothing at all when a busy, healthy instance is doing its job", () => {
    record(500, 200, 40);
    record(120, 403);
    record(30, 409, 10, "/api/checkout");

    expect(evaluateAlerts(snapshotProcess(), healthy)).toEqual([]);
  });
});

describe("OPS-03: the backup RPO is checked, not assumed", () => {
  it("says nothing while backups are fresh", () => {
    expect(
      alertIds(evaluateAlerts(snapshotProcess(), { ...healthy, lastBackupAgeHours: 20 })),
    ).toEqual([]);
  });

  it("tolerates a scheduler that drifts by a few minutes", () => {
    // DEC-10's RPO is 24 h; the check allows a small margin so a nightly
    // job running at 03:00 does not page anyone for being late by an hour.
    expect(
      alertIds(evaluateAlerts(snapshotProcess(), { ...healthy, lastBackupAgeHours: 25 })),
    ).toEqual([]);
  });

  it("raises the moment the RPO is genuinely missed", () => {
    const alert = evaluateAlerts(snapshotProcess(), {
      ...healthy,
      lastBackupAgeHours: BACKUP_MAX_AGE_HOURS + 1,
    })[0];
    expect(alert).toMatchObject({
      id: "backup_overdue",
      severity: "critical",
      recipient: "astreinte",
    });
  });

  it("treats no backup at all as its own, unmissable failure", () => {
    // Distinct from "overdue" on purpose: a schedule that never ran once is
    // a different problem from one that stopped, and the person reading the
    // alert at 3am should not have to work out which.
    const alert = evaluateAlerts(snapshotProcess(), { ...healthy, lastBackupAgeHours: null })[0];
    expect(alert).toMatchObject({ id: "backup_missing", severity: "critical" });
  });
});

describe("OPS-02: named counters", () => {
  it("carries events that are not requests", () => {
    incrementCounter("database_unreachable");
    incrementCounter("database_unreachable", 2);
    expect(snapshotProcess().counters).toEqual({ database_unreachable: 3 });
  });
});

function alertIds(alerts: readonly { id: string }[]): string[] {
  return alerts.map((alert) => alert.id);
}
