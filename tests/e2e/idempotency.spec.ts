import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * API-02 across the real HTTP boundary: session cookie, proxy.ts, route
 * handler and database, on a running server. The integration suite proves
 * the service behaviour; what only this tier can prove is that the
 * `Idempotency-Key` header actually survives the request path — nothing
 * strips it — and that the route wires the mechanism in at all.
 *
 * Runs against the seeded dev tenant (scripts/seed.mjs), like
 * tests/e2e/auth.spec.ts.
 */

interface ProductRow {
  id: number;
  name: string;
  price: string;
  stock_quantity: number;
  is_active: boolean;
}

interface OrderRow {
  id: number;
}

async function loginAsOwner(request: APIRequestContext) {
  const response = await request.post("/api/auth/login", {
    data: { email: "owner@kalloud.test", password: "Kalloud123!" },
  });
  expect(response.ok(), "the seeded owner must be able to log in").toBeTruthy();
}

// ORD-01: these tests all read/write /api/orders and /api/checkout against
// the one shared seeded tenant (owner@kalloud.test), asserting on the raw
// before/after order count. Under Playwright's default fullyParallel mode
// that made them race each other — one test's checkout could land between
// another's "before" and "after" reads, so the count that "should" be +1
// came out +2 or +3 depending on scheduling (non-deterministic: which test
// failed changed between runs). .serial() removes the ambiguity these
// specific assertions have no way to survive, without changing what any of
// them actually tests.
test.describe.serial("API-02: idempotent checkout over HTTP", () => {
  test("a double-clicked payment creates exactly one sale", async ({ request }) => {
    await loginAsOwner(request);

    const products: ProductRow[] = await (await request.get("/api/products")).json();
    const sellable = products.find((product) => product.is_active && product.stock_quantity > 2);
    expect(sellable, "the seed must provide a sellable product").toBeTruthy();

    const ordersBefore: OrderRow[] = await (await request.get("/api/orders")).json();
    const key = crypto.randomUUID();
    const body = {
      tableId: null,
      items: [{ productId: sellable!.id, quantity: 1 }],
      paymentMethod: "CARD",
      cashAmount: "0.00",
      cardAmount: Number(sellable!.price).toFixed(2),
    };

    // Two clicks in flight at once, carrying the same key — the exact
    // scenario DEC-08 describes.
    const [first, second] = await Promise.all([
      request.post("/api/checkout", { headers: { "Idempotency-Key": key }, data: body }),
      request.post("/api/checkout", { headers: { "Idempotency-Key": key }, data: body }),
    ]);

    const statuses = [first.status(), second.status()].sort();
    // Either the second replays the first's 201, or it is told the first is
    // still running (409). Never two independent creations.
    expect(statuses[0]).toBe(201);
    expect([201, 409]).toContain(statuses[1]);

    const ordersAfter: OrderRow[] = await (await request.get("/api/orders")).json();
    expect(ordersAfter.length).toBe(ordersBefore.length + 1);
  });

  test("a sequential retry replays the recorded sale rather than repeating it", async ({
    request,
  }) => {
    await loginAsOwner(request);

    const products: ProductRow[] = await (await request.get("/api/products")).json();
    const sellable = products.find((product) => product.is_active && product.stock_quantity > 2)!;

    const key = crypto.randomUUID();
    const body = {
      tableId: null,
      items: [{ productId: sellable.id, quantity: 1 }],
      paymentMethod: "CARD",
      cashAmount: "0.00",
      cardAmount: Number(sellable.price).toFixed(2),
    };

    const first = await request.post("/api/checkout", {
      headers: { "Idempotency-Key": key },
      data: body,
    });
    expect(first.status()).toBe(201);
    const firstOrder = (await first.json()).order as OrderRow;

    const retry = await request.post("/api/checkout", {
      headers: { "Idempotency-Key": key },
      data: body,
    });
    expect(retry.status()).toBe(201);
    expect(retry.headers()["idempotent-replay"]).toBe("true");
    expect(((await retry.json()).order as OrderRow).id).toBe(firstOrder.id);
  });

  test("the same key with a different payload is refused", async ({ request }) => {
    await loginAsOwner(request);

    const products: ProductRow[] = await (await request.get("/api/products")).json();
    const sellable = products.find((product) => product.is_active && product.stock_quantity > 3)!;
    const key = crypto.randomUUID();
    const price = Number(sellable.price);

    const first = await request.post("/api/checkout", {
      headers: { "Idempotency-Key": key },
      data: {
        tableId: null,
        items: [{ productId: sellable.id, quantity: 1 }],
        paymentMethod: "CARD",
        cashAmount: "0.00",
        cardAmount: price.toFixed(2),
      },
    });
    expect(first.status()).toBe(201);

    const different = await request.post("/api/checkout", {
      headers: { "Idempotency-Key": key },
      data: {
        tableId: null,
        items: [{ productId: sellable.id, quantity: 2 }],
        paymentMethod: "CARD",
        cashAmount: "0.00",
        cardAmount: (price * 2).toFixed(2),
      },
    });
    expect(different.status()).toBe(409);
    expect((await different.json()).error.code).toBe("CONFLICT");
  });

  test("a checkout without the header is refused before anything is recorded", async ({
    request,
  }) => {
    await loginAsOwner(request);

    const products: ProductRow[] = await (await request.get("/api/products")).json();
    const sellable = products.find((product) => product.is_active && product.stock_quantity > 2)!;
    const ordersBefore: OrderRow[] = await (await request.get("/api/orders")).json();

    const response = await request.post("/api/checkout", {
      data: {
        tableId: null,
        items: [{ productId: sellable.id, quantity: 1 }],
        paymentMethod: "CARD",
        cashAmount: "0.00",
        cardAmount: Number(sellable.price).toFixed(2),
      },
    });

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");

    const ordersAfter: OrderRow[] = await (await request.get("/api/orders")).json();
    expect(ordersAfter.length).toBe(ordersBefore.length);
  });

  test("an invalid body is rejected with per-field detail (API-01)", async ({ request }) => {
    await loginAsOwner(request);

    const response = await request.post("/api/checkout", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: {
        tableId: null,
        items: [{ productId: 1, quantity: 0 }],
        paymentMethod: "CARD",
        cardAmount: "5.00",
      },
    });

    expect(response.status()).toBe(400);
    const envelope = await response.json();
    expect(envelope.error.code).toBe("VALIDATION_ERROR");
    expect(envelope.error.details[0].field).toBe("items[0].quantity");
  });
});
