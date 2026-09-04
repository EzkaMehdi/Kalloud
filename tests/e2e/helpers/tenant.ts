import { Pool } from "pg";
import { expect, type Page } from "@playwright/test";
import { hashPassword } from "../../../lib/auth/password";

/**
 * Creates an establishment this spec alone owns, directly in the database
 * the Playwright web server already uses.
 *
 * The seeded tenant is not usable for anything that touches the business
 * day: closing it is a location-wide act, and under `fullyParallel` every
 * sale spec is concurrently selling against its open service. The first
 * cash spec worked around that by hand; by the fourth the setup was copied
 * four times, so it lives here instead. Same precedent as
 * tests/e2e/tenant-isolation.spec.ts, which established the pattern.
 *
 * Call `dispose()` in `afterAll`: deleting the organization cascades to its
 * location, settings, memberships, business days and movements.
 */
export interface ThrowawayTenant {
  pool: Pool;
  organizationId: number;
  locationId: number;
  ownerUserId: number;
  email: string;
  password: string;
  login(page: Page): Promise<void>;
  dispose(): Promise<void>;
}

const PASSWORD = "Password123!";

export async function createThrowawayTenant(label: string): Promise<ThrowawayTenant> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const suffix = crypto.randomUUID().slice(0, 8);

  const {
    rows: [org],
  } = await pool.query<{ id: number }>(
    "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
    [`E2E ${label} Org ${suffix}`],
  );
  const {
    rows: [location],
  } = await pool.query<{ id: number }>(
    "INSERT INTO locations (organization_id, name) VALUES ($1, $2) RETURNING id",
    [org.id, `E2E ${label} Location`],
  );
  await pool.query("INSERT INTO location_settings (location_id) VALUES ($1)", [location.id]);

  const email = `${label.toLowerCase().replace(/[^a-z0-9]/g, "")}-${suffix}@example.test`;
  const {
    rows: [user],
  } = await pool.query<{ id: number }>(
    "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id",
    [email, await hashPassword(PASSWORD), `${label} Owner`],
  );
  await pool.query(
    "INSERT INTO memberships (user_id, organization_id, location_id, role) VALUES ($1, $2, $3, 'OWNER')",
    [user.id, org.id, location.id],
  );

  return {
    pool,
    organizationId: org.id,
    locationId: location.id,
    ownerUserId: user.id,
    email,
    password: PASSWORD,
    async login(page: Page) {
      await page.goto("/login");
      await page.getByLabel("Adresse e-mail").fill(email);
      await page.getByLabel("Mot de passe").fill(PASSWORD);
      await page.getByRole("button", { name: /se connecter/i }).click();
      await expect(page).toHaveURL(/\/caisse$/);
    },
    async dispose() {
      // Historical, financial and stock rows are deliberately NOT
      // cascade-deletable from `products`/`orders` (CFG-02/DEC-05/DEC-06:
      // this codebase never deletes sold history, only deactivates or
      // reverses it) — so a location that ever completed a real sale or a
      // stock operation has to be torn down in the order its own FOREIGN
      // KEY constraints require, not in one cascading statement from
      // `organizations`. `stock_counts` first: it references both
      // `products` and `stock_movements` (the CORRECTION a count
      // produced), so it has to go before either. Then `stock_movements`
      // itself (references `products`), then `payments` (references
      // `orders`), then `orders` — which *does* cascade to `order_items`
      // via its own ON DELETE CASCADE. Only once all of that is gone does
      // the remaining cascade from `organizations` (locations, products,
      // categories) meet nothing still pointing at what it deletes.
      await pool.query("DELETE FROM stock_counts WHERE location_id = $1", [location.id]);
      await pool.query("DELETE FROM stock_movements WHERE location_id = $1", [location.id]);
      await pool.query("DELETE FROM payments WHERE location_id = $1", [location.id]);
      await pool.query("DELETE FROM orders WHERE location_id = $1", [location.id]);
      await pool.query("DELETE FROM organizations WHERE id = $1", [org.id]);
      // `users` is global, so the cascade from `organizations` takes the
      // membership and leaves the person: without this every run added one
      // permanent row per spec using this helper.
      await pool.query("DELETE FROM login_attempts WHERE email = $1", [email]);
      await pool.query("DELETE FROM users WHERE id = $1", [user.id]);
      await pool.end();
    },
  };
}

/** Opens a service through the interface, the only way one is created (CASH-02). */
export async function openService(page: Page, amount: string): Promise<void> {
  await page.getByRole("button", { name: /ouvrir le service/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/fond de caisse d'ouverture/i).fill(amount);
  await dialog.getByRole("button", { name: /^ouvrir le service$/i }).click();
  await expect(page.getByText("Service ouvert", { exact: true })).toBeVisible();
}
