import { expect, test } from "@playwright/test";
import { createThrowawayTenant, type ThrowawayTenant } from "./helpers/tenant";

/**
 * CASH-06/DEC-04: "La clôture d'une journée est bloquée tant qu'il existe des
 * commandes OPEN. L'écran de clôture affiche la liste des tickets bloquants."
 *
 * The refusal itself is proven at the integration tier
 * (tests/integration/business-day.test.ts), including the concurrent-close
 * race, which no browser test can create reliably. What is proven here is the
 * half of the acceptance criterion that is about the screen: the tickets are
 * *named*, before the user tries anything.
 *
 * Own throwaway establishment, serial: the tests share it and mutate its
 * business-day state.
 */

test.describe.serial("CASH-06: open tickets block the close", () => {
  let tenant: ThrowawayTenant;

  test.beforeAll(async () => {
    tenant = await createThrowawayTenant("CASH-06");
  });

  test.afterAll(() => tenant.dispose());

  test("names the blocking ticket instead of offering a count that cannot be submitted", async ({
    page,
  }) => {
    await tenant.login(page);

    await page.getByRole("button", { name: /ouvrir le service/i }).click();
    const openDialog = page.getByRole("dialog");
    await openDialog.getByLabel(/fond de caisse d'ouverture/i).fill("150");
    await openDialog.getByRole("button", { name: /^ouvrir le service$/i }).click();
    await expect(page.getByText("Service ouvert", { exact: true })).toBeVisible();

    const created = await page.request.post("/api/tickets", { data: { tableId: null } });
    expect(created.ok()).toBeTruthy();
    // The route answers `{ ticket, created }`, not the ticket itself.
    const { ticket } = (await created.json()) as { ticket: { order_number: number } };

    await page.getByRole("button", { name: /compter et clôturer la caisse/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await expect(dialog.getByRole("alert")).toContainText(/1 ticket\(s\) encore ouvert/i);
    await expect(dialog).toContainText(`Ticket #${ticket.order_number}`);
    // The reconciliation form is withheld entirely: a count typed against a
    // total that is still moving would be thrown away, and offering a
    // disabled submit teaches nothing about why.
    await expect(dialog.getByLabel(/espèces comptées/i)).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: /compter et clôturer la caisse/i }),
    ).toHaveCount(0);
  });

  test("closes once the ticket is cancelled", async ({ page }) => {
    await tenant.login(page);

    const tickets = await page.request.get("/api/tickets");
    const [open] = (await tickets.json()) as { id: number }[];
    const cancelled = await page.request.post(`/api/tickets/${open.id}/cancel`, {
      data: { reason: "Abandonné" },
    });
    expect(cancelled.ok()).toBeTruthy();

    await page.reload();
    await page.getByRole("button", { name: /compter et clôturer la caisse/i }).click();
    const dialog = page.getByRole("dialog");
    // The form is back: nothing stands in the way any more.
    await dialog.getByLabel(/espèces comptées/i).fill("150");
    await dialog.getByRole("button", { name: /compter et clôturer la caisse/i }).click();

    await expect(page.getByText("Aucun service ouvert")).toBeVisible();
  });
});
