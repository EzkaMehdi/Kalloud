import { Pool } from "pg";
import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "../../lib/auth/password";

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

const PASSWORD = "Password123!";

test.describe.serial("CASH-06: open tickets block the close", () => {
  let pool: Pool;
  let organizationId: number;
  let email: string;

  test.beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const {
      rows: [org],
    } = await pool.query<{ id: number }>(
      "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
      [`E2E CASH-06 Org ${crypto.randomUUID().slice(0, 8)}`],
    );
    organizationId = org.id;
    const {
      rows: [location],
    } = await pool.query<{ id: number }>(
      "INSERT INTO locations (organization_id, name) VALUES ($1, $2) RETURNING id",
      [org.id, "E2E CASH-06 Location"],
    );
    await pool.query("INSERT INTO location_settings (location_id) VALUES ($1)", [location.id]);

    email = `cash06-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const {
      rows: [user],
    } = await pool.query<{ id: number }>(
      "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id",
      [email, await hashPassword(PASSWORD), "CASH-06 Owner"],
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

  test("names the blocking ticket instead of offering a count that cannot be submitted", async ({
    page,
  }) => {
    await login(page);

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
    await login(page);

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
