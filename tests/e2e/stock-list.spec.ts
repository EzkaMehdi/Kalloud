import { expect, test, type Page } from "@playwright/test";
import { createThrowawayTenant, type ThrowawayTenant } from "./helpers/tenant";

/**
 * STK-08. Its acceptance has two halves, and the first is a claim the screen
 * must *not* make: "« temps réel » utilisé uniquement si garanti". DEC-08
 * rules out live push for the MVP, so the prototype's "Inventaire en temps
 * réel" was a promise nothing kept. UX-01 already removed the words; what
 * had no guard is that they stay removed.
 *
 * The second half — "alertes fondées sur le solde serveur" — is about the
 * badges being a reading of what the server holds rather than of what this
 * tab last believed, which is also what makes the focus revalidation worth
 * having.
 *
 * A throwaway establishment: one test needs a catalogue with *no* products
 * at all, which the seeded tenant can never be.
 */

test.describe.serial("STK-08: the stock list is honest about what it knows", () => {
  let tenant: ThrowawayTenant;

  test.beforeAll(async () => {
    tenant = await createThrowawayTenant("STK-08");
  });

  test.afterAll(() => tenant.dispose());

  async function createProduct(page: Page, name: string, stock: number, threshold: number) {
    const response = await page.request.post("/api/products", {
      data: {
        categoryId: null,
        name,
        price: "2.00",
        stockQuantity: stock,
        alertThreshold: threshold,
      },
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }

  test("tells an empty catalogue apart from a search that found nothing", async ({ page }) => {
    await tenant.login(page);
    await page.goto("/stock");

    // Nothing has ever been created for this establishment. The screen used
    // to answer "Aucun produit ne correspond à «  »" — a result for a search
    // nobody ran.
    await expect(page.getByText(/aucun produit dans le catalogue/i)).toBeVisible();

    await createProduct(page, "Sirop de menthe", 9, 3);
    await page.reload();
    await expect(page.locator(".stock-row")).toHaveCount(1);

    await page.getByPlaceholder("Rechercher un produit").fill("introuvable");
    await expect(page.getByText(/ne correspond à/i)).toBeVisible();
    // And the two messages are genuinely different, not one text reused.
    await expect(page.getByText(/aucun produit dans le catalogue/i)).toHaveCount(0);
  });

  test("bases its alerts on the server's balance, at the configured threshold", async ({
    page,
  }) => {
    await tenant.login(page);
    await createProduct(page, "Citron vert", 3, 5); // sous le seuil
    await createProduct(page, "Charbon", 0, 2); // rupture
    await page.goto("/stock");

    const row = (name: string) => page.locator(".stock-row").filter({ hasText: name });
    await expect(row("Sirop de menthe")).toContainText("En stock");
    await expect(row("Citron vert")).toContainText("À recharger");
    await expect(row("Charbon")).toContainText("Rupture");

    // The count in the header is the same reading, not a second one.
    await expect(page.getByText(/alerte\(s\) à surveiller/i)).toContainText("2");
  });

  /**
   * DEC-08 has no live push, so this is the honest substitute: the list
   * re-reads when the tab comes back. Simulated the way the browser does it
   * — the events a real tab switch fires — rather than by reloading, which
   * would prove nothing about the page's own behaviour.
   */
  test("re-reads when the tab comes back, rather than trusting what it loaded", async ({
    page,
  }) => {
    await tenant.login(page);
    await page.goto("/stock");
    const row = page.locator(".stock-row").filter({ hasText: "Sirop de menthe" });
    await expect(row).toContainText("9 unités");

    // Another device changes the same product.
    const products = (await (await page.request.get("/api/products")).json()) as {
      id: number;
      name: string;
    }[];
    const syrup = products.find((product) => product.name === "Sirop de menthe")!;
    const adjusted = await page.request.post(`/api/products/${syrup.id}/stock`, {
      data: { delta: 5, type: "RECEIPT", reason: "Livraison saisie sur la tablette" },
    });
    expect(adjusted.ok()).toBeTruthy();

    // Still showing what it loaded — no live push, and none claimed.
    await expect(row).toContainText("9 unités");

    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });

    await expect(row).toContainText("14 unités");
  });

  test("never promises real time, which nothing in the MVP guarantees", async ({ page }) => {
    await tenant.login(page);
    await page.goto("/stock");

    // The prototype's header read "Inventaire en temps réel". DEC-08 has no
    // live push; the guard is that the words do not come back.
    await expect(page.locator("body")).not.toContainText(/temps réel/i);
    await expect(page.getByText("Inventaire", { exact: true })).toBeVisible();
  });
});

/**
 * The defect the first manual run of STK-08 surfaced: the revalidation
 * refreshed the row behind an open dialog, but the dialog kept the copy of
 * the product it had captured when it opened — so the "stock théorique"
 * someone was counting against could be stale until they closed and
 * reopened it. The server was never fooled (STK-07 re-reads the balance
 * under lock), but the figure on screen was, which is worse in its own way:
 * it is the number a human is deciding from.
 */
test.describe.serial("STK-08: an open dialog follows the refresh", () => {
  let tenant: ThrowawayTenant;

  test.beforeAll(async () => {
    tenant = await createThrowawayTenant("STK-08-dialog");
  });

  test.afterAll(() => tenant.dispose());

  test("updates the theoretical stock shown while the count dialog is open", async ({ page }) => {
    await tenant.login(page);
    const created = await page.request.post("/api/products", {
      data: { categoryId: null, name: "Tonic", price: "2.00", stockQuantity: 10 },
    });
    const product = (await created.json()) as { id: number };

    await page.goto("/stock");
    await page
      .locator(".stock-row")
      .filter({ hasText: "Tonic" })
      .getByRole("button", { name: /^compter/i })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("10 unités");

    // Another device records a delivery while this dialog sits open.
    const adjusted = await page.request.post(`/api/products/${product.id}/stock`, {
      data: { delta: 4, type: "RECEIPT", reason: "Livraison saisie ailleurs" },
    });
    expect(adjusted.ok()).toBeTruthy();

    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });

    // Without closing and reopening: the dialog now counts against 14.
    await expect(dialog).toContainText("14 unités");
    await expect(dialog).toBeVisible();
  });
});
