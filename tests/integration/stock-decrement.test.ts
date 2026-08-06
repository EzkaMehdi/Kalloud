import { beforeEach, describe, expect, it } from "vitest";
import { pool, withTransaction } from "../../lib/db";
import { ValidationError } from "../../lib/errors";
import { createProduct, type ProductRow } from "../../lib/repositories/products";
import { decrementStockAtomically } from "../../lib/services/stock";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";

/**
 * STK-03's acceptance criterion, verbatim: "doublons d'un même produit
 * agrégés ; concurrence testée." Not wired to checkout.ts (DEC-06 assigns
 * the SALE trigger to SALE-03) — these tests call the service directly,
 * each wrapped in its own withTransaction the way a real caller (SALE-03,
 * eventually) would have to.
 */

let tenant: TestTenant;
let userId: number;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Stock Decrement Tenant");
  const owner = await createTestUser(pool, tenant, "OWNER");
  userId = owner.userId;
});

async function makeProduct(stockQuantity: number, name = "Chicha"): Promise<ProductRow> {
  return createProduct(pool, tenant.locationId, {
    categoryId: null,
    name,
    price: "10.00",
    stockQuantity,
  });
}

describe("STK-03: atomic stock decrement", () => {
  it("aggregates repeated lines of the same product before checking or decrementing", async () => {
    const product = await makeProduct(10);

    const balances = await withTransaction((client) =>
      decrementStockAtomically(
        client,
        tenant.locationId,
        [
          { productId: product.id, quantity: 2 },
          { productId: product.id, quantity: 3 },
        ],
        { type: "SALE", reason: "Vente test", createdBy: userId },
      ),
    );

    expect(balances.get(product.id)).toBe(5);

    // One aggregated movement, not two — proves the two lines were merged
    // before recordStockMovement was ever called, not just that the final
    // balance happens to add up.
    const { rows: movements } = await pool.query(
      "SELECT quantity FROM stock_movements WHERE product_id = $1",
      [product.id],
    );
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(-5);
  });

  it("refuses the whole operation, with no partial decrement, when aggregated demand exceeds stock", async () => {
    const product = await makeProduct(4);

    await expect(
      withTransaction((client) =>
        decrementStockAtomically(
          client,
          tenant.locationId,
          [
            { productId: product.id, quantity: 2 },
            { productId: product.id, quantity: 3 }, // 5 aggregated, only 4 in stock
          ],
          { type: "SALE", reason: "Vente refusée", createdBy: userId },
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    // withTransaction rolled the whole thing back — no movement, no change.
    const { rows } = await pool.query("SELECT stock_quantity FROM products WHERE id = $1", [
      product.id,
    ]);
    expect(rows[0].stock_quantity).toBe(4);
    expect(
      (await pool.query("SELECT * FROM stock_movements WHERE product_id = $1", [product.id])).rows,
    ).toHaveLength(0);
  });

  it("refuses a request for an inactive product", async () => {
    const product = await makeProduct(10);
    await pool.query("UPDATE products SET is_active = false WHERE id = $1", [product.id]);

    await expect(
      withTransaction((client) =>
        decrementStockAtomically(
          client,
          tenant.locationId,
          [{ productId: product.id, quantity: 1 }],
          { type: "SALE", reason: "Produit inactif", createdBy: userId },
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("records the movement with the type/reason/reference the caller supplied, staying equal to the ledger", async () => {
    const product = await makeProduct(10);

    await withTransaction((client) =>
      decrementStockAtomically(
        client,
        tenant.locationId,
        [{ productId: product.id, quantity: 4 }],
        {
          type: "LOSS",
          reason: "Casse constatée",
          createdBy: userId,
          referenceType: "inventory",
          referenceId: "42",
        },
      ),
    );

    const { rows } = await pool.query(
      "SELECT quantity, type, reason, reference_type, reference_id FROM stock_movements WHERE product_id = $1",
      [product.id],
    );
    expect(rows[0]).toMatchObject({
      quantity: -4,
      type: "LOSS",
      reason: "Casse constatée",
      reference_type: "inventory",
      reference_id: "42",
    });
    const { rows: products } = await pool.query(
      "SELECT stock_quantity FROM products WHERE id = $1",
      [product.id],
    );
    expect(products[0].stock_quantity).toBe(6);
  });

  it("resolves two genuinely concurrent decrements on the same product into exactly one winner when stock cannot cover both", async () => {
    const product = await makeProduct(5);

    const attempt = (quantity: number) =>
      withTransaction((client) =>
        decrementStockAtomically(client, tenant.locationId, [{ productId: product.id, quantity }], {
          type: "SALE",
          reason: "Vente concurrente",
          createdBy: userId,
        }),
      );

    // Two sales of 3 units each against a stock of 5: sequentially, the
    // second would fail (5 - 3 = 2 < 3). The FOR UPDATE lock in
    // lockActiveProductForStockOperation is what forces this pair to behave
    // that way even when they race — one call's transaction blocks on the
    // other's row lock, so the loser sees the already-decremented balance,
    // not the stale one it started with.
    const outcomes = await Promise.allSettled([attempt(3), attempt(3)]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError);

    // The decisive check: the balance never went negative, and equals
    // exactly one successful decrement of 3 from 5 — not two.
    const { rows } = await pool.query("SELECT stock_quantity FROM products WHERE id = $1", [
      product.id,
    ]);
    expect(rows[0].stock_quantity).toBe(2);
  });
});
