import { expect, test } from "@playwright/test";
import { createThrowawayTenant, type ThrowawayTenant } from "./helpers/tenant";

/**
 * OPS-08B: "revue différentielle des interfaces et endpoints P1 ajoutés
 * après le socle critique."
 *
 * The differential is what the audit found: `SEC-08`'s browser-level
 * isolation spec covers exactly **one** endpoint that takes an id
 * (`/api/products/[id]`), while the product now has **twelve** — receipt,
 * refund, stock counts, the four ticket routes, categories, tables, team.
 * Almost all of them arrived after the security base was signed off, and
 * none had ever been asked the one question that matters for them: what
 * happens when the id belongs to somebody else?
 *
 * The answer, verified here, is `404` everywhere — not `403`, which would
 * confirm the row exists. Nothing leaked and nothing was writable. This
 * spec exists so that stays true for the thirteenth endpoint.
 */

interface Victim {
  productId: number;
  tableId: number;
  categoryId: number;
  ticketId: number;
  orderId: number;
  ownerUserId: number;
}

test.describe.serial("OPS-08B: another tenant's ids reach nothing", () => {
  let victim: ThrowawayTenant;
  let attacker: ThrowawayTenant;
  let owned: Victim;

  test.beforeAll(async ({ browser }) => {
    victim = await createThrowawayTenant("VICTIME");
    attacker = await createThrowawayTenant("ATTAQUANT");

    // One of everything, built by the victim through their own session.
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await victim.login(page);
      const product = await (
        await page.request.post("/api/products", {
          data: {
            categoryId: null,
            name: `Test OPS-08B ${crypto.randomUUID()}`,
            price: "5.00",
            stockQuantity: 10,
          },
        })
      ).json();
      const table = await (
        await page.request.post("/api/tables", {
          data: { name: `T-${crypto.randomUUID().slice(0, 6)}` },
        })
      ).json();
      const category = await (
        await page.request.post("/api/categories", {
          data: { name: `Cat ${crypto.randomUUID().slice(0, 6)}` },
        })
      ).json();
      await page.request.post("/api/business-day", { data: { openingCash: "50.00" } });
      const ticket = (
        await (await page.request.post("/api/tickets", { data: { tableId: table.id } })).json()
      ).ticket;
      await page.request.put(`/api/tickets/${ticket.id}/items`, {
        data: { version: ticket.version, items: [{ productId: product.id, quantity: 1 }] },
      });
      // A real stock count: without one, an empty array would prove nothing
      // about scoping — it is what a non-existent product returns too.
      await page.request.post(`/api/products/${product.id}/stock-counts`, {
        data: { countedQuantity: 7, note: "comptage victime" },
      });
      const paid = await (
        await page.request.post("/api/checkout", {
          data: { orderId: ticket.id, paymentMethod: "CARD" },
          headers: { "Idempotency-Key": crypto.randomUUID() },
        })
      ).json();

      owned = {
        productId: product.id,
        tableId: table.id,
        categoryId: category.id,
        ticketId: ticket.id,
        orderId: paid.order?.id ?? ticket.id,
        ownerUserId: victim.ownerUserId,
      };
    } finally {
      await context.close();
    }
  });

  test.afterAll(async () => {
    await attacker.dispose();
    await victim.dispose();
  });

  test("every id-taking endpoint answers 'introuvable', never 'interdit'", async ({ page }) => {
    await attacker.login(page);

    // `404` rather than `403` throughout, deliberately: a refusal that says
    // "you may not touch this" confirms the row exists, and an id is easy
    // to guess. "It is not there" is the honest answer to someone for whom
    // it genuinely is not.
    const probes: [string, Promise<{ status(): number }>][] = [
      [
        "POST /api/products/:id/stock",
        page.request.post(`/api/products/${owned.productId}/stock`, {
          data: { delta: 5, type: "RECEIPT", reason: "sonde" },
        }),
      ],
      [
        "PATCH /api/products/:id",
        page.request.patch(`/api/products/${owned.productId}`, { data: { isActive: false } }),
      ],
      [
        "POST /api/products/:id/stock-counts",
        page.request.post(`/api/products/${owned.productId}/stock-counts`, {
          data: { countedQuantity: 1 },
        }),
      ],
      [
        "PUT /api/categories/:id",
        page.request.put(`/api/categories/${owned.categoryId}`, { data: { name: "détourné" } }),
      ],
      [
        "PATCH /api/tables/:id",
        page.request.patch(`/api/tables/${owned.tableId}`, { data: { name: "détourné" } }),
      ],
      ["GET /api/tickets/:id", page.request.get(`/api/tickets/${owned.ticketId}`)],
      [
        "PUT /api/tickets/:id/items",
        page.request.put(`/api/tickets/${owned.ticketId}/items`, {
          data: { version: 1, items: [] },
        }),
      ],
      [
        "POST /api/tickets/:id/cancel",
        page.request.post(`/api/tickets/${owned.ticketId}/cancel`, { data: { reason: "sonde" } }),
      ],
      [
        "PUT /api/tickets/:id/discount",
        page.request.put(`/api/tickets/${owned.ticketId}/discount`, {
          data: { version: 1, discount: { type: "PERCENT", value: 5, reason: "sonde" } },
        }),
      ],
      ["GET /api/orders/:id/receipt", page.request.get(`/api/orders/${owned.orderId}/receipt`)],
      [
        "POST /api/orders/:id/refund",
        page.request.post(`/api/orders/${owned.orderId}/refund`, {
          data: { reason: "sonde" },
          headers: { "Idempotency-Key": crypto.randomUUID() },
        }),
      ],
      [
        "PATCH /api/team/:userId",
        page.request.patch(`/api/team/${owned.ownerUserId}`, { data: { role: "CASHIER" } }),
      ],
    ];

    for (const [label, pending] of probes) {
      const response = await pending;
      expect(response.status(), `${label} doit répondre 404`).toBe(404);
    }
  });

  test("a scoped list hands back nothing rather than somebody else's rows", async ({ page }) => {
    await attacker.login(page);

    // The twelfth endpoint answers `200 []` rather than 404, and that is
    // correct: it is a list, and a list of nothing is what a stranger owns
    // here. What had to be checked is that it is genuinely scoped — the
    // victim's product *has* a count, so an unscoped read would return it.
    const response = await page.request.get(`/api/products/${owned.productId}/stock-counts`);
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  test("the victim still sees their own count, so the check above means something", async ({
    page,
  }) => {
    await victim.login(page);
    const counts = await (
      await page.request.get(`/api/products/${owned.productId}/stock-counts`)
    ).json();
    expect(counts.length, "sans cette ligne, le tableau vide ci-dessus ne prouverait rien").toBe(1);
  });

  test("the tenant can never be chosen by the caller", async ({ page }) => {
    await attacker.login(page);

    // Scoping comes from the session, never from the request. A body key
    // that tries is rejected outright (`strictObject`); a query parameter
    // that tries is ignored.
    const rejected = await page.request.post("/api/products", {
      data: { categoryId: null, name: "Sonde", price: "1.00", locationId: 99 },
    });
    expect(rejected.status()).toBe(400);
    expect(await rejected.text()).toContain("locationId");

    const own = await (await page.request.get("/api/orders?limit=5")).json();
    const spoofed = await (await page.request.get("/api/orders?limit=5&locationId=99")).json();
    expect(spoofed.total, "le paramètre ne doit rien changer").toBe(own.total);
  });

  test("pagination cannot be used to pull the whole table", async ({ page }) => {
    await attacker.login(page);
    for (const query of ["limit=999999", "limit=-1", "from=notadate"]) {
      const response = await page.request.get(`/api/orders?${query}`);
      expect(response.status(), `${query} doit être refusé`).toBe(400);
    }
  });
});
