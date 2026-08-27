import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { openBusinessDay } from "../../lib/repositories/business-days";
import { createProduct } from "../../lib/repositories/products";
import { getPerformanceComparison } from "../../lib/services/performance";
import { zonedTime, zonedToday } from "../../lib/time";
import { sell } from "./helpers/sales";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * BI-07's acceptance criterion, verbatim: "comparaison avec période
 * précédente comparable et calcul testé." DEC-09 gives a different rule
 * per period kind — this proves each one, plus the two edge cases a naive
 * implementation gets wrong: dividing by a zero "previous" (Infinity/NaN
 * instead of an honest "nothing to compare"), and treating "hier" as
 * comparable to "aujourd'hui" for a single day.
 */

let tenant: TestTenant;
let context: RequestContext;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Performance Tenant");
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

/** Backdates an order's settlement instant, the same technique tests/integration/alerts.test.ts already uses. */
async function backdateOrder(orderId: number, at: Date): Promise<void> {
  await pool.query("UPDATE orders SET paid_at = $1 WHERE id = $2", [at.toISOString(), orderId]);
}

describe("BI-07: a day compares to the average of recent same-weekday days, not to yesterday", () => {
  it("averages exactly the last 4 same-weekday occurrences, zeros included", async () => {
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "5.00",
      stockQuantity: 50,
    });

    // Today: 15.00 €, one order.
    await sell(context, [{ productId: product.id, quantity: 3 }], { paymentMethod: "CASH" }); // 15.00

    // 7 days ago (same weekday by construction): 10.00 €, one order.
    const week1 = await sell(context, [{ productId: product.id, quantity: 2 }], {
      paymentMethod: "CASH",
    }); // 10.00
    await backdateOrder(week1.order.id, new Date(Date.now() - 7 * 86_400_000));

    // 14 days ago (same weekday): 20.00 €, one order.
    const week2 = await sell(context, [{ productId: product.id, quantity: 4 }], {
      paymentMethod: "CASH",
    }); // 20.00
    await backdateOrder(week2.order.id, new Date(Date.now() - 14 * 86_400_000));

    // Weeks 3 and 4 back are left with no orders at all — real zeros, not
    // skipped: DEC-09 says "la moyenne des lundis récents", not "la
    // moyenne des lundis récents qui ont vendu quelque chose".

    const result = await getPerformanceComparison(tenant.locationId, { period: "day" });

    expect(result.netRevenue.current).toBe("15.00");
    // (10.00 + 20.00 + 0 + 0) / 4 = 7.50
    expect(result.netRevenue.previous).toBe("7.50");
    expect(result.netRevenue.changePercent).toBeCloseTo(100, 5); // (15 - 7.5) / 7.5 = +100%

    expect(result.ordersCount.current).toBe(1);
    // (1 + 1 + 0 + 0) / 4 = 0.5 — an honest average, not rounded away.
    expect(result.ordersCount.previous).toBe(0.5);

    const expectedWeekday = new Intl.DateTimeFormat("fr-FR", {
      weekday: "long",
      timeZone: "Europe/Paris",
    }).format(new Date());
    expect(result.comparisonLabel.toLowerCase()).toContain(expectedWeekday.toLowerCase());
    expect(result.comparisonLabel).toContain("4 derniers");
  });

  it("answers for an explicitly chosen day, not just today", async () => {
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Thé",
      price: "5.00",
      stockQuantity: 50,
    });
    const order = await sell(context, [{ productId: product.id, quantity: 1 }], {
      paymentMethod: "CARD",
    });
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    await backdateOrder(order.order.id, twoDaysAgo);

    // BI-13: the establishment's own timezone (Europe/Paris, the seeded
    // default), not UTC — extracting UTC calendar fields here named the
    // wrong day whenever "now" fell in the window where the UTC and Paris
    // calendar dates disagree (e.g. just after midnight in Paris but still
    // the previous day in UTC, which August's CEST offset makes a real ~2h
    // window every day), silently querying a day the order never landed in
    // and failing intermittently depending only on the wall-clock minute
    // the suite happened to run at.
    const { year, month, day } = zonedToday("Europe/Paris", twoDaysAgo);
    const result = await getPerformanceComparison(tenant.locationId, {
      period: "day",
      year,
      month,
      day,
    });

    expect(result.netRevenue.current).toBe("5.00");
  });
});

describe("BI-07: 'service' uses the session's own opening date, and states when there is none", () => {
  it("reports 'Aucun service ouvert' with no comparison when nothing is open", async () => {
    const result = await getPerformanceComparison(tenant.locationId, { period: "service" });

    expect(result.comparisonLabel).toBe("Aucun service ouvert");
    expect(result.netRevenue.current).toBe("0.00");
    expect(result.netRevenue.previous).toBeNull();
    expect(result.netRevenue.changePercent).toBeNull();
  });

  it("compares the open service to recent same-weekday days", async () => {
    const day = await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Chicha",
      price: "18.00",
      stockQuantity: 50,
    });
    await sell(context, [{ productId: product.id, quantity: 1 }], { paymentMethod: "CARD" });

    const result = await getPerformanceComparison(tenant.locationId, { period: "service" });

    expect(result.netRevenue.current).toBe("18.00");
    // Nothing backdated: all four prior same-weekday days are real zeros.
    expect(result.netRevenue.previous).toBe("0.00");
    // 18 vs a zero baseline: a percentage against zero is not a real number.
    expect(result.netRevenue.changePercent).toBeNull();
    expect(day.opened_at).toBeTruthy();
  });
});

describe("BI-07: month and year compare to the previous equivalent calendar period", () => {
  it("compares a month to the previous month, including a December-to-January rollover", async () => {
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "10.00",
      stockQuantity: 50,
    });
    await openBusinessDay(pool, tenant.locationId, "0.00");

    // January 2026 (current, in this test): one 10.00 € sale.
    const current = await sell(context, [{ productId: product.id, quantity: 1 }], {
      paymentMethod: "CARD",
    });
    await backdateOrder(current.order.id, zonedTime("Europe/Paris", 2026, 1, 15, 12));

    // December 2025 (previous): two 10.00 € sales.
    const prev1 = await sell(context, [{ productId: product.id, quantity: 1 }], {
      paymentMethod: "CARD",
    });
    await backdateOrder(prev1.order.id, zonedTime("Europe/Paris", 2025, 12, 5, 12));
    const prev2 = await sell(context, [{ productId: product.id, quantity: 1 }], {
      paymentMethod: "CARD",
    });
    await backdateOrder(prev2.order.id, zonedTime("Europe/Paris", 2025, 12, 20, 12));

    const result = await getPerformanceComparison(tenant.locationId, {
      period: "month",
      year: 2026,
      month: 1,
    });

    expect(result.netRevenue.current).toBe("10.00");
    expect(result.netRevenue.previous).toBe("20.00");
    expect(result.ordersCount.previous).toBe(2);
    expect(result.netRevenue.changePercent).toBeCloseTo(-50, 5);
    expect(result.comparisonLabel).toBe("Mois précédent (décembre 2025)");
  });

  it("compares a year to the previous year", async () => {
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "10.00",
      stockQuantity: 50,
    });
    await openBusinessDay(pool, tenant.locationId, "0.00");

    const current = await sell(context, [{ productId: product.id, quantity: 3 }], {
      paymentMethod: "CARD",
    });
    await backdateOrder(current.order.id, zonedTime("Europe/Paris", 2026, 6, 1, 12));
    const previous = await sell(context, [{ productId: product.id, quantity: 1 }], {
      paymentMethod: "CARD",
    });
    await backdateOrder(previous.order.id, zonedTime("Europe/Paris", 2025, 6, 1, 12));

    const result = await getPerformanceComparison(tenant.locationId, {
      period: "year",
      year: 2026,
    });

    expect(result.netRevenue.current).toBe("30.00");
    expect(result.netRevenue.previous).toBe("10.00");
    expect(result.comparisonLabel).toBe("Année précédente (2025)");
  });
});

describe("BI-07: a range compares to the immediately preceding period of the same length", () => {
  it("uses a preceding window matching the requested range's own duration", async () => {
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "10.00",
      stockQuantity: 50,
    });
    await openBusinessDay(pool, tenant.locationId, "0.00");

    // A 5-day current range: 10..15 Mar. One sale inside it.
    const inRange = await sell(context, [{ productId: product.id, quantity: 1 }], {
      paymentMethod: "CARD",
    });
    await backdateOrder(inRange.order.id, zonedTime("Europe/Paris", 2026, 3, 12, 12));

    // The preceding 5-day window (5..10 Mar): one sale inside it.
    const before = await sell(context, [{ productId: product.id, quantity: 2 }], {
      paymentMethod: "CARD",
    });
    await backdateOrder(before.order.id, zonedTime("Europe/Paris", 2026, 3, 7, 12));

    const from = zonedTime("Europe/Paris", 2026, 3, 10).toISOString();
    const to = zonedTime("Europe/Paris", 2026, 3, 15).toISOString();
    const result = await getPerformanceComparison(tenant.locationId, { period: "range", from, to });

    expect(result.netRevenue.current).toBe("10.00");
    expect(result.netRevenue.previous).toBe("20.00");
    expect(result.comparisonLabel).toBe("Période précédente de même durée");
  });
});

describe("BI-07: tenant isolation", () => {
  it("never mixes another establishment's sales into the comparison", async () => {
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

    const result = await getPerformanceComparison(tenant.locationId, { period: "day" });

    expect(result.netRevenue.current).toBe("0.00");
    expect(result.netRevenue.previous).toBe("0.00");
  });
});
