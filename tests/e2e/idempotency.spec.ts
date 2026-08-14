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

/**
 * Opens a counter ticket holding `lines` and returns its id.
 *
 * ORD-07 removed the "post a line list and get a paid order" shape these
 * tests used: a checkout now names the ticket it settles, so each case has
 * to create one first. That is also what keeps them isolated from each
 * other — a ticket per test, not a shared basket.
 */
async function openTicketWith(
  request: APIRequestContext,
  lines: { productId: number; quantity: number }[],
): Promise<number> {
  const opened = await request.post("/api/tickets", { data: { tableId: null } });
  expect(opened.ok(), "opening a counter ticket must succeed").toBeTruthy();
  const ticket = (await opened.json()).ticket as { id: number; version: number };
  const saved = await request.put(`/api/tickets/${ticket.id}/items`, {
    data: { version: ticket.version, items: lines },
  });
  expect(saved.ok(), "saving the ticket's lines must succeed").toBeTruthy();
  return ticket.id;
}

async function createIsolatedProduct(request: APIRequestContext): Promise<ProductRow> {
  const response = await request.post("/api/products", {
    data: {
      categoryId: null,
      name: `Test API-02 ${crypto.randomUUID()}`,
      price: "10.00",
      stockQuantity: 5,
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

// ORD-01: these tests all read/write /api/orders and /api/checkout against
// the one shared seeded tenant (owner@kalloud.test). Two distinct races
// were found here, not one: .serial() stops this file's own five tests
// from racing each other (one test's checkout landing between another's
// "before" and "after" reads on a shared /api/orders count). It does
// nothing for a different file's tests running concurrently in another
// worker (SALE-04/05/06's e2e specs, added later, all sell too) — that
// race is closed per-test instead, by having each test that needs to prove
// "exactly one/zero sales happened" create and check its own dedicated
// product rather than reading a count shared with every other spec file.

test.describe.serial("API-02: idempotent checkout over HTTP", () => {
  test("a double-clicked payment creates exactly one sale", async ({ request }) => {
    await loginAsOwner(request);

    // Dedicated product, same reasoning as "a checkout without the header"
    // below: a shared /api/orders list's length is not safe to compare
    // before/after while other e2e specs sell concurrently. Its own stock
    // is a targeted, concurrency-safe stand-in for "exactly one sale went
    // through" — STK-03/SALE-03 guarantee the decrement matches the
    // quantity sold, atomically, so "-1" here can only mean one sale.
    const product = await createIsolatedProduct(request);
    const key = crypto.randomUUID();
    const orderId = await openTicketWith(request, [{ productId: product.id, quantity: 1 }]);
    const body = { orderId, paymentMethod: "CARD" };

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

    const productsAfter: ProductRow[] = await (await request.get("/api/products")).json();
    const after = productsAfter.find((row) => row.id === product.id);
    expect(after?.stock_quantity).toBe(product.stock_quantity - 1);
  });

  test("a sequential retry replays the recorded sale rather than repeating it", async ({
    request,
  }) => {
    await loginAsOwner(request);

    // Its own product rather than the first sellable seeded one, like the
    // rest of this file: a sale on a seeded product leaves a counter ticket
    // that no cleanup can tell apart from a real one (tests/e2e/global-
    // teardown.ts matches on the test naming convention), so every run used
    // to add permanent clutter to a developer's caisse.
    const sellable = await createIsolatedProduct(request);

    const key = crypto.randomUUID();
    const orderId = await openTicketWith(request, [{ productId: sellable.id, quantity: 1 }]);
    const body = { orderId, paymentMethod: "CARD" };

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

    // Own product, same reason as above.
    const sellable = await createIsolatedProduct(request);
    const key = crypto.randomUUID();

    const firstTicket = await openTicketWith(request, [{ productId: sellable.id, quantity: 1 }]);
    const secondTicket = await openTicketWith(request, [{ productId: sellable.id, quantity: 2 }]);

    const first = await request.post("/api/checkout", {
      headers: { "Idempotency-Key": key },
      data: { orderId: firstTicket, paymentMethod: "CARD" },
    });
    expect(first.status()).toBe(201);

    // Same key, a genuinely different request: another ticket entirely.
    const different = await request.post("/api/checkout", {
      headers: { "Idempotency-Key": key },
      data: { orderId: secondTicket, paymentMethod: "CARD" },
    });
    expect(different.status()).toBe(409);
    expect((await different.json()).error.code).toBe("CONFLICT");
  });

  test("a checkout without the header is refused before anything is recorded", async ({
    request,
  }) => {
    await loginAsOwner(request);

    // A dedicated product, not one picked from the shared seeded catalog:
    // other e2e specs sell concurrently against that catalog
    // (fullyParallel), so comparing a shared /api/orders list's length
    // before/after would be the same race already found and fixed once in
    // this file (see the comment above test.describe.serial) — this time
    // across files rather than within this one. The route reads the
    // Idempotency-Key header before it even parses the body (see
    // app/api/checkout/route.ts's own comment on that ordering), so this
    // product's own stock is untouched regardless of what else is
    // happening in the shared tenant at the same time — a targeted,
    // concurrency-safe proof instead of a global one.
    const product = await createIsolatedProduct(request);

    const orderId = await openTicketWith(request, [{ productId: product.id, quantity: 1 }]);
    const response = await request.post("/api/checkout", {
      data: { orderId, paymentMethod: "CARD" },
    });

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");

    const productsAfter: ProductRow[] = await (await request.get("/api/products")).json();
    const after = productsAfter.find((row) => row.id === product.id);
    expect(after?.stock_quantity).toBe(product.stock_quantity);
  });

  test("an invalid body is rejected with per-field detail (API-01)", async ({ request }) => {
    await loginAsOwner(request);

    const response = await request.post("/api/checkout", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: { orderId: 1, paymentMethod: "MIXED" },
    });

    expect(response.status()).toBe(400);
    const envelope = await response.json();
    expect(envelope.error.code).toBe("VALIDATION_ERROR");
    // ORD-07 removed `items` from this body, so the field-level detail is
    // now demonstrated on the payment split instead.
    expect(envelope.error.details[0].field).toBe("cashAmount");
  });
});
