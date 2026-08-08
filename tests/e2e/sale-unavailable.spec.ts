import { expect, test, type APIRequestContext } from "@playwright/test";

interface CreatedProduct {
  id: number;
  name: string;
}

/**
 * SALE-07's acceptance criterion, verbatim: "aucun échec de stock tardif
 * sans explication et possibilité de corriger le ticket." Each test creates
 * its own isolated product (same reasoning as tests/e2e/sale-catalog.spec.ts:
 * other e2e specs sell from the shared seeded catalog concurrently,
 * fullyParallel), so nothing else can change its stock underneath the test.
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
      name: `Test SALE-07 ${crypto.randomUUID()}`,
      price: "10.00",
      stockQuantity,
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test.describe("SALE-07: unavailable products stay visible but are not addable", () => {
  test("an out-of-stock product is shown greyed out with a Rupture badge and cannot be added", async ({
    page,
  }) => {
    await login(page.request);
    const product = await createProduct(page.request, 0);

    await page.goto("/caisse");
    await page.getByRole("button", { name: /table 1/i }).click();
    const dialog = page.getByRole("dialog");
    const escaped = product.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Scoped to the catalog grid, not the whole dialog: once an item is on
    // the ticket its quantity controls' aria-labels ("Retirer un <name>",
    // "Ajouter un <name>") also contain the product name and would
    // otherwise match this same regex.
    const productButton = dialog
      .locator(".products")
      .getByRole("button", { name: new RegExp(escaped) });

    // Visible (SALE-07's own wording: "visibles mais non ajoutables"), not
    // filtered out of the grid entirely.
    await expect(productButton).toBeVisible();
    await expect(productButton).toContainText(/rupture/i);
    await expect(productButton).toBeDisabled();

    await productButton.click({ force: true }); // disabled buttons swallow real clicks; force to prove add() itself also refuses
    await expect(dialog.locator(".ticket-line")).toHaveCount(0);
  });
});

test.describe("SALE-07: a late stock change is explained and the ticket stays correctable", () => {
  test("stock running out after adding to the ticket produces a named error, keeps the line editable, and greys the item out", async ({
    page,
  }) => {
    await login(page.request);
    const product = await createProduct(page.request, 1);

    await page.goto("/caisse");
    await page.getByRole("button", { name: /table 1/i }).click();
    const dialog = page.getByRole("dialog");
    const escaped = product.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Scoped to the catalog grid — see the sibling describe block above for
    // why: the ticket's own quantity controls also match this regex once
    // the item has been added.
    const productButton = dialog
      .locator(".products")
      .getByRole("button", { name: new RegExp(escaped) });
    await productButton.click();
    await expect(dialog.locator(".ticket-line")).toHaveCount(1);

    // Simulates another sale/adjustment depleting this exact product while
    // the ticket is still open — the race SALE-07 is about, forced
    // deterministically instead of hoped for.
    const stockPatch = await page.request.patch(`/api/products/${product.id}/stock`, {
      data: { quantity: 0 },
    });
    expect(stockPatch.ok()).toBeTruthy();

    await dialog.getByRole("radio", { name: "Espèces" }).click();
    await dialog.getByRole("button", { name: /encaisser/i }).click();

    // Named, not generic — the cashier can see *why* without guessing.
    await expect(dialog.locator(".form-error")).toContainText(product.name);
    await expect(dialog.locator(".form-error")).toContainText(/stock insuffisant/i);

    // Not silently cleared: the line is still there, and still has its
    // remove control — "possibilité de corriger le ticket".
    await expect(dialog.locator(".ticket-line")).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: `Retirer un ${product.name}` })).toBeVisible();

    // The failed attempt's own refetch (order-drawer.tsx's checkout()
    // catch block) is what makes this the same visible state SALE-07's
    // first test proves for a product that was already out of stock at
    // load time — proving the *transition* happens, not just the resting
    // state.
    await expect(productButton).toBeDisabled();

    // Correcting the ticket (removing the now-unavailable line) leaves an
    // empty, submittable-again ticket rather than a stuck one.
    await dialog.getByRole("button", { name: `Retirer un ${product.name}` }).click();
    await expect(dialog.locator(".ticket-line")).toHaveCount(0);
  });
});
