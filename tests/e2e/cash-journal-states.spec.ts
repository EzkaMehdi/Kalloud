import { expect, test } from "@playwright/test";
import { createThrowawayTenant, openService, type ThrowawayTenant } from "./helpers/tenant";

/**
 * CASH-09: "aucune ligne fictive et aucun solde obsolète après une opération
 * réussie".
 *
 * The update-after-sale and update-after-movement halves of the livrable are
 * already proven — SALE-06 for the sale, CASH-07 for the movement — and are
 * not repeated here. What no test covered is the third: **états réseau**.
 * A screen that quietly keeps showing the last figure it managed to fetch is
 * indistinguishable, to the person reading it, from one that is up to date;
 * for a till, that is the difference between a balance and a guess.
 *
 * Failures are simulated by aborting the request, the same way SALE-08's
 * spec does — the only way to reach these branches from the outside.
 */

test.describe.serial("CASH-09: the journal shows real rows, or says it cannot", () => {
  let tenant: ThrowawayTenant;

  test.beforeAll(async () => {
    tenant = await createThrowawayTenant("CASH-09");
  });

  test.afterAll(() => tenant.dispose());

  test("shows exactly the rows that were recorded, and no others", async ({ page }) => {
    await tenant.login(page);
    await openService(page, "150");

    await page.getByRole("button", { name: /^mouvement$/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: /sortie/i }).click();
    await dialog.getByLabel(/catégorie/i).selectOption("BANK_DEPOSIT");
    await dialog.getByLabel(/montant/i).fill("40");
    await dialog.getByLabel(/motif/i).fill("Dépôt du soir");
    await dialog.getByRole("button", { name: /valider la sortie/i }).click();
    await expect(dialog).toHaveCount(0);

    await page.goto("/bilan");
    const journal = page.locator(".history-card").last();

    // Two movements exist, so two lines are shown. A count is the assertion
    // that catches a fictional row: the hardcoded "+150,00 € / −20,00 €"
    // this screen used to carry would make it four.
    await expect(journal.locator(".movement")).toHaveCount(2);
    await expect(journal).toContainText("Dépôt du soir");
    await expect(journal).toContainText("Dépôt en banque");
    await expect(journal).toContainText("−40,00 €");
  });

  test("says the journal is empty rather than showing the last service's rows", async ({
    page,
  }) => {
    await tenant.login(page);

    await page.getByRole("button", { name: /compter et clôturer la caisse/i }).click();
    const closeDialog = page.getByRole("dialog");
    await closeDialog.getByLabel(/espèces comptées/i).fill("110");
    await closeDialog.getByRole("button", { name: /compter et clôturer la caisse/i }).click();
    await expect(page.getByText("Aucun service ouvert")).toBeVisible();

    await page.goto("/bilan");
    // The sharpest form of "aucune ligne fictive": with no service open there
    // is nothing to show, and the screen says so instead of leaving the
    // previous service's rows under a balance of 0,00 €.
    await expect(page.getByText(/aucun mouvement de caisse/i)).toBeVisible();
    await expect(page.locator(".movement")).toHaveCount(0);
  });

  test("reports a failed journal fetch, and recovers on retry", async ({ page }) => {
    await tenant.login(page);
    await openService(page, "90");

    // Held down from the test rather than disarmed after the first request:
    // the page issues the fetch twice under React's development double
    // invocation, and a one-shot failure would be repaired by the second
    // before the assertion below ever ran.
    let offline = true;
    await page.route("**/api/cash-movements**", async (route) => {
      if (route.request().method() === "GET" && offline) {
        await route.abort("connectionfailed");
        return;
      }
      await route.continue();
    });

    await page.goto("/bilan");
    const failure = page.locator(".async-state-error");
    // An alert, not an empty list: "nothing to show" and "could not ask" are
    // different facts, and only one of them is the establishment's.
    await expect(failure).toBeVisible();
    await expect(page.locator(".movement")).toHaveCount(0);

    offline = false;
    await failure.getByRole("button").click();

    // The retry reaches the server this time, and the real row appears.
    await expect(page.locator(".movement")).toHaveCount(1);
    await expect(page.locator(".history-card").last()).toContainText("Fond de caisse");
  });

  test("refuses to show a stale balance when the summary cannot be fetched", async ({ page }) => {
    await tenant.login(page);

    const balance = page.locator(".cash-card strong");
    await expect(balance).toHaveText("90,00 €");

    await page.route("**/api/cash-summary", (route) => route.abort("connectionfailed"));
    await page.reload();

    // "—", never the last figure it happened to know: a till that keeps
    // displaying 90,00 € while unable to confirm it is worse than one that
    // admits it does not know.
    await expect(balance).toHaveText("—");
    await expect(page.getByRole("alert").first()).toBeVisible();
  });
});
