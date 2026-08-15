import { Pool } from "pg";
import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "../../lib/auth/password";

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

const PASSWORD = "Password123!";

// The tests below share one throwaway establishment and each mutate its
// business-day state, so their order is declared rather than left to
// `fullyParallel` — which parallelises tests within a file, not just across
// files. Same precedent as tests/e2e/idempotency.spec.ts.
test.describe.serial("CASH-02: opening and closing are two deliberate acts", () => {
  let pool: Pool;
  let organizationId: number;
  let email: string;

  test.beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const {
      rows: [org],
    } = await pool.query<{ id: number }>(
      "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
      [`E2E CASH-02 Org ${crypto.randomUUID().slice(0, 8)}`],
    );
    organizationId = org.id;
    const {
      rows: [location],
    } = await pool.query<{ id: number }>(
      "INSERT INTO locations (organization_id, name) VALUES ($1, $2) RETURNING id",
      [org.id, "E2E CASH-02 Location"],
    );
    await pool.query("INSERT INTO location_settings (location_id) VALUES ($1)", [location.id]);

    email = `cash02-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const {
      rows: [user],
    } = await pool.query<{ id: number }>(
      "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id",
      [email, await hashPassword(PASSWORD), "CASH-02 Owner"],
    );
    await pool.query(
      "INSERT INTO memberships (user_id, organization_id, location_id, role) VALUES ($1, $2, $3, 'OWNER')",
      [user.id, org.id, location.id],
    );
  });

  test.afterAll(async () => {
    // Cascades to the location, its settings, memberships and business days.
    await pool.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
    await pool.end();
  });

  async function login(page: Page) {
    await page.goto("/login");
    await page.getByLabel("Adresse e-mail").fill(email);
    await page.getByLabel("Mot de passe").fill(PASSWORD);
    await page.getByRole("button", { name: /se connecter/i }).click();
    await expect(page).toHaveURL(/\/caisse$/);
  }

  async function businessDayOpen(page: Page): Promise<boolean> {
    const response = await page.request.get("/api/cash-summary");
    expect(response.ok()).toBeTruthy();
    return ((await response.json()) as { businessDayOpen: boolean }).businessDayOpen;
  }

  test("a brand new establishment is offered 'Ouvrir le service', and nothing else", async ({
    page,
  }) => {
    await login(page);

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
    await login(page);

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
