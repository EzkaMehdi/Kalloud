import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { openBusinessDay } from "../../lib/repositories/business-days";
import { createProduct } from "../../lib/repositories/products";
import { getMetrics } from "../../lib/services/metrics";
import { refundOrder } from "../../lib/services/refunds";
import { cancelTicket, openDirectSaleTicket } from "../../lib/services/tickets";
import { parseOrThrow } from "../../lib/validation/parse";
import { refundOrderSchema } from "../../lib/validation/schemas";
import { sell } from "./helpers/sales";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * BI-13's acceptance, verbatim: "les totaux fondamentaux se réconcilient
 * avec commandes, paiements, caisse et stock." `lib/services/metrics.ts`'s
 * own header names exactly what its own tests deliberately deferred:
 * "exhaustive fixtures, refunds et timezone edge cases are BI-13's own
 * task, not duplicated in advance."
 *
 * Audit before writing anything, the same discipline `CASH-08` (this
 * project's own precedent for a reconciliation ticket) applied to its own
 * livrable — three of the four domains this acceptance names are already
 * proven elsewhere, and are deliberately NOT re-tested here:
 *
 * - **Caisse** (espèces attendues, écart) — `CASH-08`'s own
 *   `tests/integration/cash-reconciliation.test.ts` already reconstructs
 *   the drawer from raw `payments`/`cash_movements`/`business_days`,
 *   including a refund, midnight, and two different timezones. Redoing
 *   that work here would be a second, competing proof of the same formula.
 * - **Stock** — `STK-09`'s own
 *   `tests/integration/stock-ledger-invariant.test.ts` already proves
 *   `products.stock_quantity` equals the sum of its own `stock_movements`
 *   ledger, globally, after a workload mixing every write path. `BI-01`'s
 *   own `metrics.test.ts` already proves the alert *counts* reconcile with
 *   that (already-trusted) column.
 * - **Formulas and periods in the abstract** — `BI-01`/`BI-03`'s own tests
 *   already prove every period kind resolves to the right SQL bounds and
 *   that revenue/orders/basket reconcile with a couple of plain sales.
 *
 * What was genuinely left, and is what this file covers:
 *
 * 1. **Ventes et paiements**, reconstructed from the raw ledger the way an
 *    accountant would — not re-asserting `getRevenueBetween`'s own output,
 *    a second formula written independently in this file — across cash,
 *    card, a full refund and a partial one in the same fixture.
 * 2. **Remboursements**: no existing test on `getMetrics` puts a refund in
 *    front of it at all. A full refund's specific effect (order still
 *    counted, its own revenue netted to zero) is isolated on its own.
 * 3. **Fuseaux**, for period *boundaries* specifically — `metrics.test.ts`'s
 *    own timezone case only checks that the `timezone` field is reported
 *    correctly, never that a `day`/`month` boundary is computed correctly
 *    in a zone far from UTC. The same absolute instant is shown landing in
 *    two different calendar periods for two establishments in different
 *    timezones, the same proof `CASH-08` used for the drawer.
 */

let tenant: TestTenant;
let context: RequestContext;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Reconciliation Tenant");
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

async function setPaidAt(orderId: number, at: string): Promise<void> {
  await pool.query("UPDATE orders SET paid_at = $1 WHERE id = $2", [at, orderId]);
}

describe("BI-13: CA net, commandes and panier moyen reconcile with the raw ledger", () => {
  it("reconstructs the open service's figures from payments/orders directly, a full and a partial refund included", async () => {
    const day = await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "20.00",
      stockQuantity: 50,
    });

    await sell(context, [{ productId: product.id, quantity: 1 }], { paymentMethod: "CASH" }); // 20.00, stays PAID

    const fullyRefunded = await sell(context, [{ productId: product.id, quantity: 1 }], {
      paymentMethod: "CARD",
    }); // 10.00... wait price is 20.00 — see below
    await refundOrder(
      context,
      fullyRefunded.order.id,
      parseOrThrow(refundOrderSchema, { reason: "Produit indisponible" }),
    ); // fully refunded → status REFUNDED, net 0.00, still counted

    const partiallyRefunded = await sell(context, [{ productId: product.id, quantity: 1 }], {
      paymentMethod: "CASH",
    }); // 20.00
    await refundOrder(
      context,
      partiallyRefunded.order.id,
      parseOrThrow(refundOrderSchema, { reason: "Remise commerciale", amount: "8.00" }),
    ); // net 12.00, stays PAID

    // Never paid: a cancelled ticket must not appear on either side of the
    // reconciliation. `sell()` always pays, so this one is opened and
    // cancelled directly instead.
    const cancelled = await openDirectSaleTicket(context);
    await cancelTicket(context, cancelled.id, { reason: "Client parti" });

    const result = await getMetrics(tenant.locationId, { period: "service" });

    // Rebuilt independently from payments/orders, the same shape
    // getRevenueBetween uses but written by hand here rather than imported
    // — the point of a reconciliation test is a second, competing formula,
    // not a second call to the first one.
    const { rows } = await pool.query<{
      revenue: string;
      orders_count: number;
      average_basket: string;
    }>(
      `WITH net AS (
         SELECT SUM(CASE WHEN p.type = 'CHARGE' THEN p.amount ELSE -p.amount END) AS revenue
         FROM payments p
         JOIN orders o ON o.id = p.order_id AND o.location_id = p.location_id
         WHERE o.location_id = $1 AND o.business_day_id = $2
       ),
       counted AS (
         SELECT COUNT(*)::INT AS orders_count FROM orders
         WHERE location_id = $1 AND business_day_id = $2 AND status IN ('PAID', 'REFUNDED')
       )
       SELECT
         COALESCE((SELECT revenue FROM net), 0)::DECIMAL(10, 2) AS revenue,
         (SELECT orders_count FROM counted) AS orders_count,
         CASE
           WHEN (SELECT orders_count FROM counted) = 0 THEN 0
           ELSE COALESCE((SELECT revenue FROM net), 0) / (SELECT orders_count FROM counted)
         END::DECIMAL(10, 2) AS average_basket`,
      [tenant.locationId, day.id],
    );
    const rebuilt = rows[0];

    // 20.00 (kept) + 0.00 (fully refunded) + 12.00 (20.00 − 8.00 partial) = 32.00
    expect(rebuilt.revenue).toBe("32.00");
    expect(rebuilt.orders_count).toBe(3);
    // 32.00 / 3 = 10.666… → 10.67 (SQL DECIMAL(10,2) rounding, the same
    // cast production's own formula applies).
    expect(rebuilt.average_basket).toBe("10.67");

    expect(result.netRevenue.value).toBe(rebuilt.revenue);
    expect(result.ordersCount.value).toBe(rebuilt.orders_count);
    expect(result.averageBasket.value).toBe(rebuilt.average_basket);
  });
});

describe("BI-13: a refund's effect on the derived panier moyen, isolated", () => {
  it("a full refund keeps the order counted but nets its own revenue to zero", async () => {
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Chicha",
      price: "30.00",
      stockQuantity: 20,
    });

    await sell(context, [{ productId: product.id, quantity: 1 }], { paymentMethod: "CARD" }); // 30.00
    const refunded = await sell(context, [{ productId: product.id, quantity: 1 }], {
      paymentMethod: "CARD",
    }); // 30.00, refunded fully below

    const before = await getMetrics(tenant.locationId, { period: "service" });
    expect(before.netRevenue.value).toBe("60.00");
    expect(before.ordersCount.value).toBe(2);
    expect(before.averageBasket.value).toBe("30.00");

    await refundOrder(
      context,
      refunded.order.id,
      parseOrThrow(refundOrderSchema, { reason: "Erreur de commande" }),
    );

    const after = await getMetrics(tenant.locationId, { period: "service" });
    // DEC-09's own formula, applied literally: the refunded order is not
    // dropped from "nombre de commandes" (still status REFUNDED, not
    // CANCELLED) — only its own contribution to CA net changes.
    expect(after.ordersCount.value).toBe(2);
    expect(after.netRevenue.value).toBe("30.00");
    // 30.00 / 2, not 30.00 / 1 — a naive "average of what is still owed"
    // would divide by the surviving order alone and answer 30.00 again,
    // masking the refund entirely.
    expect(after.averageBasket.value).toBe("15.00");
  });
});

describe("BI-13: period boundaries are computed in the establishment's own timezone, not UTC", () => {
  it("the same instant is January for a Paris establishment and February for an Auckland one", async () => {
    // January: Europe/Paris is CET (UTC+1, no DST); Pacific/Auckland is
    // NZDT (UTC+13, southern-hemisphere summer). At 2026-01-31T14:00:00Z,
    // Paris reads 2026-01-31 15:00 (still January); Auckland reads
    // 2026-02-01 03:00 (already February) — the same instant, two
    // different calendar months, purely a function of each
    // establishment's own configured timezone.
    const instant = "2026-01-31T14:00:00Z";

    const auckland = tenant;
    await pool.query("UPDATE location_settings SET timezone = $1 WHERE location_id = $2", [
      "Pacific/Auckland",
      auckland.locationId,
    ]);
    const paris = await createTestTenant(pool, "Paris Tenant");
    await pool.query("UPDATE location_settings SET timezone = $1 WHERE location_id = $2", [
      "Europe/Paris",
      paris.locationId,
    ]);
    const parisOwner = await createTestUser(pool, paris, "OWNER");
    const parisContext: RequestContext = {
      ...context,
      userId: parisOwner.userId,
      userEmail: parisOwner.email,
      organizationId: paris.organizationId,
      locationId: paris.locationId,
    };

    await openBusinessDay(pool, auckland.locationId, "0.00");
    await openBusinessDay(pool, paris.locationId, "0.00");
    const aucklandProduct = await createProduct(pool, auckland.locationId, {
      categoryId: null,
      name: "Café",
      price: "10.00",
      stockQuantity: 10,
    });
    const parisProduct = await createProduct(pool, paris.locationId, {
      categoryId: null,
      name: "Café",
      price: "10.00",
      stockQuantity: 10,
    });

    const aucklandSale = await sell(context, [{ productId: aucklandProduct.id, quantity: 1 }], {
      paymentMethod: "CASH",
    });
    await setPaidAt(aucklandSale.order.id, instant);
    const parisSale = await sell(parisContext, [{ productId: parisProduct.id, quantity: 1 }], {
      paymentMethod: "CASH",
    });
    await setPaidAt(parisSale.order.id, instant);

    // Month boundary: Auckland's sale belongs to February, not January.
    const aucklandJanuary = await getMetrics(auckland.locationId, {
      period: "month",
      year: 2026,
      month: 1,
    });
    expect(aucklandJanuary.netRevenue.value).toBe("0.00");
    const aucklandFebruary = await getMetrics(auckland.locationId, {
      period: "month",
      year: 2026,
      month: 2,
    });
    expect(aucklandFebruary.netRevenue.value).toBe("10.00");

    // The same instant, read in Paris's own timezone, is still January.
    const parisJanuary = await getMetrics(paris.locationId, {
      period: "month",
      year: 2026,
      month: 1,
    });
    expect(parisJanuary.netRevenue.value).toBe("10.00");

    // Day boundary, same instant: February 1st in Auckland, still
    // January 31st in Paris.
    const aucklandFeb1 = await getMetrics(auckland.locationId, {
      period: "day",
      year: 2026,
      month: 2,
      day: 1,
    });
    expect(aucklandFeb1.netRevenue.value).toBe("10.00");
    const parisJan31 = await getMetrics(paris.locationId, {
      period: "day",
      year: 2026,
      month: 1,
      day: 31,
    });
    expect(parisJan31.netRevenue.value).toBe("10.00");
  });
});
