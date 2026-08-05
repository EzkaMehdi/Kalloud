import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../../lib/db";
import { ValidationError } from "../../lib/errors";
import { createProduct, listProducts } from "../../lib/repositories/products";
import { openBusinessDay } from "../../lib/repositories/business-days";
import { listCashMovements } from "../../lib/repositories/cash-movements";
import { listOrders } from "../../lib/repositories/orders";
import { performCheckout } from "../../lib/services/checkout";
import { parseOrThrow } from "../../lib/validation/parse";
import { checkoutBodySchema, createCashMovementSchema } from "../../lib/validation/schemas";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * API-01's acceptance criterion is precise: "toute entrée invalide retourne
 * une erreur métier stable **avant l'accès base**". Asserting only that a
 * 400 comes back would not prove the "avant" half — a handler that queried
 * first and validated second would pass such a test while still burning a
 * connection, taking a row lock, or partially writing.
 *
 * So these tests count the queries actually issued against the pool. Like
 * tests/integration/tenant-isolation.test.ts, they exercise the
 * parse-then-service composition rather than importing route handlers:
 * Next's `cookies()` throws outside its own server dispatch. What each
 * handler runs is the same pair of calls, and the fact that every handler
 * uses `parseJsonBody` before reaching a repository is held in place
 * statically by tests/unit/architecture.test.ts.
 */

let tenant: TestTenant;
let context: RequestContext;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Validation Tenant");
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

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Runs `action` and reports how many times it touched the database, counting
 * both one-off `pool.query()` calls and `pool.connect()` — a transaction
 * (`withTransaction`) issues its statements through a checked-out client, so
 * counting queries alone would miss every write the checkout performs, and
 * borrowing a connection at all is already more than "before the database".
 */
async function countDatabaseCalls(action: () => Promise<unknown>): Promise<{
  calls: number;
  error: unknown;
}> {
  const querySpy = vi.spyOn(pool, "query");
  const connectSpy = vi.spyOn(pool, "connect");
  let error: unknown = null;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  const calls = querySpy.mock.calls.length + connectSpy.mock.calls.length;
  querySpy.mockRestore();
  connectSpy.mockRestore();
  return { calls, error };
}

describe("API-01: invalid input is rejected before the database is touched", () => {
  const invalidCheckouts: [string, unknown][] = [
    ["no items", { items: [], paymentMethod: "CARD", cardAmount: 10 }],
    ["a zero quantity", { items: [{ productId: 1, quantity: 0 }], paymentMethod: "CARD" }],
    [
      "a non-integer product id",
      { items: [{ productId: 1.5, quantity: 1 }], paymentMethod: "CARD" },
    ],
    [
      "a price with three decimals",
      { items: [{ productId: 1, quantity: 1 }], paymentMethod: "CASH", cashAmount: 4.995 },
    ],
    [
      "an unknown payment method",
      { items: [{ productId: 1, quantity: 1 }], paymentMethod: "CHEQUE" },
    ],
    [
      "a MIXED payment that is not split",
      { items: [{ productId: 1, quantity: 1 }], paymentMethod: "MIXED" },
    ],
    ["a missing body", null],
  ];

  it.each(invalidCheckouts)("rejects a checkout with %s without querying", async (_label, body) => {
    const { calls, error } = await countDatabaseCalls(async () =>
      performCheckout(context, parseOrThrow(checkoutBodySchema, body)),
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(calls, "an invalid payload must not reach the database at all").toBe(0);
  });

  it("rejects an invalid cash movement without querying", async () => {
    const { calls, error } = await countDatabaseCalls(async () =>
      parseOrThrow(createCashMovementSchema, { type: "IN", amount: -5, reason: "" }),
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(calls).toBe(0);
  });

  it("leaves no rows behind after a batch of rejected checkouts", async () => {
    await openBusinessDay(pool, tenant.locationId, "100.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "2.50",
      stockQuantity: 10,
    });

    for (const [, body] of invalidCheckouts) {
      await expect(
        (async () => performCheckout(context, parseOrThrow(checkoutBodySchema, body)))(),
      ).rejects.toBeInstanceOf(ValidationError);
    }

    expect(await listOrders(pool, tenant.locationId)).toHaveLength(0);
    expect(await listCashMovements(pool, tenant.locationId)).toHaveLength(0);
    const products = await listProducts(pool, tenant.locationId);
    expect(products.find((row) => row.id === product.id)?.stock_quantity).toBe(10);
  });

  it("still lets a valid checkout through — validation is not over-blocking", async () => {
    await openBusinessDay(pool, tenant.locationId, "100.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "2.50",
      stockQuantity: 10,
    });

    const { calls, error } = await countDatabaseCalls(async () =>
      performCheckout(
        context,
        parseOrThrow(checkoutBodySchema, {
          tableId: null,
          items: [{ productId: product.id, quantity: 2 }],
          paymentMethod: "CARD",
          cardAmount: "5.00",
        }),
      ),
    );

    expect(error).toBeNull();
    expect(calls, "a valid checkout obviously does reach the database").toBeGreaterThan(0);

    const orders = await listOrders(pool, tenant.locationId);
    expect(orders).toHaveLength(1);
    const products = await listProducts(pool, tenant.locationId);
    expect(products.find((row) => row.id === product.id)?.stock_quantity).toBe(8);
  });

  it("records the amounts it was given, in the DECIMAL form Postgres stores", async () => {
    await openBusinessDay(pool, tenant.locationId, "100.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Thé",
      price: "3.33",
      stockQuantity: 10,
    });

    await performCheckout(
      context,
      parseOrThrow(checkoutBodySchema, {
        tableId: null,
        items: [{ productId: product.id, quantity: 3 }],
        paymentMethod: "CASH",
        // DEC-05's worked example: 3 x 3,33 € is 9,99 €, not 10,00 €.
        cashAmount: "9.99",
      }),
    );

    const [order] = await listOrders(pool, tenant.locationId);
    expect(order.cash_amount).toBe("9.99");
    expect(order.total_amount).toBe("9.99");
  });
});
