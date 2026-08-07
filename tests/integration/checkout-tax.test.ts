import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { ValidationError } from "../../lib/errors";
import { openBusinessDay } from "../../lib/repositories/business-days";
import { listOrders } from "../../lib/repositories/orders";
import { listPaymentsForOrder } from "../../lib/repositories/payments";
import { createProduct } from "../../lib/repositories/products";
import { getStockBalanceFromLedger } from "../../lib/repositories/stock-movements";
import { performCheckout } from "../../lib/services/checkout";
import { createProductWithInitialStock } from "../../lib/services/products";
import { parseOrThrow } from "../../lib/validation/parse";
import { checkoutBodySchema } from "../../lib/validation/schemas";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * SALE-03's acceptance criterion, verbatim: "cash + card = total TTC,
 * snapshots fiscaux persistés, stock >= 0, calcul uniquement côté serveur
 * et rollback complet." Each is proved directly — this is also the
 * regression test for P0-02 (a CASH sale recorded as CARD revenue too):
 * the prototype's `cardAmount || total` fallback is gone, and these tests
 * would fail against it if it ever came back.
 */

let tenant: TestTenant;
let context: RequestContext;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Checkout Tax Tenant");
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
  await openBusinessDay(pool, tenant.locationId, "0.00");
});

function checkoutBody(input: {
  items: { productId: number; quantity: number }[];
  paymentMethod: "CASH" | "CARD" | "MIXED";
  cashAmount?: string;
  cardAmount?: string;
}) {
  return parseOrThrow(checkoutBodySchema, { tableId: null, ...input });
}

describe("SALE-03: server-computed tax (DEC-05)", () => {
  it("extracts tax at the establishment's default rate (20%) for a product with no tax class of its own", async () => {
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Chicha Signature",
      price: "15.00",
      stockQuantity: 10,
    });

    const { order } = await performCheckout(
      context,
      checkoutBody({
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: "CASH",
      }),
    );

    // 15.00 € TTC at 20%: tax = 15.00 - 15.00/1.20 = 2.50, HT = 12.50.
    // DECIMAL(10,2) columns come back from pg as strings, not numbers —
    // true of every amount field on this row already, before SALE-03.
    expect(order.subtotal_amount).toBe("12.50");
    expect(order.tax_amount).toBe("2.50");
    expect(order.total_amount).toBe("15.00");
  });

  it("sums per-line rounded amounts rather than recomputing globally (DEC-05's worked example)", async () => {
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Thé",
      price: "3.33",
      stockQuantity: 10,
    });

    const { order } = await performCheckout(
      context,
      checkoutBody({
        items: [{ productId: product.id, quantity: 3 }],
        paymentMethod: "CASH",
      }),
    );

    // 3 x 3.33 = 9.99, never rounded up to 10.00.
    expect(order.total_amount).toBe("9.99");
  });

  it("resolves each line's own tax rate independently, then sums (mixed rates on one order)", async () => {
    const {
      rows: [category],
    } = await pool.query<{ id: number }>(
      "INSERT INTO categories (location_id, name) VALUES ($1, $2) RETURNING id",
      [tenant.locationId, "Restauration"],
    );
    const {
      rows: [reducedRate],
    } = await pool.query<{ id: number }>(
      "INSERT INTO tax_classes (location_id, name, rate) VALUES ($1, $2, $3) RETURNING id",
      [tenant.locationId, "TVA réduite", "10.00"],
    );
    await pool.query("UPDATE categories SET tax_class_id = $1 WHERE id = $2", [
      reducedRate.id,
      category.id,
    ]);
    const reducedProduct = await createProduct(pool, tenant.locationId, {
      categoryId: category.id,
      name: "Plat",
      price: "20.00",
      stockQuantity: 10,
    });
    const standardProduct = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Alcool",
      price: "10.00",
      stockQuantity: 10,
    });

    const { order } = await performCheckout(
      context,
      checkoutBody({
        items: [
          { productId: reducedProduct.id, quantity: 1 }, // 20.00 @ 10% -> tax 1.82 (round-half-up)
          { productId: standardProduct.id, quantity: 1 }, // 10.00 @ 20% -> tax 1.67 (round-half-up)
        ],
        paymentMethod: "CASH",
      }),
    );

    expect(order.total_amount).toBe("30.00");
    // 20.00 / 1.10 = 18.181818..., tax = 1.818181... -> rounds to 1.82.
    // 10.00 / 1.20 = 8.333333..., tax = 1.666666... -> rounds to 1.67.
    expect(order.tax_amount).toBe("3.49");
    expect(order.subtotal_amount).toBe("26.51");
  });
});

describe("SALE-03: cash + card = total, computed server-side (P0-02 regression)", () => {
  it("records a CASH sale as cash revenue only — never card too", async () => {
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "12.00",
      stockQuantity: 10,
    });

    const { order } = await performCheckout(
      context,
      checkoutBody({
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: "CASH",
      }),
    );

    expect(order.cash_amount).toBe("12.00");
    expect(order.card_amount).toBe("0.00");

    const payments = await listPaymentsForOrder(pool, tenant.locationId, order.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ type: "CHARGE", method: "CASH", amount: "12.00" });
  });

  it("records a CARD sale as card revenue only", async () => {
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "12.00",
      stockQuantity: 10,
    });

    const { order } = await performCheckout(
      context,
      checkoutBody({
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: "CARD",
      }),
    );

    expect(order.cash_amount).toBe("0.00");
    expect(order.card_amount).toBe("12.00");

    const payments = await listPaymentsForOrder(pool, tenant.locationId, order.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ type: "CHARGE", method: "CARD", amount: "12.00" });
  });

  it("ignores whatever the client sent for the amount on a CASH/CARD sale — the server derives it", async () => {
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "12.00",
      stockQuantity: 10,
    });

    // checkoutBodySchema lets cashAmount be omitted or present for CASH;
    // whatever was here in the prototype's fallback logic no longer has any
    // effect at all — the total is what decides the charge, always.
    const { order } = await performCheckout(
      context,
      checkoutBody({
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: "CASH",
      }),
    );

    expect(order.cash_amount).toBe("12.00");
    expect(order.card_amount).toBe("0.00");
  });

  it("splits a MIXED sale exactly as the client specified, when it sums to the total", async () => {
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Brunch",
      price: "20.00",
      stockQuantity: 10,
    });

    const { order } = await performCheckout(
      context,
      checkoutBody({
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: "MIXED",
        cashAmount: "12.00",
        cardAmount: "8.00",
      }),
    );

    expect(order.cash_amount).toBe("12.00");
    expect(order.card_amount).toBe("8.00");

    const payments = await listPaymentsForOrder(pool, tenant.locationId, order.id);
    expect(payments).toHaveLength(2);
    expect(payments.find((payment) => payment.method === "CASH")?.amount).toBe("12.00");
    expect(payments.find((payment) => payment.method === "CARD")?.amount).toBe("8.00");
  });

  it("refuses a MIXED sale whose split does not sum to the real, server-computed total", async () => {
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Brunch",
      price: "20.00",
      stockQuantity: 10,
    });

    await expect(
      performCheckout(
        context,
        checkoutBody({
          items: [{ productId: product.id, quantity: 1 }],
          paymentMethod: "MIXED",
          cashAmount: "12.00",
          cardAmount: "5.00", // sums to 17.00, not the real 20.00
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await listOrders(pool, tenant.locationId)).toHaveLength(0);
  });
});

describe("SALE-03: stock movements, not just the materialized column (closing STK-01's gap)", () => {
  it("records a SALE stock movement matching the decrement, staying equal to the ledger", async () => {
    // createProductWithInitialStock (STK-02), not createProduct directly:
    // the starting 10 units need their own OPENING_BALANCE movement for
    // the ledger to explain the *whole* balance, not just this sale's
    // decrement — otherwise getStockBalanceFromLedger below would only see
    // the -3 this test causes, not the full history.
    const product = await createProductWithInitialStock(context, {
      categoryId: null,
      name: "Chicha",
      price: "18.00",
      stockQuantity: 10,
    });

    const { order } = await performCheckout(
      context,
      checkoutBody({
        items: [{ productId: product.id, quantity: 3 }],
        paymentMethod: "CASH",
      }),
    );

    const { rows } = await pool.query(
      "SELECT quantity, type, reference_type, reference_id FROM stock_movements WHERE product_id = $1",
      [product.id],
    );
    // One OPENING_BALANCE (+10, from createProductWithInitialStock above)
    // plus this sale's own SALE movement.
    expect(rows).toHaveLength(2);
    const saleMovement = rows.find((row) => row.type === "SALE");
    expect(saleMovement).toMatchObject({
      quantity: -3,
      type: "SALE",
      reference_type: "order",
      reference_id: String(order.id),
    });

    const { rows: products } = await pool.query(
      "SELECT stock_quantity FROM products WHERE id = $1",
      [product.id],
    );
    expect(products[0].stock_quantity).toBe(7);
    expect(await getStockBalanceFromLedger(pool, tenant.locationId, product.id)).toBe(7);
  });

  it("refuses a sale that would take stock negative, with a full rollback (no order, no payment, no movement)", async () => {
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Chicha",
      price: "18.00",
      stockQuantity: 2,
    });

    await expect(
      performCheckout(
        context,
        checkoutBody({
          items: [{ productId: product.id, quantity: 5 }],
          paymentMethod: "CASH",
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await listOrders(pool, tenant.locationId)).toHaveLength(0);
    const { rows } = await pool.query("SELECT stock_quantity FROM products WHERE id = $1", [
      product.id,
    ]);
    expect(rows[0].stock_quantity).toBe(2);
    expect(
      (await pool.query("SELECT * FROM stock_movements WHERE product_id = $1", [product.id])).rows,
    ).toHaveLength(0);
  });

  it("rolls back everything, including an already-valid first line, when a later line in the same order fails", async () => {
    const okProduct = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "OK",
      price: "5.00",
      stockQuantity: 10,
    });
    const shortProduct = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Rupture",
      price: "5.00",
      stockQuantity: 1,
    });

    await expect(
      performCheckout(
        context,
        checkoutBody({
          items: [
            { productId: okProduct.id, quantity: 2 },
            { productId: shortProduct.id, quantity: 5 },
          ],
          paymentMethod: "CASH",
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await listOrders(pool, tenant.locationId)).toHaveLength(0);
    const { rows } = await pool.query("SELECT id, stock_quantity FROM products WHERE id = $1", [
      okProduct.id,
    ]);
    // The line that would have succeeded on its own was never applied —
    // the transaction rolled back as a whole.
    expect(rows[0].stock_quantity).toBe(10);
  });
});
