import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { createProduct, type ProductRow } from "../../lib/repositories/products";
import {
  getStockBalanceFromLedger,
  recordStockMovement,
} from "../../lib/repositories/stock-movements";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";

/**
 * STK-01's acceptance criterion, verbatim: "le solde est reconstructible ;
 * s'il est matérialisé, il est mis à jour dans la même transaction et reste
 * égal au ledger." Every test below proves one slice of that — not just
 * that a row can be inserted, but that `products.stock_quantity` and
 * `SUM(stock_movements.quantity)` cannot be observed to disagree, and that
 * the six movement types and their signs (DEC-06's own table) are enforced
 * by the database, not just trusted of callers.
 */

let tenant: TestTenant;
let product: ProductRow;
let userId: number;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Stock Tenant");
  const owner = await createTestUser(pool, tenant, "OWNER");
  userId = owner.userId;
  product = await createProduct(pool, tenant.locationId, {
    categoryId: null,
    name: "Chicha Signature",
    price: "18.00",
    stockQuantity: 0,
  });
});

describe("STK-01: stock movement ledger", () => {
  it("applies a movement to the materialized balance and keeps it equal to the ledger", async () => {
    const { movement, balance } = await recordStockMovement(pool, tenant.locationId, {
      productId: product.id,
      quantity: 20,
      type: "OPENING_BALANCE",
      reason: "Stock initial",
      createdBy: userId,
    });

    expect(movement.quantity).toBe(20);
    expect(balance).toBe(20);

    const { rows } = await pool.query<{ stock_quantity: number }>(
      "SELECT stock_quantity FROM products WHERE id = $1",
      [product.id],
    );
    expect(rows[0].stock_quantity).toBe(20);
    expect(await getStockBalanceFromLedger(pool, tenant.locationId, product.id)).toBe(20);
  });

  it("stays reconstructible from the ledger across several movements of different types", async () => {
    await recordStockMovement(pool, tenant.locationId, {
      productId: product.id,
      quantity: 20,
      type: "OPENING_BALANCE",
      reason: "Stock initial",
      createdBy: userId,
    });
    await recordStockMovement(pool, tenant.locationId, {
      productId: product.id,
      quantity: -3,
      type: "SALE",
      reason: "Vente commande #1",
      createdBy: userId,
      referenceType: "order",
      referenceId: "1",
    });
    await recordStockMovement(pool, tenant.locationId, {
      productId: product.id,
      quantity: 10,
      type: "RECEIPT",
      reason: "Livraison fournisseur",
      createdBy: userId,
    });
    await recordStockMovement(pool, tenant.locationId, {
      productId: product.id,
      quantity: -1,
      type: "LOSS",
      reason: "Casse",
      createdBy: userId,
    });

    const expected = 20 - 3 + 10 - 1;
    const { rows } = await pool.query<{ stock_quantity: number }>(
      "SELECT stock_quantity FROM products WHERE id = $1",
      [product.id],
    );
    expect(rows[0].stock_quantity).toBe(expected);
    expect(await getStockBalanceFromLedger(pool, tenant.locationId, product.id)).toBe(expected);
  });

  it("lets a CORRECTION bring the balance negative for a documented catch-up (DEC-06)", async () => {
    const { balance } = await recordStockMovement(pool, tenant.locationId, {
      productId: product.id,
      quantity: -5,
      type: "CORRECTION",
      reason: "Écart d'inventaire constaté, rattrapage",
      createdBy: userId,
    });

    expect(balance).toBe(-5);
    expect(await getStockBalanceFromLedger(pool, tenant.locationId, product.id)).toBe(-5);
  });

  it("rejects a movement type outside the six DEC-06 values", async () => {
    await expect(
      pool.query(
        `INSERT INTO stock_movements (location_id, product_id, quantity, type, reason, created_by)
         VALUES ($1, $2, 5, 'RESTOCK', 'invalide', $3)`,
        [tenant.locationId, product.id, userId],
      ),
    ).rejects.toThrow(/stock_movements_type_check|stock_movements_quantity_sign_check/);
  });

  it("rejects a zero-quantity movement", async () => {
    await expect(
      pool.query(
        `INSERT INTO stock_movements (location_id, product_id, quantity, type, reason, created_by)
         VALUES ($1, $2, 0, 'RECEIPT', 'sans effet', $3)`,
        [tenant.locationId, product.id, userId],
      ),
    ).rejects.toThrow();
  });

  it.each([
    ["OPENING_BALANCE", -1],
    ["SALE", 1],
    ["RECEIPT", -1],
    ["LOSS", 1],
    ["RETURN", -1],
  ])(
    "rejects a %s movement with the wrong sign for its type (DEC-06's 'sens' column)",
    async (type, quantity) => {
      await expect(
        pool.query(
          `INSERT INTO stock_movements (location_id, product_id, quantity, type, reason, created_by)
           VALUES ($1, $2, $3, $4, 'signe incorrect', $5)`,
          [tenant.locationId, product.id, quantity, type, userId],
        ),
      ).rejects.toThrow();
    },
  );

  it("refuses a movement referencing another tenant's product (composite FK, SEC-02/SEC-06)", async () => {
    const otherTenant = await createTestTenant(pool, "Other Stock Tenant");

    await expect(
      recordStockMovement(pool, otherTenant.locationId, {
        productId: product.id, // belongs to `tenant`, not `otherTenant`
        quantity: 5,
        type: "RECEIPT",
        reason: "cross-tenant",
        createdBy: userId,
      }),
    ).rejects.toThrow();
  });
});
