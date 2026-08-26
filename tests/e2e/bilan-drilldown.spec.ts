import { expect, test } from "@playwright/test";
import { createThrowawayTenant, openService, type ThrowawayTenant } from "./helpers/tenant";

/**
 * BI-11's acceptance, verbatim: "aucun bouton sans action ; retour au
 * dashboard sans perdre le contexte." Proved on the three blocks `BI-11`
 * itself had to build a screen for (`BI-07`/`BI-08`/`BI-09` each left their
 * own livrable as "le service et ses tests, pas un écran") — real data from
 * one real sale, not a mocked figure; the one actual button ("Voir tout")
 * opens a real drawer with that same sale's product in it; closing it
 * leaves the order-history filter exactly as it was, never a navigation
 * that would have reset it.
 */
test.describe.serial("BI-11: drill-down blocks on /bilan", () => {
  let tenant: ThrowawayTenant;

  test.beforeAll(async () => {
    tenant = await createThrowawayTenant("BI-11");
  });

  test.afterAll(() => tenant.dispose());

  test("comparison, trends and cash-reconciliation blocks show real data, and the trends drawer preserves dashboard context", async ({
    page,
  }) => {
    await tenant.login(page);
    await openService(page, "50.00");

    const created = await page.request.post("/api/products", {
      data: {
        categoryId: null,
        name: `BI-11 ${crypto.randomUUID()}`,
        price: "8.00",
        // Comfortably above the default alert threshold (5): this product
        // must not also show up in StockRiskBlock's own ".history-card",
        // which would make the trends card's own locator ambiguous.
        stockQuantity: 50,
      },
    });
    expect(created.ok()).toBeTruthy();
    const product: { name: string } = await created.json();

    await page.getByRole("button", { name: /vente directe/i }).click();
    const saleDialog = page.getByRole("dialog");
    const escapedName = product.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await saleDialog
      .locator(".products")
      .getByRole("button", { name: new RegExp(escapedName) })
      .click();
    await saleDialog.getByRole("radio", { name: "Espèces" }).click();
    await saleDialog.getByRole("button", { name: /encaisser/i }).click();
    await expect(saleDialog).toBeHidden();

    await page.goto("/bilan");

    // Filters on the ".kpi-label" span's own exact text, not `.kpi`'s whole
    // text content: CashReconciliationBlock's own breakdown repeats the
    // word "Ventes" inside its `.split` line (the cash-sales term), which a
    // loose `.kpi[hasText="Ventes"]` would also match.
    function kpiCard(label: string) {
      return page.locator(".kpi").filter({ has: page.locator(".kpi-label", { hasText: label }) });
    }

    // BI-07's own block: a real comparison, not a placeholder — "0" would
    // also be a valid rendering (nothing recent to compare against yet),
    // but the current figure must be the one real sale.
    await expect(kpiCard("Ventes").locator("strong")).toHaveText("1");

    // BI-09's own block: the fond just opened, live.
    await expect(kpiCard("Solde de caisse attendu").locator("strong")).toContainText("58,00");

    // BI-08's own block: the product just sold appears in the compact top
    // list, with a real "Voir tout" button that truly opens something.
    const trendsCard = page.locator(".history-card", { hasText: product.name });
    await expect(trendsCard).toContainText("8,00 €");
    const voirTout = trendsCard.getByRole("button", { name: "Voir tout" });
    await expect(voirTout).toBeVisible();

    // Set a real order-history filter before opening the drawer — the
    // context "retour au dashboard sans perdre le contexte" has to survive.
    await page.getByRole("tab", { name: "Encaissées" }).click();
    await expect(page.getByRole("tab", { name: "Encaissées" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await voirTout.click();
    const dialog = page.getByRole("dialog", { name: "Détail des ventes" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Ventes par produit");
    await expect(dialog).toContainText(product.name);

    await dialog.getByRole("button", { name: "Fermer" }).click();
    await expect(dialog).toBeHidden();

    // Never navigated away — the filter set before opening the drawer is
    // still exactly as left, not reset to "Toutes".
    await expect(page.getByRole("tab", { name: "Encaissées" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
