import { expect, test } from "@playwright/test";
import { createThrowawayTenant, openService, type ThrowawayTenant } from "./helpers/tenant";

/**
 * CASH-07's livrable, both halves.
 *
 * "Solde rafraîchi après vente/mouvement": the sale half is already proven
 * by tests/e2e/sale-server-truth.spec.ts (SALE-06); what was never covered
 * is the movement half — recording an outflow and watching the till figure
 * follow, without a page reload.
 *
 * "Journal filtré de la journée": the journal used to list the
 * establishment's last hundred movements whatever service they belonged to,
 * so the morning after a close it showed yesterday's float and withdrawals
 * underneath today's balance.
 *
 * Its own establishment, serial: closing a service is location-wide.
 */
test.describe.serial("CASH-07: the journal and the balance describe the same service", () => {
  let tenant: ThrowawayTenant;

  test.beforeAll(async () => {
    tenant = await createThrowawayTenant("CASH-07");
  });

  test.afterAll(() => tenant.dispose());

  test("moves the displayed balance when a movement is recorded, without reloading", async ({
    page,
  }) => {
    await tenant.login(page);
    await openService(page, "150");

    const balance = page.locator(".cash-card strong");
    await expect(balance).toHaveText("150,00 €");

    await page.getByRole("button", { name: /^mouvement$/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: /sortie/i }).click();
    await dialog.getByLabel(/catégorie/i).selectOption("PURCHASE");
    await dialog.getByLabel(/montant/i).fill("30");
    await dialog.getByLabel(/motif/i).fill("Consommables");
    await dialog.getByRole("button", { name: /valider la sortie/i }).click();

    // No page.reload() anywhere: the figure the cashier watches all service
    // has to follow the ledger on its own.
    await expect(balance).toHaveText("120,00 €");
  });

  test("shows only the open service's movements in the journal", async ({ page }) => {
    await tenant.login(page);

    await page.goto("/bilan");
    const journal = page.locator(".history-card").last();
    // The service opened above: its float and its purchase, named by
    // category (DEC-11) rather than by direction alone.
    await expect(journal).toContainText("Consommables");
    await expect(journal).toContainText("Achat ou dépense");
    await expect(journal).toContainText("Fond de caisse");

    // Close, then open a second service. Yesterday's journal must not follow.
    await page.goto("/caisse");
    await page.getByRole("button", { name: /compter et clôturer la caisse/i }).click();
    const closeDialog = page.getByRole("dialog");
    await closeDialog.getByLabel(/espèces comptées/i).fill("120");
    await closeDialog.getByRole("button", { name: /compter et clôturer la caisse/i }).click();
    await expect(page.getByText("Aucun service ouvert")).toBeVisible();

    await openService(page, "80");

    await page.goto("/bilan");
    const fresh = page.locator(".history-card").last();
    await expect(fresh).toContainText("Fond de caisse");
    // The previous service's purchase is gone — it belongs to a period this
    // screen is no longer describing.
    await expect(fresh).not.toContainText("Consommables");
  });
});
