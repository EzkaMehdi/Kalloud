import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { createProduct, listProducts, type ProductRow } from "../../lib/repositories/products";
import { createProductWithInitialStock } from "../../lib/services/products";
import {
  getStockBalanceFromLedger,
  listStockMovements,
} from "../../lib/repositories/stock-movements";
import { openNewBusinessDay } from "../../lib/services/business-day";
import { adjustProductStock } from "../../lib/services/stock";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import { sell } from "./helpers/sales";
import type { RequestContext } from "../../lib/context";

/**
 * STK-04. The ledger primitive and the sale decrement are already covered
 * (tests/integration/stock-movements.test.ts, stock-decrement.test.ts); what
 * had no tests at all is the manual adjustment a human performs from the
 * stock screen, which until now went through an absolute write.
 */

let tenant: TestTenant;
let context: RequestContext;
let coffee: ProductRow;

async function balanceOf(productId: number): Promise<number> {
  const products = await listProducts(pool, tenant.locationId);
  return products.find((product) => product.id === productId)!.stock_quantity;
}

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Stock Adjustment Tenant");
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
  // Through the service, not the repository: STK-02 moved initial stock out
  // of the INSERT and into a real OPENING_BALANCE movement, so a product
  // created directly would have a balance the ledger cannot explain — and
  // half of what this file asserts is that the two agree.
  coffee = await createProductWithInitialStock(context, {
    categoryId: null,
    name: "Café",
    price: "10.00",
    stockQuantity: 10,
  });
});

describe("STK-04: adjusting stock by a delta", () => {
  it("applies the delta and keeps the ledger equal to the balance", async () => {
    const { balance } = await adjustProductStock(context, coffee.id, {
      delta: 6,
      type: "RECEIPT",
      reason: "Livraison du mardi",
    });

    expect(balance).toBe(16);
    expect(await balanceOf(coffee.id)).toBe(16);
    // DEC-06's materialized-balance bargain: the column is a cache of the
    // ledger, and the two must never be observable as disagreeing.
    expect(await getStockBalanceFromLedger(pool, tenant.locationId, coffee.id)).toBe(16);

    const [latest] = await listStockMovements(pool, tenant.locationId, coffee.id);
    expect(latest.quantity).toBe(6);
    expect(latest.type).toBe("RECEIPT");
    expect(latest.reason).toBe("Livraison du mardi");
    expect(latest.created_by).toBe(context.userId);
  });

  /**
   * The acceptance criterion: "aucune mise à jour absolue depuis un état
   * client périmé". This is the scenario the old endpoint got wrong.
   */
  it("composes with a sale that happened since the screen was loaded", async () => {
    // What the stock screen rendered.
    const asDisplayed = await balanceOf(coffee.id);
    expect(asDisplayed).toBe(10);

    // A sale settles while the user is deciding.
    await sell(context, [{ productId: coffee.id, quantity: 3 }], { paymentMethod: "CASH" });
    expect(await balanceOf(coffee.id)).toBe(7);

    // The user asks for 5 more units, from a screen still showing 10.
    const { balance } = await adjustProductStock(context, coffee.id, {
      delta: 5,
      type: "RECEIPT",
      reason: "Réception",
    });

    // 7 + 5. The old call sent `asDisplayed + 5` — an absolute 15 — which
    // overwrote the column and erased the sale, leaving the ledger (which
    // still had the SALE row) permanently at odds with the balance.
    expect(balance).toBe(12);
    expect(balance).not.toBe(asDisplayed + 5);
    expect(await getStockBalanceFromLedger(pool, tenant.locationId, coffee.id)).toBe(12);
  });

  it("refuses an outflow that would take the balance below zero", async () => {
    await expect(
      adjustProductStock(context, coffee.id, {
        delta: -12,
        type: "LOSS",
        reason: "Casse",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Nothing applied and nothing recorded: the refusal is whole.
    expect(await balanceOf(coffee.id)).toBe(10);
    const movements = await listStockMovements(pool, tenant.locationId, coffee.id);
    expect(movements.every((movement) => movement.type !== "LOSS")).toBe(true);
  });

  it("lets a CORRECTION land below zero, because DEC-06 says it may", async () => {
    // "Une correction de rattrapage documentée" — the exception, and the
    // reason is mandatory precisely so it is documented.
    const { balance } = await adjustProductStock(context, coffee.id, {
      delta: -12,
      type: "CORRECTION",
      reason: "Rattrapage après inventaire : stock initial erroné",
    });

    expect(balance).toBe(-2);
    expect(await getStockBalanceFromLedger(pool, tenant.locationId, coffee.id)).toBe(-2);
  });

  it("refuses to touch a product that is not this establishment's", async () => {
    const other = await createTestTenant(pool, "Other Tenant");
    const theirs = await createProduct(pool, other.locationId, {
      categoryId: null,
      name: "Leur produit",
      price: "5.00",
      stockQuantity: 5,
    });

    await expect(
      adjustProductStock(context, theirs.id, { delta: 1, type: "RECEIPT", reason: "Tentative" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  /**
   * Two deltas compose; two absolute writes do not. Under the old endpoint
   * these two requests would both have computed a total from the same
   * starting balance and the second would have overwritten the first — one
   * of the two receipts silently lost.
   */
  it("applies both of two simultaneous adjustments", async () => {
    await Promise.all([
      adjustProductStock(context, coffee.id, { delta: 5, type: "RECEIPT", reason: "Livraison A" }),
      adjustProductStock(context, coffee.id, { delta: 4, type: "RECEIPT", reason: "Livraison B" }),
    ]);

    expect(await balanceOf(coffee.id)).toBe(19);
    expect(await getStockBalanceFromLedger(pool, tenant.locationId, coffee.id)).toBe(19);
    const movements = await listStockMovements(pool, tenant.locationId, coffee.id);
    expect(movements.filter((movement) => movement.type === "RECEIPT")).toHaveLength(2);
  });

  it("audits the adjustment with what it moved and where it landed", async () => {
    await adjustProductStock(context, coffee.id, {
      delta: -2,
      type: "LOSS",
      reason: "Verre cassé",
    });

    const { rows } = await pool.query<{
      action: string;
      before_data: { stockQuantity: number };
      after_data: { delta: number; type: string; stockQuantity: number };
    }>(
      "SELECT action, before_data, after_data FROM audit_events WHERE location_id = $1 AND action = 'stock.adjust'",
      [tenant.locationId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].before_data.stockQuantity).toBe(10);
    expect(rows[0].after_data).toMatchObject({ delta: -2, type: "LOSS", stockQuantity: 8 });
  });
});
