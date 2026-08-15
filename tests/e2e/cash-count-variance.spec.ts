import { expect, test } from "@playwright/test";
import { createThrowawayTenant, openService, type ThrowawayTenant } from "./helpers/tenant";

/**
 * CASH-05 through the browser. The arithmetic and the threshold rule are
 * proven at the integration tier (tests/integration/business-day.test.ts);
 * what only this tier can show is the screen DEC-04 actually specifies — the
 * calculation laid out *above* the count, the variance appearing as soon as
 * something is counted, and the refusal reaching the user with their input
 * intact (UX-05).
 *
 * Throwaway establishment, serial: closing is location-wide, and the seeded
 * tenant is being sold against concurrently by every other spec.
 */

test.describe.serial("CASH-05: counting the drawer at closing", () => {
  let tenant: ThrowawayTenant;

  test.beforeAll(async () => {
    tenant = await createThrowawayTenant("CASH-05");
  });

  test.afterAll(() => tenant.dispose());

  test("lays out the calculation above the count, and refuses a large variance without a reason", async ({
    page,
  }) => {
    await tenant.login(page);
    await openService(page, "150");

    await page.getByRole("button", { name: /compter et clôturer la caisse/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // DEC-04's order: the terms, then the expected total, then the input.
    // Asserted as text content rather than positions — what matters is that
    // the cashier can see how the figure was built before being asked to
    // disagree with it.
    await expect(dialog).toContainText("Fond de caisse d'ouverture");
    await expect(dialog).toContainText("Ventes espèces");
    await expect(dialog).toContainText("Espèces attendues");
    await expect(dialog).toContainText("150,00 €");

    // 20 € short, well beyond the 5 € default threshold (CFG-00).
    await dialog.getByLabel(/espèces comptées/i).fill("130");
    // Scoped to the live region rather than to any text matching "écart" —
    // the reason field's own label contains the word too.
    const varianceLine = dialog.getByRole("status");
    await expect(varianceLine).toContainText("−20,00 €");
    await expect(varianceLine).toContainText(/motif est obligatoire/i);

    await dialog.getByRole("button", { name: /compter et clôturer la caisse/i }).click();

    // Refused by the server, and the refusal is on screen — with the counted
    // amount still typed in (UX-05).
    await expect(dialog.getByRole("alert")).toContainText(/seuil/i);
    await expect(dialog.getByLabel(/espèces comptées/i)).toHaveValue("130");
    const stillOpen = await page.request.get("/api/cash-summary");
    expect(((await stillOpen.json()) as { businessDayOpen: boolean }).businessDayOpen).toBe(true);
  });

  test("closes once the variance is explained, and offers the stated float next time", async ({
    page,
  }) => {
    await tenant.login(page);

    const dialog = page.getByRole("dialog");
    await page.getByRole("button", { name: /compter et clôturer la caisse/i }).click();
    await dialog.getByLabel(/espèces comptées/i).fill("130");
    await dialog.getByLabel(/motif de l'écart/i).fill("Erreur de rendu de monnaie");
    await dialog.getByLabel(/fond laissé pour le prochain service/i).fill("80");
    await dialog.getByRole("button", { name: /compter et clôturer la caisse/i }).click();

    await expect(page.getByText("Aucun service ouvert")).toBeVisible();

    // CASH-02 still holds: stating the next float recorded an intention, it
    // did not open a service.
    const summary = await page.request.get("/api/cash-summary");
    const body = (await summary.json()) as {
      businessDayOpen: boolean;
      suggestedOpeningCash: string | null;
    };
    expect(body.businessDayOpen).toBe(false);
    expect(body.suggestedOpeningCash).toBe("80.00");

    // And the next opening proposes it rather than starting from nothing.
    await page.getByRole("button", { name: /ouvrir le service/i }).click();
    await expect(dialog.getByLabel(/fond de caisse d'ouverture/i)).toHaveValue("80.00");
  });
});
