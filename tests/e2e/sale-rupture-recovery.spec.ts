import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

interface CreatedProduct {
  id: number;
  name: string;
  stock_quantity: number;
}

/**
 * SALE-10's acceptance criterion, verbatim: "aucune rupture n'aboutit à un
 * échec tardif incompréhensible." SALE-07's own tests
 * (tests/e2e/sale-unavailable.spec.ts) already prove the two most direct
 * readings of this — an already-unavailable product visible-but-not-
 * addable, and a single-item ticket that fails cleanly with a named error
 * and a correctable line. This file proves the two angles that were still
 * open after that: a ticket with *more than one* item, where the recovery
 * has to actually reach a completed sale (not just an emptied ticket) —
 * and the *other* way a product goes unavailable (deactivated, not merely
 * out of stock), which checkout.ts deliberately routes through a
 * differently-worded, generic error (see its own comment: "Not found and
 * inactive are indistinguishable here on purpose").
 *
 * Each test creates its own isolated products, for the same reason as
 * every other e2e spec in this suite (tests/e2e/sale-catalog.spec.ts):
 * fullyParallel specs share one seeded tenant, so a shared product's stock
 * or active flag would be a race, not a proof.
 */

async function login(request: APIRequestContext) {
  const response = await request.post("/api/auth/login", {
    data: { email: "owner@kalloud.test", password: "Kalloud123!" },
  });
  expect(response.ok()).toBeTruthy();
}

async function createProduct(
  request: APIRequestContext,
  stockQuantity: number,
): Promise<CreatedProduct> {
  const response = await request.post("/api/products", {
    data: {
      categoryId: null,
      name: `Test SALE-10 ${crypto.randomUUID()}`,
      price: "6.00",
      stockQuantity,
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function addToTicket(dialog: ReturnType<Page["getByRole"]>, product: CreatedProduct) {
  const escaped = product.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await dialog
    .locator(".products")
    .getByRole("button", { name: new RegExp(escaped) })
    .click();
}

test.describe("SALE-10: recovering from a rupture reaches a completed sale, not just an empty ticket", () => {
  test("removing the one line that ran out lets the rest of a multi-item ticket check out normally", async ({
    page,
  }) => {
    await login(page.request);
    const keeper = await createProduct(page.request, 5);
    const runsOut = await createProduct(page.request, 1);

    await page.goto("/caisse");
    await page.getByRole("button", { name: /table 1/i }).click();
    const dialog = page.getByRole("dialog");
    await addToTicket(dialog, keeper);
    await addToTicket(dialog, runsOut);
    await expect(dialog.locator(".ticket-line")).toHaveCount(2);

    // Someone else sells the last unit of `runsOut` while this ticket is
    // still open — the exact race SALE-07 targets, forced deterministically.
    const patch = await page.request.patch(`/api/products/${runsOut.id}/stock`, {
      data: { quantity: 0 },
    });
    expect(patch.ok()).toBeTruthy();

    await dialog.getByRole("radio", { name: "Espèces" }).click();
    await dialog.getByRole("button", { name: /encaisser/i }).click();

    // The error names the product that actually failed, not a generic
    // "something went wrong" that would leave the cashier guessing which
    // of the two lines to remove.
    await expect(dialog.locator(".form-error")).toContainText(runsOut.name);

    // Both lines survive the failed attempt — nothing about a checkout
    // failure clears a ticket the cashier still needs to work with.
    await expect(dialog.locator(".ticket-line")).toHaveCount(2);

    await dialog.getByRole("button", { name: `Retirer un ${runsOut.name}` }).click();
    await expect(dialog.locator(".ticket-line")).toHaveCount(1);

    // The actual proof of "correction du ticket": not just an empty
    // drawer, but a sale that now completes with what is left.
    await dialog.getByRole("button", { name: /encaisser/i }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/vente encaissée/i)).toBeVisible();

    const productsAfter: CreatedProduct[] = await (await page.request.get("/api/products")).json();
    // The kept item sold normally...
    expect(productsAfter.find((row) => row.id === keeper.id)?.stock_quantity).toBe(4);
    // ...and the removed one was never touched by this sale — its stock is
    // still exactly what the direct PATCH above set, not decremented again.
    expect(productsAfter.find((row) => row.id === runsOut.id)?.stock_quantity).toBe(0);
  });

  test("a product deactivated mid-ticket fails with a generic-but-safe message, and the catalog visibly marks it unavailable", async ({
    page,
  }) => {
    await login(page.request);
    const product = await createProduct(page.request, 5);

    await page.goto("/caisse");
    await page.getByRole("button", { name: /table 1/i }).click();
    const dialog = page.getByRole("dialog");
    await addToTicket(dialog, product);
    await expect(dialog.locator(".ticket-line")).toHaveCount(1);

    // Deactivation is a different rupture path than depletion: plenty of
    // stock remains, but checkout.ts's own lockProductsForSale filters on
    // is_active, so this fails as "not found" rather than "insufficient
    // stock" — checkout.ts documents that the two are made deliberately
    // indistinguishable in the error text, to avoid leaking which case
    // applies. What still has to hold is that the failure is not a dead
    // end: the message must not blame the cashier for a bad request, and
    // the catalog above must visibly explain the situation once it
    // refetches, even though the inline text alone does not name the
    // product.
    const patch = await page.request.patch(`/api/products/${product.id}`, {
      data: { isActive: false },
    });
    expect(patch.ok()).toBeTruthy();

    await dialog.getByRole("radio", { name: "Espèces" }).click();
    await dialog.getByRole("button", { name: /encaisser/i }).click();

    await expect(dialog.locator(".form-error")).toContainText(/introuvable/i);
    // Still correctable, same as every other rupture case: the line and
    // its removal control remain in place.
    await expect(dialog.locator(".ticket-line")).toHaveCount(1);

    // The checkout's own refetch (order-drawer.tsx) turns the otherwise
    // unnamed failure into a visible one: this exact product is now
    // greyed out and badged in the grid above, closing the gap a generic
    // message alone would leave.
    const escaped = product.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const productButton = dialog
      .locator(".products")
      .getByRole("button", { name: new RegExp(escaped) });
    await expect(productButton).toContainText(/rupture/i);
    await expect(productButton).toBeDisabled();

    // Correctable: removing it leaves a submittable-again, empty ticket.
    await dialog.getByRole("button", { name: `Retirer un ${product.name}` }).click();
    await expect(dialog.locator(".ticket-line")).toHaveCount(0);
  });
});
