import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { NotFoundError } from "../../lib/errors";
import { listProducts, type ProductRow } from "../../lib/repositories/products";
import { listStockCounts } from "../../lib/repositories/stock-counts";
import {
  getStockBalanceFromLedger,
  listStockMovements,
} from "../../lib/repositories/stock-movements";
import { openNewBusinessDay } from "../../lib/services/business-day";
import { createProductWithInitialStock } from "../../lib/services/products";
import { recordStockCount } from "../../lib/services/stock";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import { sell } from "./helpers/sales";
import type { RequestContext } from "../../lib/context";

/**
 * STK-07/DEC-06: "l'utilisateur saisit la quantité comptée pour un produit,
 * le système calcule l'écart avec le solde théorique et génère un mouvement
 * CORRECTION référençant l'inventaire, avec auteur et horodatage."
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
  tenant = await createTestTenant(pool, "Stock Count Tenant");
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
    stockQuantity: 10,
  });
});

describe("STK-07: counting a product", () => {
  it("records the five figures the criterion asks be consultable", async () => {
    await recordStockCount(context, coffee.id, 8, "Inventaire du lundi");

    const [entry] = await listStockCounts(pool, tenant.locationId, coffee.id);
    expect(entry.theoretical_quantity).toBe(10); // stock avant
    expect(entry.counted_quantity).toBe(8); // compté
    expect(entry.difference).toBe(-2); // différence
    expect(entry.counted_by_name).toBe("OWNER Test User"); // auteur
    expect(entry.created_at).toBeTruthy(); // date
  });

  it("brings the balance to what was counted, whichever way the écart goes", async () => {
    await recordStockCount(context, coffee.id, 7, null);
    expect(await balanceOf(coffee.id)).toBe(7);
    expect(await getStockBalanceFromLedger(pool, tenant.locationId, coffee.id)).toBe(7);

    // Counting up works the same: a shelf holding more than the system
    // believed is as much an écart as one holding less.
    await recordStockCount(context, coffee.id, 12, null);
    expect(await balanceOf(coffee.id)).toBe(12);
    expect(await getStockBalanceFromLedger(pool, tenant.locationId, coffee.id)).toBe(12);
  });

  it("links the correction and the count to each other", async () => {
    const { count } = await recordStockCount(context, coffee.id, 6, "Écart constaté");

    const [movement] = await listStockMovements(pool, tenant.locationId, coffee.id);
    expect(movement.type).toBe("CORRECTION");
    expect(movement.quantity).toBe(-4);
    // The movement points at the count...
    expect(movement.reference_type).toBe("stock_count");
    expect(movement.reference_id).toBe(String(count.id));
    // ...and the count at the movement, so the pair reads from either side.
    expect(count.movement_id).toBe(String(movement.id));
    expect(movement.created_by).toBe(context.userId);
  });

  /**
   * The case that justifies the table existing at all. `quantity <> 0`
   * (migrations/0007) forbids an empty movement, so a count that matched
   * would otherwise leave nothing behind — and "j'ai compté, c'était juste"
   * is exactly what an inventory is performed to establish.
   */
  it("keeps a trace of a count that matched, without inventing a movement", async () => {
    const { count, balance } = await recordStockCount(context, coffee.id, 10, "Rien à signaler");

    expect(count.difference).toBe(0);
    expect(count.movement_id).toBeNull();
    expect(balance).toBe(10);
    // No CORRECTION was written: the ledger describes events, and nothing
    // happened to the stock.
    const movements = await listStockMovements(pool, tenant.locationId, coffee.id);
    expect(movements.every((movement) => movement.type !== "CORRECTION")).toBe(true);
    // But the count is on record, with its author and its date.
    const [entry] = await listStockCounts(pool, tenant.locationId, coffee.id);
    expect(entry.counted_quantity).toBe(10);
  });

  /**
   * The theoretical balance is read under the lock the correction is written
   * with. Read any earlier and a sale settling mid-count would be blamed on
   * the person counting.
   */
  it("counts against the balance at the moment of counting, not an earlier one", async () => {
    await sell(context, [{ productId: coffee.id, quantity: 3 }], { paymentMethod: "CASH" });

    const { count } = await recordStockCount(context, coffee.id, 7, null);

    // 10 − 3 = 7 on the shelf and in the system: the count matches, and the
    // écart is zero rather than the +(-3) a stale "stock avant" would give.
    expect(count.theoretical_quantity).toBe(7);
    expect(count.difference).toBe(0);
    expect(await balanceOf(coffee.id)).toBe(7);
  });

  it("lists a product's counts most recent first", async () => {
    await recordStockCount(context, coffee.id, 9, "Premier");
    await recordStockCount(context, coffee.id, 11, "Deuxième");

    const history = await listStockCounts(pool, tenant.locationId, coffee.id);
    expect(history.map((entry) => entry.note)).toEqual(["Deuxième", "Premier"]);
    // Each row stands alone: the second count's "stock avant" is what the
    // first one left, so the history reads as a chain.
    expect(history[1]).toMatchObject({ theoretical_quantity: 10, counted_quantity: 9 });
    expect(history[0]).toMatchObject({ theoretical_quantity: 9, counted_quantity: 11 });
  });

  it("refuses to count another establishment's product", async () => {
    const other = await createTestTenant(pool, "Other Tenant");
    const otherOwner = await createTestUser(pool, other, "OWNER");
    const theirs = await createProductWithInitialStock(
      { ...context, userId: otherOwner.userId, locationId: other.locationId },
      { categoryId: null, name: "Leur produit", price: "5.00", stockQuantity: 5 },
    );

    await expect(recordStockCount(context, theirs.id, 99, null)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
