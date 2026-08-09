import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import {
  getBusinessDaySummary,
  getRevenueBetween,
  openBusinessDay,
} from "../../lib/repositories/business-days";
import { getCashBalance } from "../../lib/repositories/cash-movements";
import { listOrders, nextOrderNumber } from "../../lib/repositories/orders";
import { createProduct } from "../../lib/repositories/products";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { sell } from "./helpers/sales";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * ORD-01's acceptance criterion: the canonical OPEN/PAID/CANCELLED/REFUNDED
 * model replaces PENDING/COMPLETED, with a unique order number per
 * establishment and the constraints that guarantee both. These tests prove
 * the migration and the repository/service changes together — not just that
 * a row can be inserted, but that the invariants a bad migration could
 * silently drop (uniqueness, the CHECK, and the three read paths that used
 * to filter on the old 'COMPLETED'/'closed_at' names) actually hold.
 */

let tenant: TestTenant;
let context: RequestContext;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Orders Tenant");
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

/**
 * A completed cash sale. ORD-07 made every sale settle a ticket, so this
 * opens one first; `cashAmount` is no longer sent at all, since SALE-03
 * derives a CASH sale's amount from the server-computed total and ignores
 * whatever a client would have proposed.
 */
async function checkout(productId: number, quantity: number) {
  return sell(context, [{ productId, quantity }], { paymentMethod: "CASH" });
}

describe("ORD-01: canonical order lifecycle", () => {
  it("records a checkout as PAID, with a real order number and author, never a fabricated fiscal snapshot", async () => {
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Chicha classique",
      price: "15.00",
      stockQuantity: 10,
    });

    await checkout(product.id, 1);

    const [order] = await listOrders(pool, tenant.locationId);
    expect(order.status).toBe("PAID");
    expect(order.order_number).toBe(1);
    expect(order.created_by).toBe(context.userId);
    expect(order.paid_at).not.toBeNull();
    expect(order.cancelled_at).toBeNull();
    expect(order.refunded_at).toBeNull();
    // SALE-03: a real fiscal snapshot now, not a fabricated one — 15.00 €
    // TTC at the establishment's default 20% rate (location_settings,
    // migrations/0002) is 12.50 € HT + 2.50 € tax, per DEC-05's extraction
    // formula (see tests/integration/checkout-tax.test.ts for the full
    // proof of that computation; this test only needs to confirm the order
    // row actually carries it).
    expect(order.subtotal_amount).toBe("12.50");
    expect(order.tax_amount).toBe("2.50");
  });

  it("gives every order in a location a distinct, increasing number, starting at 1", async () => {
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Thé à la menthe",
      price: "4.00",
      stockQuantity: 10,
    });

    await checkout(product.id, 1);
    await checkout(product.id, 1);
    await checkout(product.id, 1);

    const orders = await listOrders(pool, tenant.locationId);
    const numbers = orders.map((order) => order.order_number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3]);
  });

  it("lets two different establishments both start their own numbering at 1, without colliding", async () => {
    const otherTenant = await createTestTenant(pool, "Other Tenant");

    const first = await nextOrderNumber(pool, tenant.locationId);
    const second = await nextOrderNumber(pool, otherTenant.locationId);

    expect(first).toBe(1);
    expect(second).toBe(1);
  });

  it("hands out distinct order numbers to two genuinely concurrent checkouts on different products", async () => {
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const productA = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Produit A",
      price: "5.00",
      stockQuantity: 10,
    });
    const productB = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Produit B",
      price: "7.00",
      stockQuantity: 10,
    });

    // Different products so the two transactions do not already serialise
    // on lockProductsForSale's FOR UPDATE — this isolates the
    // order_number_counters upsert itself as what prevents the collision,
    // per its doc comment in lib/repositories/orders.ts.
    const [resultA, resultB] = await Promise.all([
      checkout(productA.id, 1),
      checkout(productB.id, 1),
    ]);

    expect(resultA.order.order_number).not.toBe(resultB.order.order_number);
    expect([resultA.order.order_number, resultB.order.order_number].sort()).toEqual([1, 2]);
  });

  it("rejects a status outside OPEN/PAID/CANCELLED/REFUNDED at the database level", async () => {
    const businessDay = await openBusinessDay(pool, tenant.locationId, "0.00");
    await expect(
      pool.query(
        `INSERT INTO orders (location_id, business_day_id, order_number, created_by, status, total_amount)
         VALUES ($1, $2, 1, $3, 'PENDING', 5.00)`,
        [tenant.locationId, businessDay.id, context.userId],
      ),
    ).rejects.toThrow(/orders_status_check/);
  });

  it("rejects a duplicate order number within the same establishment at the database level", async () => {
    const businessDay = await openBusinessDay(pool, tenant.locationId, "0.00");
    await pool.query(
      `INSERT INTO orders (location_id, business_day_id, order_number, created_by, status, total_amount)
       VALUES ($1, $2, 1, $3, 'PAID', 5.00)`,
      [tenant.locationId, businessDay.id, context.userId],
    );
    await expect(
      pool.query(
        `INSERT INTO orders (location_id, business_day_id, order_number, created_by, status, total_amount)
         VALUES ($1, $2, 1, $3, 'PAID', 5.00)`,
        [tenant.locationId, businessDay.id, context.userId],
      ),
    ).rejects.toThrow(/orders_location_order_number_unique/);
  });

  /**
   * Regression proof for the COMPLETED -> PAID / closed_at -> paid_at
   * rename: business-days.ts and cash-movements.ts read orders through
   * these three functions and used to filter on the names the old prototype
   * status used. A test that only checks performCheckout's own return value
   * would not catch a forgotten call site here — it would keep compiling,
   * and would just silently sum zero rows.
   */
  it("keeps revenue and cash balance reporting working after the COMPLETED->PAID, closed_at->paid_at rename", async () => {
    const businessDay = await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "2.50",
      stockQuantity: 10,
    });

    await checkout(product.id, 2);

    const summary = await getBusinessDaySummary(pool, tenant.locationId, businessDay.id);
    expect(summary.revenue).toBe("5.00");
    expect(Number(summary.orders_count)).toBe(1);

    // getCashBalance sums cash_movements (OPENING/IN/OUT) plus PAID orders'
    // cash_amount — it does not read business_days.opening_cash (that
    // formula is CASH-01's job, see the doc comment on getCashBalance).
    // No cash_movements exist here, so the balance is exactly the sale.
    const balance = await getCashBalance(pool, tenant.locationId, businessDay.id);
    expect(balance).toBe("5.00");

    const now = new Date();
    const from = new Date(now.getTime() - 60_000);
    const to = new Date(now.getTime() + 60_000);
    const revenueBetween = await getRevenueBetween(pool, tenant.locationId, from, to);
    expect(revenueBetween.revenue).toBe("5.00");
  });
});
