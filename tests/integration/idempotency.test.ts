import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { ConflictError, ValidationError } from "../../lib/errors";
import { withIdempotency } from "../../lib/idempotency";
import { openBusinessDay } from "../../lib/repositories/business-days";
import { listOrders } from "../../lib/repositories/orders";
import { createProduct, listProducts, type ProductRow } from "../../lib/repositories/products";
import { performCheckout } from "../../lib/services/checkout";
import { parseOrThrow } from "../../lib/validation/parse";
import { checkoutBodySchema } from "../../lib/validation/schemas";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * API-02's acceptance criterion, verbatim: "un double clic ou retry réseau
 * ne crée jamais deux encaissements ; une clé réutilisée avec un autre
 * payload est refusée". Every test below asserts against the rows actually
 * in the database, not just against the value returned, because the failure
 * mode being prevented is a *second row* nobody asked for.
 *
 * Like the other integration suites, this exercises the service composition
 * rather than the route handler: Next's `cookies()` throws outside its own
 * dispatch (see tests/integration/tenant-isolation.test.ts).
 */

const ENDPOINT = "POST /api/checkout";

let tenantA: TestTenant;
let tenantB: TestTenant;
let contextA: RequestContext;
let contextB: RequestContext;
let productA: ProductRow;

async function contextFor(tenant: TestTenant, name: string): Promise<RequestContext> {
  const owner = await createTestUser(pool, tenant, "OWNER");
  return {
    userId: owner.userId,
    userEmail: owner.email,
    userName: name,
    organizationId: tenant.organizationId,
    locationId: tenant.locationId,
    role: "OWNER",
    sessionId: 1,
  };
}

beforeEach(async () => {
  await resetDatabase(pool);
  tenantA = await createTestTenant(pool, "Tenant A");
  tenantB = await createTestTenant(pool, "Tenant B");
  contextA = await contextFor(tenantA, "Owner A");
  contextB = await contextFor(tenantB, "Owner B");

  await openBusinessDay(pool, tenantA.locationId, "100.00");
  await openBusinessDay(pool, tenantB.locationId, "100.00");
  productA = await createProduct(pool, tenantA.locationId, {
    categoryId: null,
    name: "Café",
    price: "2.50",
    stockQuantity: 20,
  });
});

/** The payload the caisse sends for one coffee paid by card. */
function checkoutPayload(quantity = 1, productId = productA.id) {
  return parseOrThrow(checkoutBodySchema, {
    tableId: null,
    items: [{ productId, quantity }],
    paymentMethod: "CARD",
    cardAmount: (2.5 * quantity).toFixed(2),
  });
}

function runCheckout(
  context: RequestContext,
  key: string,
  payload: ReturnType<typeof checkoutPayload>,
) {
  return withIdempotency(context, { endpoint: ENDPOINT, key, payload }, () =>
    performCheckout(context, payload),
  );
}

describe("API-02: a retry never creates a second sale", () => {
  it("replays the stored result instead of charging twice", async () => {
    const key = randomUUID();
    const payload = checkoutPayload();

    const first = await runCheckout(contextA, key, payload);
    const second = await runCheckout(contextA, key, payload);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    // Same sale, not merely a same-shaped one.
    expect(second.result.order.id).toBe(first.result.order.id);
    expect(second.result.total).toBe(first.result.total);

    expect(await listOrders(pool, tenantA.locationId)).toHaveLength(1);
    const products = await listProducts(pool, tenantA.locationId);
    // The decisive check: stock moved once, not twice.
    expect(products.find((row) => row.id === productA.id)?.stock_quantity).toBe(19);
  });

  it("serialises a genuine double-click into exactly one order", async () => {
    const key = randomUUID();
    const payload = checkoutPayload();

    const outcomes = await Promise.allSettled([
      runCheckout(contextA, key, payload),
      runCheckout(contextA, key, payload),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

    // The loser either replays the winner's response (if the winner had
    // already finished) or is told the request is in flight — never a
    // second sale, and never a silent failure.
    expect(fulfilled.length + rejected.length).toBe(2);
    for (const outcome of rejected) {
      expect(outcome.reason).toBeInstanceOf(ConflictError);
    }

    expect(await listOrders(pool, tenantA.locationId)).toHaveLength(1);
    const products = await listProducts(pool, tenantA.locationId);
    expect(products.find((row) => row.id === productA.id)?.stock_quantity).toBe(19);
  });

  it("refuses a key reused with a different payload", async () => {
    const key = randomUUID();
    await runCheckout(contextA, key, checkoutPayload(1));

    await expect(runCheckout(contextA, key, checkoutPayload(3))).rejects.toBeInstanceOf(
      ConflictError,
    );

    // The refusal must not have created or altered anything.
    expect(await listOrders(pool, tenantA.locationId)).toHaveLength(1);
    const products = await listProducts(pool, tenantA.locationId);
    expect(products.find((row) => row.id === productA.id)?.stock_quantity).toBe(19);
  });

  it("accepts the same payload sent in a different key order (a legitimate retry)", async () => {
    const key = randomUUID();
    const payload = checkoutPayload();
    const reordered = {
      cardAmountCents: payload.cardAmountCents,
      items: payload.items,
      cashAmountCents: payload.cashAmountCents,
      paymentMethod: payload.paymentMethod,
      tableId: payload.tableId,
    } as typeof payload;

    await runCheckout(contextA, key, payload);
    const retry = await runCheckout(contextA, key, reordered);

    expect(retry.replayed).toBe(true);
    expect(await listOrders(pool, tenantA.locationId)).toHaveLength(1);
  });
});

describe("API-02: keys are scoped to their establishment", () => {
  it("lets two tenants use the same key value without colliding", async () => {
    const sharedKey = randomUUID();
    const productB = await createProduct(pool, tenantB.locationId, {
      categoryId: null,
      name: "Thé",
      price: "3.00",
      stockQuantity: 20,
    });

    await runCheckout(contextA, sharedKey, checkoutPayload());
    const outcomeB = await withIdempotency(
      contextB,
      {
        endpoint: ENDPOINT,
        key: sharedKey,
        payload: parseOrThrow(checkoutBodySchema, {
          tableId: null,
          items: [{ productId: productB.id, quantity: 1 }],
          paymentMethod: "CARD",
          cardAmount: "3.00",
        }),
      },
      () =>
        performCheckout(
          contextB,
          parseOrThrow(checkoutBodySchema, {
            tableId: null,
            items: [{ productId: productB.id, quantity: 1 }],
            paymentMethod: "CARD",
            cardAmount: "3.00",
          }),
        ),
    );

    // Tenant B's request must neither be refused as a duplicate nor replay
    // tenant A's stored response.
    expect(outcomeB.replayed).toBe(false);
    expect(await listOrders(pool, tenantA.locationId)).toHaveLength(1);
    expect(await listOrders(pool, tenantB.locationId)).toHaveLength(1);
  });
});

describe("API-02: a failed attempt does not lock the key", () => {
  it("lets a corrected request through after a business failure", async () => {
    const key = randomUUID();

    // More than the 20 in stock: the transaction rolls back.
    await expect(runCheckout(contextA, key, checkoutPayload(50))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await listOrders(pool, tenantA.locationId)).toHaveLength(0);

    // DEC-08 asks that a retry of a *failed* attempt remain possible; the
    // claim was released, so the corrected request succeeds.
    const corrected = await runCheckout(contextA, key, checkoutPayload(2));
    expect(corrected.replayed).toBe(false);
    expect(await listOrders(pool, tenantA.locationId)).toHaveLength(1);
  });

  it("leaves no claim behind after a failure", async () => {
    const key = randomUUID();
    await expect(runCheckout(contextA, key, checkoutPayload(50))).rejects.toBeInstanceOf(
      ValidationError,
    );

    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM idempotency_keys WHERE idempotency_key = $1",
      [key],
    );
    expect(rows[0].count).toBe("0");
  });
});

describe("API-02: concurrent checkouts cannot oversell or deadlock", () => {
  it("keeps stock non-negative when two sales race for the last units", async () => {
    const scarce = await createProduct(pool, tenantA.locationId, {
      categoryId: null,
      name: "Dernière part",
      price: "5.00",
      stockQuantity: 3,
    });
    const payload = () =>
      parseOrThrow(checkoutBodySchema, {
        tableId: null,
        items: [{ productId: scarce.id, quantity: 2 }],
        paymentMethod: "CARD",
        cardAmount: "10.00",
      });

    // Different keys: these are two genuinely different sales, so
    // idempotency does not apply — row locking has to do the work.
    const outcomes = await Promise.allSettled([
      runCheckout(contextA, randomUUID(), payload()),
      runCheckout(contextA, randomUUID(), payload()),
    ]);

    const succeeded = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
    expect(succeeded).toBe(1);

    const products = await listProducts(pool, tenantA.locationId);
    expect(products.find((row) => row.id === scarce.id)?.stock_quantity).toBe(1);
  });

  // Note on what this test does and does not prove: it is a regression
  // guard, not a demonstration. Reproducing a lock-ordering deadlock on
  // demand requires pausing one transaction between its two FOR UPDATE
  // statements, which this suite has no hook to force — so it passes with
  // or without the ordering fix. The ordering guarantee itself is asserted
  // directly in tests/unit/checkout-items.test.ts.
  it("completes two sales touching the same products in opposite order", async () => {
    const second = await createProduct(pool, tenantA.locationId, {
      categoryId: null,
      name: "Thé",
      price: "3.00",
      stockQuantity: 20,
    });

    const forward = parseOrThrow(checkoutBodySchema, {
      tableId: null,
      items: [
        { productId: productA.id, quantity: 1 },
        { productId: second.id, quantity: 1 },
      ],
      paymentMethod: "CARD",
      cardAmount: "5.50",
    });
    const reverse = parseOrThrow(checkoutBodySchema, {
      tableId: null,
      items: [
        { productId: second.id, quantity: 1 },
        { productId: productA.id, quantity: 1 },
      ],
      paymentMethod: "CARD",
      cardAmount: "5.50",
    });

    // Both must complete: with the ordering fix in place, one waits for the
    // other rather than Postgres aborting either with a deadlock error.
    const results = await Promise.all([
      runCheckout(contextA, randomUUID(), forward),
      runCheckout(contextA, randomUUID(), reverse),
    ]);

    expect(results).toHaveLength(2);
    expect(await listOrders(pool, tenantA.locationId)).toHaveLength(2);
  });

  it("checks stock against the merged quantity when a product appears twice", async () => {
    const scarce = await createProduct(pool, tenantA.locationId, {
      categoryId: null,
      name: "Part unique",
      price: "5.00",
      stockQuantity: 5,
    });

    // 3 + 3 against a stock of 5: per-line checks would each see 3 <= 5 and
    // pass, driving stock to -1.
    await expect(
      runCheckout(
        contextA,
        randomUUID(),
        parseOrThrow(checkoutBodySchema, {
          tableId: null,
          items: [
            { productId: scarce.id, quantity: 3 },
            { productId: scarce.id, quantity: 3 },
          ],
          paymentMethod: "CARD",
          cardAmount: "30.00",
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    const products = await listProducts(pool, tenantA.locationId);
    expect(products.find((row) => row.id === scarce.id)?.stock_quantity).toBe(5);
  });
});
