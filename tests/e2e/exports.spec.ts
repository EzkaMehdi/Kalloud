import { expect, test } from "@playwright/test";
import { createThrowawayTenant, openService, type ThrowawayTenant } from "./helpers/tenant";

/**
 * BI-12/DEC-09's acceptance, verbatim: "colonnes, encodage, dates, montants
 * et autorisations testés." Permission is proved at the HTTP layer in
 * `tests/e2e/auth.spec.ts` (extended, not duplicated here); this proves the
 * links are real from the browser's own point of view — visible to an
 * owner, wired to the real route, and the file that comes back describes an
 * actual sale, not a placeholder.
 *
 * BI-14/`GATE-6`: "l'export respecte exactement les filtres." The link's
 * own `href` carries the cockpit's current period ("Aujourd'hui" →
 * `period=service`, the same query `PerformanceComparisonBlock`/
 * `SalesTrendsBlock` already send); a request for a period that does not
 * cover the sale comes back with the header row alone, proving the filter
 * is not just accepted but actually applied, not merely default-ignored.
 */
test.describe.serial("BI-12: exports on /bilan", () => {
  let tenant: ThrowawayTenant;

  test.beforeAll(async () => {
    tenant = await createThrowawayTenant("BI-12");
  });

  test.afterAll(() => tenant.dispose());

  test("an owner sees all four export links, and the sales export is a real CSV describing the real sale", async ({
    page,
  }) => {
    await tenant.login(page);
    await openService(page, "50.00");

    const created = await page.request.post("/api/products", {
      data: {
        categoryId: null,
        name: `BI-12 ${crypto.randomUUID()}`,
        price: "9.00",
        // Without stock, is_available is false and "Vente directe" refuses
        // to sell it at all.
        stockQuantity: 20,
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
    const exportsRow = page.locator(".exports-row");
    const salesLink = exportsRow.getByRole("link", { name: "Ventes" });
    await expect(salesLink).toBeVisible();
    await expect(exportsRow.getByRole("link", { name: "Paiements" })).toBeVisible();
    await expect(exportsRow.getByRole("link", { name: "Caisse" })).toBeVisible();
    await expect(exportsRow.getByRole("link", { name: "Stock" })).toBeVisible();

    // "Aujourd'hui" (the page's own default tab) maps to period=service —
    // the link itself carries it, not just the route accepting it if asked.
    await expect(salesLink).toHaveAttribute("href", /period=service/);

    const response = await page.request.get("/api/exports/sales?period=service");
    expect(response.ok()).toBeTruthy();
    expect(response.headers()["content-type"]).toContain("text/csv");
    expect(response.headers()["content-disposition"]).toContain('filename="ventes.csv"');

    const body = await response.text();
    expect(body.charCodeAt(0)).toBe(0xfeff);
    expect(body).toContain("N° de commande;Table;Produit;Quantité");
    expect(body).toContain(product.name);
    expect(body).toContain("9.00"); // raw decimal, not "9,00 €"

    // A period that does not cover the sale exports the header alone — the
    // filter is actually applied, not accepted and ignored.
    const lastYear = new Date().getFullYear() - 1;
    const filtered = await page.request.get(`/api/exports/sales?period=year&year=${lastYear}`);
    expect(filtered.ok()).toBeTruthy();
    const filteredBody = await filtered.text();
    expect(filteredBody).not.toContain(product.name);
  });
});
