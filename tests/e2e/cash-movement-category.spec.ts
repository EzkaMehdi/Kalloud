import { Pool } from "pg";
import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "../../lib/auth/password";

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

const PASSWORD = "Password123!";

// Shared throwaway establishment, mutated by both tests: order declared, not
// inherited from `fullyParallel` (which parallelises within a file too).
test.describe.serial("CASH-03: a cash movement carries its category", () => {
  let pool: Pool;
  let organizationId: number;
  let locationId: number;
  let email: string;

  test.beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const {
      rows: [org],
    } = await pool.query<{ id: number }>(
      "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
      [`E2E CASH-03 Org ${crypto.randomUUID().slice(0, 8)}`],
    );
    organizationId = org.id;
    const {
      rows: [location],
    } = await pool.query<{ id: number }>(
      "INSERT INTO locations (organization_id, name) VALUES ($1, $2) RETURNING id",
      [org.id, "E2E CASH-03 Location"],
    );
    locationId = location.id;
    await pool.query("INSERT INTO location_settings (location_id) VALUES ($1)", [location.id]);

    email = `cash03-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const {
      rows: [user],
    } = await pool.query<{ id: number }>(
      "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id",
      [email, await hashPassword(PASSWORD), "CASH-03 Owner"],
    );
    await pool.query(
      "INSERT INTO memberships (user_id, organization_id, location_id, role) VALUES ($1, $2, $3, 'OWNER')",
      [user.id, org.id, location.id],
    );
  });

  test.afterAll(async () => {
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

  test("records an end-of-service withdrawal under its own category, and audits it", async ({
    page,
  }) => {
    await login(page);

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

    const { rows } = await pool.query<{ type: string; category: string; amount: string }>(
      "SELECT type, category, amount FROM cash_movements WHERE location_id = $1 AND type = 'OUT'",
      [locationId],
    );
    expect(rows).toEqual([
      { type: "OUT", category: "END_OF_SERVICE_WITHDRAWAL", amount: "150.00" },
    ]);

    // "Auditable" (acceptance): the trail has to say *which* kind of
    // outflow, not merely that 150 € left the till.
    const { rows: audit } = await pool.query<{ action: string; after_data: { category: string } }>(
      "SELECT action, after_data FROM audit_events WHERE location_id = $1 AND action = 'cash_movement.create'",
      [locationId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].after_data.category).toBe("END_OF_SERVICE_WITHDRAWAL");
  });

  test("shows the server's refusal instead of failing silently", async ({ page }) => {
    await login(page);

    // This test's precondition is "no service open", and the tests in this
    // describe share one establishment — so it establishes that state
    // itself rather than depending on having run before the one above.
    // Closing is idempotent enough here: with nothing open the API refuses,
    // which is the state we want anyway.
    // CASH-05: closing carries the count, and a variance beyond the
    // threshold needs a reason. The previous test's withdrawal makes this
    // close a large one; the amounts are irrelevant here — what this test
    // needs is the resulting state, "no service open".
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
