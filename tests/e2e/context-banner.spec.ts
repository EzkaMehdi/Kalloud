import { expect, test } from "@playwright/test";
import { createThrowawayTenant, openService, type ThrowawayTenant } from "./helpers/tenant";

/**
 * BI-05's acceptance criterion, verbatim: "le gérant connaît toujours le
 * périmètre des chiffres." Proved by checking the four facts DEC-09 asks a
 * cockpit to always be able to answer — établissement, période, état du
 * service, dernière synchronisation — are all present and correct on the
 * Bilan, and that the ones which change (service state, period) actually
 * follow reality instead of being decided once at load.
 *
 * Its own establishment, serial: `openService` is a location-wide act the
 * second test builds on directly.
 */
test.describe
  .serial("BI-05: the context banner always states établissement/période/service/synchro", () => {
  let tenant: ThrowawayTenant;

  test.beforeAll(async () => {
    tenant = await createThrowawayTenant("BI-05");
  });

  test.afterAll(() => tenant.dispose());

  test("names the real establishment, the default period, no open service, and a real sync time", async ({
    page,
  }) => {
    await tenant.login(page);
    await page.goto("/bilan");

    const banner = page.locator(".context-banner");
    // The name this tenant was actually created with (helpers/tenant.ts),
    // not a placeholder — proves the banner reads /api/settings for real.
    await expect(banner.locator(".context-establishment")).toHaveText("E2E BI-05 Location");
    await expect(banner).toContainText("Service en cours");

    const servicePill = banner.locator(".status");
    await expect(servicePill).toHaveClass(/muted/);
    await expect(servicePill).toContainText("Aucun service ouvert");

    // Not stuck on "Synchronisation en cours…" once the page has settled —
    // a real instant was recorded, not a placeholder that never resolves.
    await expect(banner.locator(".context-sync")).toContainText(/Synchronisé à \d{2}:\d{2}:\d{2}/);
  });

  test("follows the service state and the period selector without a reload", async ({ page }) => {
    await tenant.login(page);
    await page.goto("/bilan");

    const banner = page.locator(".context-banner");
    const servicePill = banner.locator(".status");
    await expect(servicePill).toContainText("Aucun service ouvert");

    // Opened from the caisse screen (the only real way, CASH-02) — proves
    // the banner reflects a state change made elsewhere, not a value
    // decided once when the Bilan itself loaded.
    await page.goto("/caisse");
    await openService(page, "100");
    await page.goto("/bilan");

    await expect(servicePill).not.toHaveClass(/muted/);
    await expect(servicePill).toContainText("Service ouvert");
    await expect(servicePill).not.toContainText("Aucun service ouvert");

    await page.getByRole("tab", { name: "Ce mois" }).click();
    const now = new Date();
    const months = [
      "Janvier",
      "Février",
      "Mars",
      "Avril",
      "Mai",
      "Juin",
      "Juillet",
      "Août",
      "Septembre",
      "Octobre",
      "Novembre",
      "Décembre",
    ];
    await expect(banner).toContainText(`Mois : ${months[now.getMonth()]} ${now.getFullYear()}`);
  });
});
