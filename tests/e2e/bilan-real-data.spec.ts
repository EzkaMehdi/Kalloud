import { expect, test } from "@playwright/test";
import { createThrowawayTenant, openService, type ThrowawayTenant } from "./helpers/tenant";

/**
 * BI-04's acceptance criterion, verbatim: "aucune constante métier dans
 * app/bilan." A static read of app/bilan/page.tsx already shows every
 * figure it renders comes from `/api/dashboard`, `/api/orders` and
 * `/api/cash-movements` — the hardcoded "+150,00 € / −20,00 €" cash lines
 * and the "last 100, show 8" order list this screen once had were removed
 * by earlier tasks (`CASH-07`, `ORD-12`), not this one. What no test proved
 * yet is the claim itself, from outside the source file: a brand-new
 * establishment must show a real zero, never a preset figure a leftover
 * constant would produce, and once a real sale and a real cash movement
 * exist, the screen must reflect exactly those — closing the loop CASH-09
 * already closed for the cash journal alone, here for the KPI cards and the
 * order history it sits next to.
 *
 * Its own establishment, serial: the KPI cards read `period=day`, i.e. the
 * one open service — a second test opening its own service on a shared
 * tenant would contaminate the first.
 */
test.describe.serial("BI-04: the Bilan reflects only what actually happened", () => {
  let tenant: ThrowawayTenant;

  test.beforeAll(async () => {
    tenant = await createThrowawayTenant("BI-04");
  });

  test.afterAll(() => tenant.dispose());

  test("starts at a genuine zero for an establishment with no history at all", async ({ page }) => {
    await tenant.login(page);
    await page.goto("/bilan");

    const revenueCard = page.locator(".kpi", { hasText: "Chiffre d'affaires" });
    const ordersCard = page.locator(".kpi", { hasText: "Commandes" });
    const basketCard = page.locator(".kpi", { hasText: "Panier moyen" });
    await expect(revenueCard.locator("strong")).toHaveText("0,00 €");
    await expect(ordersCard.locator("strong")).toHaveText("0");
    await expect(basketCard.locator("strong")).toHaveText("0,00 €");
    // Only rendered when a service is open (CASH-04/DEC-04) — none is yet,
    // so a preset "Espèces attendues" figure would show up here for free.
    await expect(page.locator(".kpi", { hasText: "Espèces attendues" })).toHaveCount(0);

    await expect(page.getByText("Aucune commande encaissée pour le moment.")).toBeVisible();
    await expect(page.getByText("Aucun mouvement de caisse enregistré.")).toBeVisible();
  });

  test("reflects exactly one real sale and one real cash movement, not a preset figure", async ({
    page,
  }) => {
    await tenant.login(page);
    await openService(page, "50");

    const created = await page.request.post("/api/products", {
      data: {
        categoryId: null,
        name: `BI-04 ${crypto.randomUUID()}`,
        price: "12.00",
        stockQuantity: 5,
      },
    });
    expect(created.ok()).toBeTruthy();
    const product: { name: string } = await created.json();

    await page.goto("/caisse");
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

    await page.getByRole("button", { name: /^mouvement$/i }).click();
    const movementDialog = page.getByRole("dialog");
    await movementDialog.getByRole("radio", { name: "Entrée" }).click();
    await movementDialog.getByLabel(/catégorie/i).selectOption("FUND_TOPUP");
    await movementDialog.getByLabel(/montant/i).fill("5");
    await movementDialog.getByLabel(/motif/i).fill("Appoint de caisse");
    await movementDialog.getByRole("button", { name: /valider l.entrée/i }).click();
    await expect(movementDialog).toHaveCount(0);

    await page.goto("/bilan");
    // 12,00 € from the one sale; the 5 € cash movement is not revenue, so
    // it must not leak into the CA card — proving the two widgets read
    // from different, real sources rather than one shared placeholder.
    const revenueCard = page.locator(".kpi", { hasText: "Chiffre d'affaires" });
    const ordersCard = page.locator(".kpi", { hasText: "Commandes" });
    const basketCard = page.locator(".kpi", { hasText: "Panier moyen" });
    await expect(revenueCard.locator("strong")).toHaveText("12,00 €");
    await expect(ordersCard.locator("strong")).toHaveText("1");
    await expect(basketCard.locator("strong")).toHaveText("12,00 €");

    const orderRow = page.locator(".order-row").first();
    await expect(orderRow).toContainText("Vente directe");
    await expect(orderRow).toContainText("12,00 €");

    const journal = page.locator(".history-card").last();
    await expect(journal).toContainText("Appoint de caisse");
    await expect(journal).toContainText("5,00 €");
  });
});
