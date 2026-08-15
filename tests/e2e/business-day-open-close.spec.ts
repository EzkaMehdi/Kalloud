import { expect, test, type Page } from "@playwright/test";
import { createThrowawayTenant, type ThrowawayTenant } from "./helpers/tenant";

/**
 * CASH-02 over the real HTTP + cookie pipeline. The service-level guarantee
 * ("closing opens nothing") is proven exhaustively in
 * tests/integration/business-day.test.ts; what only this tier can show is the
 * screen itself — that the caisse offers exactly one of the two actions at a
 * time, named as DEC-04 requires, and that after a close it *offers* to open
 * a service rather than having opened one.
 *
 * This spec runs against a throwaway tenant of its own, created directly in
 * the database the Playwright web server already uses (same precedent as
 * tests/e2e/tenant-isolation.spec.ts). That is not a stylistic choice:
 * closing a business day is a location-wide mutation, and under
 * `fullyParallel` every other sale spec is concurrently selling against the
 * seeded tenant's open day. Closing *that* day mid-run would break them all
 * — the shared-mutable-state race this suite has already been bitten by
 * twice (tests/e2e/idempotency.spec.ts, then helpers/floor.ts). An isolated
 * tenant has no such blast radius.
 */

// The tests below share one throwaway establishment and each mutate its
// business-day state, so their order is declared rather than left to
// `fullyParallel` — which parallelises tests within a file, not just across
// files. Same precedent as tests/e2e/idempotency.spec.ts.
test.describe.serial("CASH-02: opening and closing are two deliberate acts", () => {
  let tenant: ThrowawayTenant;

  test.beforeAll(async () => {
    tenant = await createThrowawayTenant("CASH-02");
  });

  test.afterAll(() => tenant.dispose());

  async function businessDayOpen(page: Page): Promise<boolean> {
    const response = await page.request.get("/api/cash-summary");
    expect(response.ok()).toBeTruthy();
    return ((await response.json()) as { businessDayOpen: boolean }).businessDayOpen;
  }

  test("a brand new establishment is offered 'Ouvrir le service', and nothing else", async ({
    page,
  }) => {
    await tenant.login(page);

    // The screen used to claim "Service ouvert" unconditionally, for a
    // tenant that had never opened a day in its life.
    await expect(page.getByText("Aucun service ouvert")).toBeVisible();
    await expect(page.getByRole("button", { name: /ouvrir le service/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /compter et clôturer la caisse/i })).toHaveCount(
      0,
    );
    expect(await businessDayOpen(page)).toBe(false);
  });

  test("opening then closing leaves no service running, and never opens one on its own", async ({
    page,
  }) => {
    await tenant.login(page);

    // --- Open, explicitly, with a fund stated by whoever opens. ---
    await page.getByRole("button", { name: /ouvrir le service/i }).click();
    const openDialog = page.getByRole("dialog");
    await expect(openDialog).toBeVisible();
    await openDialog.getByLabel(/fond de caisse d'ouverture/i).fill("120");
    await openDialog.getByRole("button", { name: /^ouvrir le service$/i }).click();

    await expect(page.getByText("Service ouvert", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /compter et clôturer la caisse/i }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^ouvrir le service$/i })).toHaveCount(0);
    expect(await businessDayOpen(page)).toBe(true);

    // --- Close, explicitly. This is the assertion the ticket exists for. ---
    await page.getByRole("button", { name: /compter et clôturer la caisse/i }).click();
    const closeDialog = page.getByRole("dialog");
    await expect(closeDialog).toBeVisible();
    // CASH-05: the count is what closing asks for now. The float offered to
    // the *next* service is optional and, crucially, opens nothing — left
    // blank here precisely so the assertions below cannot be satisfied by a
    // service this dialog started.
    await closeDialog.getByLabel(/espèces comptées/i).fill("120");
    await closeDialog.getByRole("button", { name: /compter et clôturer la caisse/i }).click();

    // Acceptance, verbatim: "aucune nouvelle journée ouverte implicitement
    // sans choix". The old combined action left a fresh OPEN day here.
    await expect(page.getByText("Aucun service ouvert")).toBeVisible();
    expect(await businessDayOpen(page)).toBe(false);

    // And the next service is offered as a choice, not performed as one.
    await expect(page.getByRole("button", { name: /ouvrir le service/i })).toBeVisible();
  });
});
