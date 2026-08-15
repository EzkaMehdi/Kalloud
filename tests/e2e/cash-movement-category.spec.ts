import { expect, test } from "@playwright/test";
import { createThrowawayTenant, type ThrowawayTenant } from "./helpers/tenant";

/**
 * CASH-03 over the real HTTP + cookie pipeline. Two of the ticket's three
 * acceptance clauses can only be shown here: "erreurs serveur affichées"
 * is about what the modal renders when the API refuses, and the audit trail
 * is written by the route, not by the repository.
 *
 * Throwaway tenant, same reasoning as tests/e2e/business-day-open-close.spec.ts:
 * one of these tests needs an establishment with *no* open business day, and
 * closing the seeded one would break every sale spec running concurrently
 * under `fullyParallel`.
 */

// Shared throwaway establishment, mutated by both tests: order declared, not
// inherited from `fullyParallel` (which parallelises within a file too).
test.describe.serial("CASH-03: a cash movement carries its category", () => {
  let tenant: ThrowawayTenant;

  test.beforeAll(async () => {
    tenant = await createThrowawayTenant("CASH-03");
  });

  test.afterAll(() => tenant.dispose());

  test("records an end-of-service withdrawal under its own category, and audits it", async ({
    page,
  }) => {
    await tenant.login(page);

    // A movement needs an open service to belong to (CASH-01).
    await page.getByRole("button", { name: /ouvrir le service/i }).click();
    const openDialog = page.getByRole("dialog");
    await openDialog.getByLabel(/fond de caisse d'ouverture/i).fill("200");
    await openDialog.getByRole("button", { name: /^ouvrir le service$/i }).click();
    await expect(page.getByText("Service ouvert", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /^mouvement$/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // "Sortie" first: the category list is the one for the direction, so
    // the withdrawal option does not even exist until the movement is an
    // outflow (DEC-11).
    await dialog.getByRole("radio", { name: /sortie/i }).click();
    await dialog.getByLabel(/catégorie/i).selectOption("END_OF_SERVICE_WITHDRAWAL");
    await dialog.getByLabel(/montant/i).fill("150");
    await dialog.getByLabel(/motif/i).fill("Retrait du tiroir en fin de service");
    await dialog.getByRole("button", { name: /enregistrer|valider|ajouter/i }).click();

    await expect(dialog).toHaveCount(0);

    const { rows } = await tenant.pool.query<{ type: string; category: string; amount: string }>(
      "SELECT type, category, amount FROM cash_movements WHERE location_id = $1 AND type = 'OUT'",
      [tenant.locationId],
    );
    expect(rows).toEqual([
      { type: "OUT", category: "END_OF_SERVICE_WITHDRAWAL", amount: "150.00" },
    ]);

    // "Auditable" (acceptance): the trail has to say *which* kind of
    // outflow, not merely that 150 € left the till.
    const { rows: audit } = await tenant.pool.query<{
      action: string;
      after_data: { category: string };
    }>(
      "SELECT action, after_data FROM audit_events WHERE location_id = $1 AND action = 'cash_movement.create'",
      [tenant.locationId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].after_data.category).toBe("END_OF_SERVICE_WITHDRAWAL");
  });

  test("shows the server's refusal instead of failing silently", async ({ page }) => {
    await tenant.login(page);

    // This test's precondition is "no service open", and the tests in this
    // describe share one establishment — so it establishes that state itself
    // rather than depending on having run after the one above. The amounts
    // are irrelevant; the resulting state is the point. A variance beyond the
    // threshold needs a reason (CASH-05), and the previous test's withdrawal
    // makes this a large one.
    await page.request.post("/api/business-day/close", {
      // CASH-06/API-02: closing is idempotent-keyed like any other financial
      // write, so a lost response can be retried rather than guessed at.
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: { countedCash: "200.00", varianceReason: "Clôture de test" },
    });
    await page.reload();

    // No service open: the API refuses the movement by name (CASH-01). The
    // point of the test is that the sentence reaches the user rather than
    // being swallowed by the modal.
    await expect(page.getByText("Aucun service ouvert")).toBeVisible();

    await page.getByRole("button", { name: /^mouvement$/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/montant/i).fill("10");
    await dialog.getByLabel(/motif/i).fill("Appoint");
    await dialog.getByRole("button", { name: /enregistrer|valider|ajouter/i }).click();

    await expect(dialog.getByRole("alert")).toContainText(/ouvrez une journée/i);
    // The dialog stays open and the typed values survive the failure
    // (UX-05): a refused submission must not make the cashier retype it.
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/motif/i)).toHaveValue("Appoint");
  });
});
