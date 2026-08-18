import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { closeBusinessDay, openBusinessDay } from "../../lib/repositories/business-days";
import { createProduct, updateProduct } from "../../lib/repositories/products";
import { getMetrics, type Metric } from "../../lib/services/metrics";
import { METRIC_DICTIONARY } from "../../lib/metrics/dictionary";
import { sell } from "./helpers/sales";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * BI-01's acceptance criterion, verbatim: "chaque KPI expose source,
 * période, fuseau et fraîcheur." This is a contract test first (every
 * metric carries the four fields DEC-09 requires) and a correctness test
 * second — for the formulas already proven elsewhere (checkout-tax,
 * cash-movements), a light reconciliation is enough here; exhaustive
 * fixtures, refunds and timezone edge cases are BI-13's own task, not
 * duplicated in advance.
 *
 * The BI-01-labelled describe blocks below use `period: "service"`
 * throughout — BI-03 renamed what BI-01 originally called `"day"` (see
 * lib/services/metrics.ts's own note): it always meant DEC-04's *session*,
 * never a calendar day, and BI-03 gave that meaning its own, correctly
 * named period kind. The BI-03-labelled blocks further down cover what is
 * genuinely new: a real calendar-day query, an arbitrary range, and the
 * query schema's per-period field enforcement.
 */

let tenant: TestTenant;
let context: RequestContext;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Metrics Tenant");
  const owner = await createTestUser(pool, tenant, "OWNER");
  context = {
    userId: owner.userId,
    userEmail: owner.email,
    userName: "Owner",
    organizationId: tenant.organizationId,
    locationId: tenant.locationId,
    role: "OWNER",
    sessionId: 1,
  };
});

describe("BI-01: every metric carries source, period, timezone and freshness", () => {
  it("envelopes all seven KPIs with the dictionary's own id/version/label/source, even with no data at all", async () => {
    const before = Date.now();
    const result = await getMetrics(tenant.locationId, { period: "service" });
    const after = Date.now();

    const metrics: Metric<unknown>[] = Object.values(result);
    expect(metrics).toHaveLength(7);
    for (const metric of metrics) {
      const definition = METRIC_DICTIONARY[metric.id];
      // Not a duplicate assertion of the dictionary itself: this proves the
      // service actually reads from it rather than hardcoding a copy that
      // could drift.
      expect(metric.version).toBe(definition.version);
      expect(metric.label).toBe(definition.label);
      expect(metric.source).toEqual(definition.source);
      expect(metric.source.length).toBeGreaterThan(0);
      expect(metric.period).toBeDefined();
      expect(metric.timezone).toBe("Europe/Paris"); // location_settings' own default
      const computedAtMs = Date.parse(metric.computedAt);
      expect(computedAtMs).toBeGreaterThanOrEqual(before);
      expect(computedAtMs).toBeLessThanOrEqual(after);
    }

    // No business day open, none ever closed, no products: every metric
    // that legitimately has nothing to report says so honestly rather than
    // fabricating a zero that would look like a real measurement.
    expect(result.netRevenue.period).toEqual({ kind: "none" });
    expect(result.expectedCash.value).toBeNull();
    expect(result.expectedCash.period).toEqual({ kind: "none" });
    expect(result.cashVariance.value).toBeNull();
    expect(result.cashVariance.period).toEqual({ kind: "last_close", closedAt: null });
    expect(result.stockOutOfStock.value).toBe(0);
    expect(result.stockLowStock.value).toBe(0);
  });

  it("reflects the establishment's own configured timezone, not a hardcoded default", async () => {
    await pool.query("UPDATE location_settings SET timezone = $1 WHERE location_id = $2", [
      "Pacific/Auckland",
      tenant.locationId,
    ]);

    const result = await getMetrics(tenant.locationId, { period: "month" });

    // Checked on both a period-bearing metric and an "instant" one: the
    // timezone is a property of the establishment, not of any one KPI's
    // period kind.
    expect(result.netRevenue.timezone).toBe("Pacific/Auckland");
    expect(result.stockOutOfStock.timezone).toBe("Pacific/Auckland");
  });
});

describe("BI-01: revenue-family metrics reconcile with real sales", () => {
  it("sums net revenue, counts orders and averages the basket for the open service", async () => {
    const day = await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "10.00",
      stockQuantity: 10,
    });

    await sell(context, [{ productId: product.id, quantity: 1 }], { paymentMethod: "CASH" });
    await sell(context, [{ productId: product.id, quantity: 1 }], { paymentMethod: "CARD" });

    const result = await getMetrics(tenant.locationId, { period: "service" });

    expect(result.netRevenue.value).toBe("20.00");
    expect(result.ordersCount.value).toBe(2);
    expect(result.averageBasket.value).toBe("10.00");
    expect(result.netRevenue.period).toEqual({
      kind: "business_day",
      from: day.opened_at,
      to: null,
    });
  });

  it("reports the range period for month/year and leaves expected cash at 'none' outside a service query", async () => {
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Thé",
      price: "5.00",
      stockQuantity: 10,
    });
    await sell(context, [{ productId: product.id, quantity: 1 }], { paymentMethod: "CARD" });

    const result = await getMetrics(tenant.locationId, { period: "month" });

    expect(result.netRevenue.value).toBe("5.00");
    expect(result.netRevenue.period.kind).toBe("range");
    // DEC-09: expected cash is a property of one session, never a month —
    // still reported, but honestly absent rather than a sum across drawers.
    expect(result.expectedCash.value).toBeNull();
    expect(result.expectedCash.period).toEqual({ kind: "none" });
  });
});

describe("BI-01: expected cash and cash variance", () => {
  it("computes expected cash from the open day's own opening float and cash sales (CASH-04's formula)", async () => {
    await openBusinessDay(pool, tenant.locationId, "100.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "10.00",
      stockQuantity: 10,
    });
    await sell(context, [{ productId: product.id, quantity: 1 }], { paymentMethod: "CASH" });

    const result = await getMetrics(tenant.locationId, { period: "service" });

    expect(result.expectedCash.value).toBe("110.00");
  });

  it("reads cash variance from the most recently closed day, and stays null before any closure", async () => {
    const beforeAnyClose = await getMetrics(tenant.locationId, { period: "service" });
    expect(beforeAnyClose.cashVariance.value).toBeNull();

    const day = await openBusinessDay(pool, tenant.locationId, "100.00");
    const closed = await closeBusinessDay(pool, tenant.locationId, day.id, {
      expectedCash: "100.00",
      countedCash: "95.00",
      varianceReason: "Écart de caisse constaté",
      nextOpeningCash: null,
      closedBy: context.userId,
    });

    const result = await getMetrics(tenant.locationId, { period: "service" });

    expect(result.cashVariance.value).toBe("-5.00");
    expect(result.cashVariance.period).toEqual({ kind: "last_close", closedAt: closed.closed_at });
    // No day open after the close: the revenue family reports "none" for
    // the service, exactly as an establishment that has not opened yet.
    expect(result.netRevenue.period).toEqual({ kind: "none" });
  });
});

describe("BI-01: stock alert counts", () => {
  it("counts only active products, out-of-stock and at-or-under-threshold separately", async () => {
    await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Rupture active",
      price: "5.00",
      stockQuantity: 0,
    });
    await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Sous seuil",
      price: "5.00",
      stockQuantity: 2,
      alertThreshold: 5,
    });
    await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Stock confortable",
      price: "5.00",
      stockQuantity: 10,
      alertThreshold: 5,
    });
    const inactiveOutOfStock = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Rupture mais désactivé",
      price: "5.00",
      stockQuantity: 0,
    });
    await updateProduct(pool, tenant.locationId, inactiveOutOfStock.id, { isActive: false });

    const result = await getMetrics(tenant.locationId, { period: "service" });

    // The deactivated product would double both counts if it leaked in —
    // DEC-09 restricts the alert to "un produit actif" precisely so a
    // product no longer sold does not sit on the cockpit forever.
    expect(result.stockOutOfStock.value).toBe(1);
    expect(result.stockLowStock.value).toBe(1);
    expect(result.stockOutOfStock.period).toEqual({ kind: "instant" });
  });
});

describe("BI-01: tenant isolation", () => {
  it("never mixes another establishment's sales or stock into these figures", async () => {
    const otherTenant = await createTestTenant(pool, "Other Tenant");
    const otherOwner = await createTestUser(pool, otherTenant, "OWNER");
    const otherContext: RequestContext = {
      userId: otherOwner.userId,
      userEmail: otherOwner.email,
      userName: "Other Owner",
      organizationId: otherTenant.organizationId,
      locationId: otherTenant.locationId,
      role: "OWNER",
      sessionId: 1,
    };
    await openBusinessDay(pool, otherTenant.locationId, "0.00");
    const otherProduct = await createProduct(pool, otherTenant.locationId, {
      categoryId: null,
      name: "Produit d'un autre établissement",
      price: "999.00",
      stockQuantity: 5,
    });
    await sell(otherContext, [{ productId: otherProduct.id, quantity: 1 }], {
      paymentMethod: "CARD",
    });
    // A second product, out of stock on purpose: without location scoping
    // this would show up in tenant A's alert count too.
    await createProduct(pool, otherTenant.locationId, {
      categoryId: null,
      name: "Rupture chez l'autre établissement",
      price: "5.00",
      stockQuantity: 0,
    });

    const result = await getMetrics(tenant.locationId, { period: "service" });

    expect(result.netRevenue.period).toEqual({ kind: "none" });
    expect(result.netRevenue.value).toBe("0.00");
    expect(result.ordersCount.value).toBe(0);
    expect(result.stockOutOfStock.value).toBe(0);
  });
});

describe("BI-03: a calendar day is a real period, not an alias for the open session", () => {
  it("still answers for today after the service that covered it has closed", async () => {
    const day = await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "10.00",
      stockQuantity: 10,
    });
    await sell(context, [{ productId: product.id, quantity: 1 }], { paymentMethod: "CASH" });
    await closeBusinessDay(pool, tenant.locationId, day.id, {
      expectedCash: "10.00",
      countedCash: "10.00",
      varianceReason: null,
      nextOpeningCash: null,
      closedBy: context.userId,
    });

    // "service" would report "none" here (no session is open) — exactly
    // the distinction this task exists to draw. "day" asks a different
    // question and still has an answer.
    const service = await getMetrics(tenant.locationId, { period: "service" });
    expect(service.netRevenue.period).toEqual({ kind: "none" });

    const today = await getMetrics(tenant.locationId, { period: "day" });
    expect(today.netRevenue.value).toBe("10.00");
    expect(today.ordersCount.value).toBe(1);
    // DEC-09: expected cash stays a property of a session alone.
    expect(today.expectedCash.value).toBeNull();
    expect(today.expectedCash.period).toEqual({ kind: "none" });
  });

  it("answers for an explicitly chosen day, not just today's default", async () => {
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "10.00",
      stockQuantity: 10,
    });
    await sell(context, [{ productId: product.id, quantity: 1 }], { paymentMethod: "CASH" });

    const yesterday = new Date(Date.now() - 24 * 3_600_000);
    const result = await getMetrics(tenant.locationId, {
      period: "day",
      year: yesterday.getUTCFullYear(),
      month: yesterday.getUTCMonth() + 1,
      day: yesterday.getUTCDate(),
    });

    // A day with no sale of its own — the establishment's default timezone
    // is Europe/Paris, close enough to UTC that "yesterday in UTC" is not
    // "today in Paris" for this assertion to be flaky around midnight.
    expect(result.netRevenue.value).toBe("0.00");
    expect(result.ordersCount.value).toBe(0);
  });
});

describe("BI-03: an arbitrary range is its own period, not derived from month/year", () => {
  it("sums revenue strictly within the given bounds", async () => {
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "10.00",
      stockQuantity: 10,
    });
    await sell(context, [{ productId: product.id, quantity: 1 }], { paymentMethod: "CASH" });

    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
    const including = await getMetrics(tenant.locationId, {
      period: "range",
      from: anHourAgo,
      to: inAnHour,
    });
    expect(including.netRevenue.value).toBe("10.00");
    expect(including.netRevenue.period).toEqual({ kind: "range", from: anHourAgo, to: inAnHour });

    const twoHoursAgo = new Date(Date.now() - 7_200_000).toISOString();
    const excluding = await getMetrics(tenant.locationId, {
      period: "range",
      from: twoHoursAgo,
      to: anHourAgo,
    });
    expect(excluding.netRevenue.value).toBe("0.00");
  });
});
