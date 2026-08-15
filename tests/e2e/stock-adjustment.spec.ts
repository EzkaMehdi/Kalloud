import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

interface CreatedProduct {
  id: number;
  name: string;
  stock_quantity: number;
}

/**
 * STK-05. The service and its rules are proven at the integration tier
 * (tests/integration/stock-adjustment.test.ts); this is about the screen.
 *
 * Its own product per test, like every other spec here: the suite runs
 * `fullyParallel` against one seeded tenant, so asserting on a shared
 * product's balance would be a race rather than a proof.
 *
 * Every test also asserts that `window.prompt` was never called. That is the
 * acceptance criterion in its most literal form, and it is worth pinning:
 * the native prompt is exactly the kind of thing that comes back one day in
 * a hurry, and a browser may silently decline to show it (Chrome stops
 * honouring dialogs once a page has been asked to stop creating them), which
 * turns a click into nothing at all with no error to read.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.prompt = () => {
      (window as unknown as { __promptCalled?: boolean }).__promptCalled = true;
      return null;
    };
  });
});

async function expectNoNativePrompt(page: Page) {
  const called = await page.evaluate(
    () => (window as unknown as { __promptCalled?: boolean }).__promptCalled ?? false,
  );
  expect(called, "the screen must not fall back on window.prompt()").toBe(false);
}

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
      name: `Test STK-05 ${crypto.randomUUID()}`,
      price: "4.00",
      stockQuantity,
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

/**
 * The page's own notice. Scoped by class rather than by role alone:
 * AsyncSection's loading state is also a `role="status"` live region, so
 * `getByRole("status")` matches two elements while the list is refetching.
 */
function noticeOf(page: Page) {
  return page.locator("div.status[role='status']");
}

function rowOf(page: Page, product: CreatedProduct) {
  return page.locator(".stock-row").filter({ hasText: product.name });
}

/**
 * The row's badge doubles as its adjust button ("En stock · +"), and since
 * STK-07 it sits next to a "Compter" one — so the button is named rather
 * than taken as "the row's button".
 */
function adjustButtonOf(page: Page, product: CreatedProduct) {
  return rowOf(page, product).getByRole("button", { name: /ajouter du stock/i });
}

test.describe("STK-05: adjusting stock through a real form", () => {
  test("records a loss from the product's own row, with its type and motive", async ({ page }) => {
    await login(page.request);
    const product = await createProduct(page.request, 12);

    await page.goto("/stock");
    await adjustButtonOf(page, product).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Contextual: the dialog knows which product, and says where it starts.
    await expect(dialog).toContainText(product.name);
    await expect(dialog).toContainText("12 unités en stock");

    await dialog.getByLabel(/type de mouvement/i).selectOption("LOSS");
    await dialog.getByLabel(/quantité/i).fill("3");
    // The consequence is stated before it is committed — the prompt could
    // not say what the balance would become.
    await expect(dialog).toContainText("Nouveau solde : 9 unités");
    await dialog.getByLabel(/motif/i).fill("Casse en cuisine");
    await dialog.getByRole("button", { name: /enregistrer le mouvement/i }).click();

    await expect(dialog).toHaveCount(0);
    await expect(noticeOf(page)).toContainText("Perte ou casse");
    await expect(rowOf(page, product)).toContainText("9 unités");

    // That the type and motive reach the ledger is asserted where the ledger
    // is readable — tests/integration/stock-adjustment.test.ts. No endpoint
    // exposes a product's movement history yet (STK-08), and a conditional
    // assertion here would pass by skipping rather than by proving.

    await expectNoNativePrompt(page);
  });

  test("lets the page-level action choose a product, instead of telling the user to", async ({
    page,
  }) => {
    await login(page.request);
    const product = await createProduct(page.request, 4);

    await page.goto("/stock");
    // The prototype's version of this button only ever produced
    // `alert("Sélectionnez un produit pour le recharger.")`.
    await page.getByRole("button", { name: /^recharger$/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/produit/i).selectOption({ label: `${product.name} — 4 unités` });
    await dialog.getByLabel(/quantité/i).fill("6");
    await dialog.getByLabel(/motif/i).fill("Livraison du mardi");
    await dialog.getByRole("button", { name: /enregistrer le mouvement/i }).click();

    await expect(dialog).toHaveCount(0);
    await expect(rowOf(page, product)).toContainText("10 unités");
    await expectNoNativePrompt(page);
  });

  test("asks which way a correction goes, since it is the one type that may go either", async ({
    page,
  }) => {
    await login(page.request);
    const product = await createProduct(page.request, 8);

    await page.goto("/stock");
    await adjustButtonOf(page, product).click();
    const dialog = page.getByRole("dialog");

    // Absent for a receipt: the type already states the direction (DEC-06).
    await expect(dialog.getByRole("radio", { name: /retirer/i })).toHaveCount(0);

    await dialog.getByLabel(/type de mouvement/i).selectOption("CORRECTION");
    await dialog.getByRole("radio", { name: /retirer/i }).click();
    await dialog.getByLabel(/quantité/i).fill("3");
    await expect(dialog).toContainText("Nouveau solde : 5 unités");
    await dialog.getByLabel(/motif/i).fill("Écart constaté à l'inventaire");
    await dialog.getByRole("button", { name: /enregistrer le mouvement/i }).click();

    await expect(rowOf(page, product)).toContainText("5 unités");
    await expectNoNativePrompt(page);
  });

  test("shows the server's refusal without discarding what was typed", async ({ page }) => {
    await login(page.request);
    const product = await createProduct(page.request, 2);

    await page.goto("/stock");
    await adjustButtonOf(page, product).click();
    const dialog = page.getByRole("dialog");

    // A loss larger than the balance: refused server-side (DEC-06), because
    // only a CORRECTION may land below zero.
    await dialog.getByLabel(/type de mouvement/i).selectOption("LOSS");
    await dialog.getByLabel(/quantité/i).fill("9");
    await dialog.getByLabel(/motif/i).fill("Inventaire erroné");
    await dialog.getByRole("button", { name: /enregistrer le mouvement/i }).click();

    await expect(dialog.getByRole("alert")).toContainText(/stock insuffisant/i);
    // UX-05: the dialog stays, with the values intact — the server may be
    // refusing precisely this amount, and retyping it is not the fix.
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/quantité/i)).toHaveValue("9");
    await expect(dialog.getByLabel(/motif/i)).toHaveValue("Inventaire erroné");
    await expect(rowOf(page, product)).toContainText("2 unités");

    await expectNoNativePrompt(page);
  });
});

/**
 * STK-06: the four operations DEC-06 defines are reachable from the screen,
 * not merely from the API. `RETURN` is the one the dialog had never been
 * driven to produce — the others are exercised by the tests above — and it
 * is also the one whose direction is least obvious from its name, so the
 * balance assertion is what makes "signed correctly" visible.
 */
test.describe("STK-06: every MVP operation is reachable from the screen", () => {
  test("records a customer return, which adds to the balance", async ({ page }) => {
    await login(page.request);
    const product = await createProduct(page.request, 5);

    await page.goto("/stock");
    await adjustButtonOf(page, product).click();
    const dialog = page.getByRole("dialog");

    await dialog.getByLabel(/type de mouvement/i).selectOption("RETURN");
    await dialog.getByLabel(/quantité/i).fill("2");
    // A return comes *in*, like a receipt — stated by the type, never typed
    // as a sign by the user (DEC-06).
    await expect(dialog).toContainText("Nouveau solde : 7 unités");
    await dialog.getByLabel(/motif/i).fill("Retour client, article non ouvert");
    await dialog.getByRole("button", { name: /enregistrer le mouvement/i }).click();

    await expect(dialog).toHaveCount(0);
    await expect(noticeOf(page)).toContainText("Retour");
    await expect(rowOf(page, product)).toContainText("7 unités");
    await expectNoNativePrompt(page);
  });

  test("offers exactly the four operations, and no system-only one", async ({ page }) => {
    await login(page.request);
    await createProduct(page.request, 3);

    await page.goto("/stock");
    await page.getByRole("button", { name: /^recharger$/i }).click();
    const options = await page
      .getByRole("dialog")
      .getByLabel(/type de mouvement/i)
      .locator("option")
      .allTextContents();

    expect(options).toEqual([
      "Réception de marchandise",
      "Correction d'écart",
      "Perte ou casse",
      "Retour",
    ]);
    // SALE and OPENING_BALANCE belong to the checkout and to product
    // creation; offering either here would let a user forge a sale's stock
    // effect without a sale.
    expect(options.join(" ")).not.toMatch(/vente|ouverture/i);
  });
});
