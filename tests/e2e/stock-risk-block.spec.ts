import { expect, test } from "@playwright/test";
import { createThrowawayTenant, type ThrowawayTenant } from "./helpers/tenant";

/**
 * BI-10's acceptance criterion, verbatim: "alerte ouvre le produit et son
 * formulaire de mouvement." Proved literally: clicking a row in the
 * stock-at-risk block opens `StockAdjustModal` (`STK-05`) pre-selected on
 * that exact product — not the general `/stock` screen `BI-06`'s own alert
 * card already links to (see that service's own note on why: no screen
 * accepted a query parameter to preselect a product until this task).
 */
test.describe.serial("BI-10: the stock-at-risk block opens the right product's own form", () => {
  let tenant: ThrowawayTenant;

  test.beforeAll(async () => {
    tenant = await createThrowawayTenant("BI-10");
  });

  test.afterAll(() => tenant.dispose());

  test("clicking an out-of-stock row opens that product's movement form, and a receipt clears it from the list", async ({
    page,
  }) => {
    await tenant.login(page);

    const created = await page.request.post("/api/products", {
      data: {
        categoryId: null,
        name: `BI-10 ${crypto.randomUUID()}`,
        price: "8.00",
        stockQuantity: 0,
      },
    });
    expect(created.ok()).toBeTruthy();
    const product: { name: string } = await created.json();

    await page.goto("/bilan");
    const block = page.locator(".history-card").filter({ hasText: product.name });
    await expect(block).toContainText("Rupture");

    await block
      .getByRole("button", {
        name: new RegExp(product.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      })
      .click();

    const dialog = page.getByRole("dialog", { name: "Mouvement de stock" });
    await expect(dialog).toBeVisible();
    // Pre-selected on this exact product: its name and current balance are
    // stated as text, and there is no product picker to choose a different
    // one — the alert opened *this* product's form, not a generic one.
    await expect(dialog).toContainText(product.name);
    await expect(dialog).toContainText("0 unités en stock");
    await expect(dialog.getByLabel("Produit")).toHaveCount(0);

    await dialog.getByLabel("Quantité").fill("10");
    await dialog.getByLabel("Motif").fill("Livraison reçue");
    await dialog.getByRole("button", { name: /enregistrer le mouvement/i }).click();
    await expect(dialog).toBeHidden();

    // The block refreshed itself — the product cleared the risk threshold
    // (10 > the default alert threshold of 5) and is gone without a reload.
    await expect(page.getByText(product.name)).toHaveCount(0);
  });
});
