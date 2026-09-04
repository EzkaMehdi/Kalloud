import { expect, test } from "@playwright/test";
import { createThrowawayTenant } from "./helpers/tenant";

/**
 * OPS-02, over HTTP: the endpoint reports on every establishment at once,
 * so what has to be proved here is who gets in — and an ordinary session,
 * however privileged inside its own establishment, does not.
 */

const TOKEN = "e2e-ops-token";

test.describe("OPS-02: the operations endpoint", () => {
  test("serves the operator, and nobody else", async ({ request }) => {
    expect((await request.get("/api/health/metrics")).status()).toBe(401);
    expect(
      (
        await request.get("/api/health/metrics", {
          headers: { Authorization: "Bearer wrong-token" },
        })
      ).status(),
    ).toBe(401);

    const response = await request.get("/api/health/metrics", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status()).toBe(200);
  });

  test("is not reachable with an establishment owner's session", async ({ page }) => {
    // DEC-07 grants no permission over the platform: an owner administers
    // their establishment, and this endpoint answers for all of them.
    const tenant = await createThrowawayTenant("OPS-02");
    try {
      await tenant.login(page);
      expect((await page.request.get("/api/health/metrics")).status()).toBe(401);
    } finally {
      await tenant.dispose();
    }
  });

  test("reports availability, latency, errors and the day's operations", async ({ request }) => {
    // A request of our own first: the snapshot is built before the current
    // one is recorded, so a run that happened to be the server's very first
    // would legitimately read zero.
    await request.get("/api/health/live");

    const report = await (
      await request.get("/api/health/metrics", { headers: { Authorization: `Bearer ${TOKEN}` } })
    ).json();

    expect(report.database.reachable).toBe(true);
    expect(report.process.requests).toBeGreaterThan(0);
    expect(report.process.startedAt).toBeTruthy();
    expect(Array.isArray(report.alerts)).toBe(true);

    // The six things OPS-02's livrable names are all present.
    expect(report.process).toHaveProperty("serverErrorRate");
    expect(report.process).toHaveProperty("p95Ms");
    expect(report.database).toHaveProperty("closings");
    expect(report.database).toHaveProperty("openServicesOverdue");
    expect(report.database).toHaveProperty("unexplainedVariances");
  });

  test("does not raise an alert for its own refusals", async ({ request }) => {
    // Three rejected calls: exactly the kind of 4xx that must never reach
    // the error rate, proved through the endpoint that counts them.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request.get("/api/health/metrics", { headers: { Authorization: "Bearer nope" } });
    }

    const report = await (
      await request.get("/api/health/metrics", { headers: { Authorization: `Bearer ${TOKEN}` } })
    ).json();

    const own = report.process.routes.find(
      (route: { route: string }) => route.route === "/api/health/metrics",
    );
    expect(own.clientErrors).toBeGreaterThanOrEqual(3);
    expect(own.serverErrors).toBe(0);
    expect(
      report.alerts.map((alert: { id: string }) => alert.id),
      "a rejected token is the endpoint working, not an incident",
    ).not.toContain("server_error_rate");
  });

  test("groups per-row paths under one route key", async ({ page, request }) => {
    // Cardinality: without normalisation, monitoring itself would leak
    // memory on a busy day. Signed in, because proxy.ts turns away an
    // API call with no session before the handler — and therefore before
    // anything is counted.
    const tenant = await createThrowawayTenant("OPS-02 routes");
    try {
      await tenant.login(page);
      const created = await page.request.post("/api/products", {
        data: { categoryId: null, name: `Test OPS-02 ${crypto.randomUUID()}`, price: "1.00" },
      });
      const product = await created.json();
      // PATCH, because `/api/products/[id]` exposes no GET — an unexported
      // verb never reaches apiRoute and so is never counted.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await page.request.patch(`/api/products/${product.id}`, { data: { isActive: true } });
      }
    } finally {
      await tenant.dispose();
    }

    const report = await (
      await request.get("/api/health/metrics", { headers: { Authorization: `Bearer ${TOKEN}` } })
    ).json();

    const keys = report.process.routes.map((route: { route: string }) => route.route);
    expect(keys).toContain("/api/products/:id");
    expect(keys.filter((key: string) => key.startsWith("/api/products/"))).toHaveLength(1);
  });
});
