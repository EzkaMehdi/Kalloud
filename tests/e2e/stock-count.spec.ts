import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

interface CreatedProduct {
  id: number;
  name: string;
  stock_quantity: number;
}

/**
 * STK-07 through the browser. The service's invariants — the écart, the
 * `CORRECTION` and its cross-reference, the balance read under lock — are
 * proven at the integration tier (tests/integration/stock-count.test.ts).
 * What only this tier shows is the acceptance criterion's own word:
 * "consultables". The five figures have to be *readable by a person*, and a
 * count that matched has to leave something to read at all.
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
      name: `Test STK-07 ${crypto.randomUUID()}`,
      price: "3.00",
      stockQuantity,
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

function rowOf(page: Page, product: CreatedProduct) {
  return page.locator(".stock-row").filter({ hasText: product.name });
}

async function openCount(page: Page, product: CreatedProduct) {
  await rowOf(page, product)
    .getByRole("button", { name: /^compter/i })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("STK-07: counting a product physically", () => {
  test("states the écart before committing it, then corrects the balance", async ({ page }) => {
    await login(page.request);
    const product = await createProduct(page.request, 10);

    await page.goto("/stock");
    const dialog = await openCount(page, product);

    await expect(dialog).toContainText("stock théorique");
    await expect(dialog).toContainText("10 unités");
    // Never counted before: the history says so rather than showing nothing.
    await expect(dialog).toContainText(/jamais été compté/i);

    await dialog.getByLabel(/quantité comptée/i).fill("7");
    // The consequence is spelled out before the user commits to it.
    await expect(dialog).toContainText("Écart de");
    await expect(dialog).toContainText("amener le stock à 7 unités");

    await dialog.getByLabel(/note/i).fill("Inventaire de fin de mois");
    await dialog.getByRole("button", { name: /enregistrer le comptage/i }).click();

    await expect(dialog).toHaveCount(0);
    await expect(rowOf(page, product)).toContainText("7 unités");
  });

  test("makes the five figures readable afterwards", async ({ page }) => {
    await login(page.request);
    const product = await createProduct(page.request, 12);

    await page.goto("/stock");
    let dialog = await openCount(page, product);
    await dialog.getByLabel(/quantité comptée/i).fill("15");
    await dialog.getByLabel(/note/i).fill("Recomptage");
    await dialog.getByRole("button", { name: /enregistrer le comptage/i }).click();
    await expect(dialog).toHaveCount(0);

    dialog = await openCount(page, product);
    const history = dialog.locator(".history-card");
    // stock avant → compté, l'écart, l'auteur, la date, et la note.
    await expect(history).toContainText("12 → 15 unités");
    await expect(history).toContainText("+3");
    await expect(history).toContainText("Amine");
    await expect(history).toContainText("Recomptage");
    // The theoretical figure now reflects the correction the count wrote.
    await expect(dialog).toContainText("15 unités");
  });

  /**
   * The case the dedicated table exists for: `quantity <> 0` forbids an
   * empty movement, so a matching count would otherwise vanish — yet it is
   * exactly the outcome an inventory hopes for, and the one a manager needs
   * to know happened.
   */
  test("records a count that matched, which leaves no movement to point at", async ({ page }) => {
    await login(page.request);
    const product = await createProduct(page.request, 6);

    await page.goto("/stock");
    let dialog = await openCount(page, product);
    await dialog.getByLabel(/quantité comptée/i).fill("6");
    await expect(dialog).toContainText(/aucun écart/i);
    await dialog.getByRole("button", { name: /enregistrer le comptage/i }).click();

    await expect(dialog).toHaveCount(0);
    await expect(rowOf(page, product)).toContainText("6 unités");

    dialog = await openCount(page, product);
    await expect(dialog.locator(".history-card")).toContainText("6 → 6 unités");
    await expect(dialog.locator(".history-card")).toContainText("conforme");
  });
});
