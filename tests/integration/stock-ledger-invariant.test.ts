import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { createProduct, listProducts, type ProductRow } from "../../lib/repositories/products";
import { openNewBusinessDay } from "../../lib/services/business-day";
import { createProductWithInitialStock } from "../../lib/services/products";
import { refundOrder } from "../../lib/services/refunds";
import { adjustProductStock, recordStockCount } from "../../lib/services/stock";
import { parseOrThrow } from "../../lib/validation/parse";
import { refundOrderSchema } from "../../lib/validation/schemas";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import { sell } from "./helpers/sales";
import type { RequestContext } from "../../lib/context";

/**
 * STK-09's acceptance criterion, verbatim: "le solde courant égale toujours
 * la somme des mouvements."
 *
 * The individual operations each assert this for the one product they touch
 * (STK-01/03/04/07). What no test stated is the invariant as an invariant —
 * over *every* product, after a workload that mixes every write path there
 * is. A per-operation assertion proves each operation keeps the books; only
 * a global one proves they keep them *together*, which is where a missed
 * lock or a write outside `recordStockMovement` would show.
 *
 * Sale and adjustment concurrency are covered per-operation elsewhere
 * (two decrements racing, two adjustments racing). What is new here is
 * concurrency *across* operations — a till selling while a manager counts —
 * which is the race a real service actually produces.
 */

let tenant: TestTenant;
let context: RequestContext;
let coffee: ProductRow;
let tea: ProductRow;

/**
 * DEC-06's materialized-balance bargain, checked for the whole
 * establishment: `products.stock_quantity` is a cache of the ledger, so any
 * product where the two disagree is a corrupted book, not a rounding
 * detail. Returns the offenders so a failure names them.
 */
async function ledgerDiscrepancies(locationId: number) {
  const { rows } = await pool.query<{ name: string; balance: number; ledger: number }>(
    `SELECT p.name,
            p.stock_quantity AS balance,
            COALESCE((SELECT SUM(m.quantity) FROM stock_movements m
                       WHERE m.product_id = p.id AND m.location_id = p.location_id), 0)::INT AS ledger
       FROM products p
      WHERE p.location_id = $1
        AND p.stock_quantity <> COALESCE((SELECT SUM(m.quantity) FROM stock_movements m
                                           WHERE m.product_id = p.id AND m.location_id = p.location_id), 0)`,
    [locationId],
  );
  return rows;
}

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Ledger Invariant Tenant");
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
  await openNewBusinessDay(context, 0);
  coffee = await createProductWithInitialStock(context, {
    categoryId: null,
    name: "Café",
    price: "10.00",
    stockQuantity: 40,
  });
  tea = await createProductWithInitialStock(context, {
    categoryId: null,
    name: "Thé",
    price: "5.00",
    stockQuantity: 25,
  });
});

describe("STK-09: the balance always equals the sum of the movements", () => {
  it("holds after every kind of write, mixed together", async () => {
    // A product with no starting stock records no OPENING_BALANCE (STK-02),
    // so it starts at 0 on both sides — included precisely because "no
    // movements at all" is the edge the invariant must also survive.
    const water = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Eau",
      price: "2.00",
    });

    await sell(context, [{ productId: coffee.id, quantity: 4 }], { paymentMethod: "CASH" });
    const refunded = await sell(context, [{ productId: tea.id, quantity: 3 }], {
      paymentMethod: "CARD",
    });
    await refundOrder(
      context,
      refunded.order.id,
      parseOrThrow(refundOrderSchema, { reason: "Client mécontent" }),
    );
    await adjustProductStock(context, coffee.id, {
      delta: 12,
      type: "RECEIPT",
      reason: "Livraison",
    });
    await adjustProductStock(context, tea.id, { delta: -2, type: "LOSS", reason: "Casse" });
    await adjustProductStock(context, coffee.id, {
      delta: -1,
      type: "CORRECTION",
      reason: "Écart constaté",
    });
    await recordStockCount(context, tea.id, 20, "Inventaire");
    await recordStockCount(context, coffee.id, 47, "Inventaire"); // conforme, aucun mouvement

    expect(await ledgerDiscrepancies(tenant.locationId)).toEqual([]);

    // And the figures are the ones the sequence implies, so the invariant is
    // not holding merely because nothing moved.
    const products = await listProducts(pool, tenant.locationId);
    const balanceOf = (id: number) => products.find((product) => product.id === id)!.stock_quantity;
    expect(balanceOf(coffee.id)).toBe(47); // 40 − 4 + 12 − 1
    expect(balanceOf(tea.id)).toBe(20); // 25 − 3 + 3 − 2, puis comptage à 20
    expect(balanceOf(water.id)).toBe(0);
  });

  it("holds when a sale and an adjustment race for the same product", async () => {
    // The realistic race: the till settles a sale while a manager records a
    // delivery on the same item. Both must land, and the books must close.
    await Promise.all([
      sell(context, [{ productId: coffee.id, quantity: 5 }], { paymentMethod: "CASH" }),
      adjustProductStock(context, coffee.id, {
        delta: 10,
        type: "RECEIPT",
        reason: "Livraison concurrente",
      }),
    ]);

    expect(await ledgerDiscrepancies(tenant.locationId)).toEqual([]);
    const products = await listProducts(pool, tenant.locationId);
    expect(products.find((product) => product.id === coffee.id)!.stock_quantity).toBe(45);
  });

  /**
   * A count read its theoretical balance under the same lock the correction
   * is written with (STK-07). Racing it against a sale is what proves that:
   * whichever wins, the count lands on a balance that was true when it was
   * read, and the ledger still reconciles.
   */
  it("holds when a sale and a physical count race", async () => {
    const outcomes = await Promise.allSettled([
      sell(context, [{ productId: tea.id, quantity: 5 }], { paymentMethod: "CASH" }),
      recordStockCount(context, tea.id, 18, "Comptage pendant le service"),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);

    expect(await ledgerDiscrepancies(tenant.locationId)).toEqual([]);

    // The count is authoritative for the moment it ran, so the end balance
    // is either 18 (count last) or 13 (sale last) — never a figure that
    // belongs to neither ordering.
    const products = await listProducts(pool, tenant.locationId);
    expect([18, 13]).toContain(products.find((product) => product.id === tea.id)!.stock_quantity);
  });

  it("holds under a burst of concurrent writes on the same product", async () => {
    await Promise.all([
      adjustProductStock(context, coffee.id, { delta: 3, type: "RECEIPT", reason: "A" }),
      adjustProductStock(context, coffee.id, { delta: -2, type: "LOSS", reason: "B" }),
      adjustProductStock(context, coffee.id, { delta: 5, type: "RETURN", reason: "C" }),
      sell(context, [{ productId: coffee.id, quantity: 2 }], { paymentMethod: "CASH" }),
      sell(context, [{ productId: coffee.id, quantity: 1 }], { paymentMethod: "CARD" }),
    ]);

    expect(await ledgerDiscrepancies(tenant.locationId)).toEqual([]);
    const products = await listProducts(pool, tenant.locationId);
    // 40 + 3 − 2 + 5 − 2 − 1: every write landed exactly once, which is the
    // other half of the invariant — no lost update, no double application.
    expect(products.find((product) => product.id === coffee.id)!.stock_quantity).toBe(43);
  });
});

/**
 * The check above returns "no discrepancies" for every scenario, which is
 * only reassuring if it can return something else. Corrupting a balance the
 * way a stray `UPDATE products SET stock_quantity` outside
 * `recordStockMovement` would is the one case the whole file exists to
 * catch — so it is exercised rather than assumed.
 */
describe("STK-09: the invariant check detects a corrupted balance", () => {
  it("names the product whose column and ledger disagree", async () => {
    expect(await ledgerDiscrepancies(tenant.locationId)).toEqual([]);

    // Exactly the write STK-04 removed the endpoint for: an absolute
    // overwrite that leaves the ledger untouched.
    await pool.query("UPDATE products SET stock_quantity = 999 WHERE id = $1", [coffee.id]);

    const offenders = await ledgerDiscrepancies(tenant.locationId);
    expect(offenders).toEqual([{ name: "Café", balance: 999, ledger: 40 }]);
  });
});
