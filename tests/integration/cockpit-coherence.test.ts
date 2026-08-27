import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { openBusinessDay } from "../../lib/repositories/business-days";
import { createProduct } from "../../lib/repositories/products";
import { getCashReconciliation } from "../../lib/services/cash-reconciliation";
import { getDashboardSummary } from "../../lib/services/dashboard";
import { getMetrics } from "../../lib/services/metrics";
import { getPerformanceComparison } from "../../lib/services/performance";
import { refundOrder } from "../../lib/services/refunds";
import { getSalesTrendsForPeriod } from "../../lib/services/trends";
import { parseOrThrow } from "../../lib/validation/parse";
import { refundOrderSchema } from "../../lib/validation/schemas";
import { sell } from "./helpers/sales";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * BI-14's acceptance, verbatim: "les interactions du cockpit expliquent les
 * totaux [...]" — and its livrable names "widgets" in the plural. Every
 * widget already has its own correctness test, against its own fixture, in
 * its own file (`BI-01`/`BI-07`/`BI-08`/`BI-09` and `BI-13`'s own
 * reconciliation-against-raw-tables work). None of that proves the property
 * this file is for: that two *different* widgets, reading the *same*
 * establishment through two *different* service-layer calls, report the
 * same number for the same period — a manager comparing the KPI card
 * against the comparison block, or the cash-reconciliation block against
 * the dashboard, must never see two different figures for what looks like
 * one question. `getExpectedCash` (`cashSales`) and `getBusinessDaySummary`
 * (`cash_revenue`) are two independently-written SQL queries computing the
 * same "CHARGE minus REFUND, cash method, this business day" — provably
 * equal by inspection, but never asserted equal until now.
 */

let tenant: TestTenant;
let context: RequestContext;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Cockpit Coherence Tenant");
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

describe("BI-14: the dashboard, the metrics envelope and the comparison block agree", () => {
  it("report the identical CA net, orders count and panier moyen for the open service", async () => {
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "10.00",
      stockQuantity: 50,
    });
    await sell(context, [{ productId: product.id, quantity: 1 }], { paymentMethod: "CASH" });
    await sell(context, [{ productId: product.id, quantity: 2 }], { paymentMethod: "CARD" });

    // "day" here is the old, still-live dashboard route's own name for the
    // open business day (BI-01's original naming, unchanged since — see
    // lib/services/dashboard.ts's own note); "service" is BI-03's
    // correctly-named equivalent. Both must describe the exact same window.
    const dashboard = await getDashboardSummary(tenant.locationId, { period: "day" });
    const metrics = await getMetrics(tenant.locationId, { period: "service" });
    const comparison = await getPerformanceComparison(tenant.locationId, { period: "service" });

    expect(dashboard.revenue).toBe("30.00");
    expect(metrics.netRevenue.value).toBe(dashboard.revenue);
    expect(comparison.netRevenue.current).toBe(dashboard.revenue);

    expect(dashboard.orders_count).toBe(2);
    expect(metrics.ordersCount.value).toBe(dashboard.orders_count);
    expect(comparison.ordersCount.current).toBe(dashboard.orders_count);

    expect(dashboard.average_basket).toBe("15.00");
    expect(metrics.averageBasket.value).toBe(dashboard.average_basket);
    expect(comparison.averageBasket.current).toBe(dashboard.average_basket);
  });
});

describe("BI-14: the cash-reconciliation block and the dashboard agree on cash revenue", () => {
  it("CashReconciliationBlock's own cashSales equals the dashboard's own cash_revenue", async () => {
    await openBusinessDay(pool, tenant.locationId, "50.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Thé",
      price: "8.00",
      stockQuantity: 50,
    });
    await sell(context, [{ productId: product.id, quantity: 1 }], { paymentMethod: "CASH" });
    const refunded = await sell(context, [{ productId: product.id, quantity: 1 }], {
      paymentMethod: "CASH",
    });
    await refundOrder(
      context,
      refunded.order.id,
      parseOrThrow(refundOrderSchema, { reason: "Erreur de préparation" }),
    );

    const dashboard = await getDashboardSummary(tenant.locationId, { period: "day" });
    const reconciliation = await getCashReconciliation(tenant.locationId);

    // 8.00 kept, 8.00 charged then refunded → net 8.00 in cash — two
    // independently-written SQL formulas (getBusinessDaySummary's
    // cash_revenue, getExpectedCash's cash_sales), same refund included,
    // same answer.
    expect(dashboard.cash_revenue).toBe("8.00");
    expect(reconciliation.cashSales).toBe(dashboard.cash_revenue);
    expect(reconciliation.status).toBe("open");
  });
});

describe("BI-14: the trends drill-down explains the top-line total, when there is nothing to reconcile away", () => {
  it("the sum of every product's own revenue equals CA net, with no refund in the way", async () => {
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const coffee = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "5.00",
      stockQuantity: 50,
    });
    const tea = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Thé",
      price: "7.00",
      stockQuantity: 50,
    });
    await sell(context, [{ productId: coffee.id, quantity: 2 }], { paymentMethod: "CASH" }); // 10.00
    await sell(context, [{ productId: tea.id, quantity: 1 }], { paymentMethod: "CARD" }); // 7.00

    const metrics = await getMetrics(tenant.locationId, { period: "service" });
    const trends = await getSalesTrendsForPeriod(tenant.locationId, { period: "service" });

    expect(trends).not.toBeNull();
    const drillDownTotal = trends!.byProduct.reduce((sum, row) => sum + Number(row.revenue), 0);
    expect(drillDownTotal.toFixed(2)).toBe(metrics.netRevenue.value);
    expect(metrics.netRevenue.value).toBe("17.00");
  });

  it("a refund is exactly the one case where the drill-down's sum and CA net honestly diverge", async () => {
    // BI-08's own documented choice: byProduct/byCategory count every line
    // of a PAID *or* REFUNDED order at its full original amount (a partial
    // refund is an amount, never a per-line adjustment — ORD-10), while CA
    // net nets the refund against the order. Both are correct answers to
    // different questions; this proves the gap is real and exactly the
    // refunded amount, not a silent, unexplained mismatch a manager would
    // have no way to account for.
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Chicha",
      price: "20.00",
      stockQuantity: 50,
    });
    const sale = await sell(context, [{ productId: product.id, quantity: 1 }], {
      paymentMethod: "CARD",
    });
    await refundOrder(
      context,
      sale.order.id,
      parseOrThrow(refundOrderSchema, { reason: "Client mécontent", amount: "8.00" }),
    );

    const metrics = await getMetrics(tenant.locationId, { period: "service" });
    const trends = await getSalesTrendsForPeriod(tenant.locationId, { period: "service" });

    expect(metrics.netRevenue.value).toBe("12.00"); // 20.00 − 8.00, order-level net
    const drillDownTotal = trends!.byProduct.reduce((sum, row) => sum + Number(row.revenue), 0);
    expect(drillDownTotal.toFixed(2)).toBe("20.00"); // line-level, refund not netted
    // The gap is exactly the refunded amount — traceable, not arbitrary.
    expect((drillDownTotal - Number(metrics.netRevenue.value)).toFixed(2)).toBe("8.00");
  });
});
