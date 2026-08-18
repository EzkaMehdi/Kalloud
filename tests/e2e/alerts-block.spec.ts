import { expect, test } from "@playwright/test";
import { createThrowawayTenant, type ThrowawayTenant } from "./helpers/tenant";

/**
 * BI-06's acceptance criterion, verbatim: "chacune ouvre l'action
 * correspondante." The five detection rules themselves are proved at the
 * service level (tests/integration/alerts.test.ts) — this proves the one
 * thing only a browser can: clicking a real alert card actually navigates
 * to its action.
 */
test.describe.serial("BI-06: the alerts block on /bilan links to a real action", () => {
  let tenant: ThrowawayTenant;

  test.beforeAll(async () => {
    tenant = await createThrowawayTenant("BI-06");
  });

  test.afterAll(() => tenant.dispose());

  test("shows the honest empty state for an establishment with nothing to flag", async ({
    page,
  }) => {
    await tenant.login(page);
    await page.goto("/bilan");

    await expect(page.getByText("Aucune alerte : rien à traiter pour le moment.")).toBeVisible();
    await expect(page.locator(".alert-card")).toHaveCount(0);
  });

  test("a rupture alert names the count and its click opens the stock screen", async ({ page }) => {
    await tenant.login(page);

    const created = await page.request.post("/api/products", {
      data: {
        categoryId: null,
        name: `BI-06 ${crypto.randomUUID()}`,
        price: "5.00",
        stockQuantity: 0,
      },
    });
    expect(created.ok()).toBeTruthy();

    await page.goto("/bilan");

    const alertCard = page.locator(".alert-card").first();
    await expect(alertCard).toContainText("1 en rupture");
    await expect(alertCard).toHaveClass(/critical/);

    await alertCard.click();
    await expect(page).toHaveURL(/\/stock$/);
  });
});
