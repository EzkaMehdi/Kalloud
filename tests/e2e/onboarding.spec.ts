import { Pool } from "pg";
import { expect, test } from "@playwright/test";
import { escapeRegExp } from "./helpers/floor";

/**
 * SAAS-01's acceptance criterion, verbatim: "aucun SQL ou seed manuel pour
 * un nouveau client."
 *
 * That claim cannot be proved at the integration tier, which reaches
 * `createEstablishment` directly and would leave the question the criterion
 * actually asks — can a person do this with nothing but a browser? —
 * untested. So this spec is deliberately the one file in the suite with no
 * fixture at all: no `createThrowawayTenant`, no `page.request.post` for the
 * table or the product, no seeded login. Every row it needs is produced by
 * clicking, in the order a real new customer meets them.
 *
 * The SQL in `afterAll` is teardown, not setup — the criterion is about
 * what it takes to *create* a customer, and the suite still has to leave the
 * developer's local database as it found it (see global-teardown.ts, which
 * only knows how to clean the shared seeded tenant's fixtures).
 */

const PASSWORD = "Password123!";

const createdOrganizationNames: string[] = [];
const createdEmails: string[] = [];

test.afterAll(async () => {
  if (createdOrganizationNames.length === 0) return;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM organizations WHERE name = ANY($1)",
      [createdOrganizationNames],
    );
    for (const { id } of rows) {
      const { rows: locations } = await pool.query<{ id: number }>(
        "SELECT id FROM locations WHERE organization_id = $1",
        [id],
      );
      for (const location of locations) {
        // Children first, for the same reason helpers/tenant.ts::dispose
        // documents: sales and stock history are deliberately not
        // cascade-deletable from the rows they reference.
        await pool.query("DELETE FROM stock_counts WHERE location_id = $1", [location.id]);
        await pool.query("DELETE FROM stock_movements WHERE location_id = $1", [location.id]);
        await pool.query("DELETE FROM payments WHERE location_id = $1", [location.id]);
        await pool.query("DELETE FROM orders WHERE location_id = $1", [location.id]);
      }
      await pool.query("DELETE FROM organizations WHERE id = $1", [id]);
    }
    // `users` is global, not tenant-scoped: an account can hold memberships
    // in several organizations, so deleting the organization cascades to the
    // membership and leaves the person behind. Without this, every run of
    // this spec would add two permanent rows to a developer's database.
    await pool.query("DELETE FROM login_attempts WHERE email = ANY($1)", [createdEmails]);
    await pool.query("DELETE FROM users WHERE email = ANY($1)", [createdEmails]);
  } finally {
    await pool.end();
  }
});

function newEstablishment(label: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const name = `E2E SAAS-01 ${label} ${suffix}`;
  const email = `saas01-${label}-${suffix}@example.test`;
  createdOrganizationNames.push(name);
  createdEmails.push(email);
  return { name, suffix, email };
}

test.describe("SAAS-01: a new customer sets themselves up with a browser alone", () => {
  test("signup, tables, catalogue and first service, without a single manual insert", async ({
    page,
  }) => {
    const establishment = newEstablishment("full");

    // 1. The way in has to be discoverable from the login screen: before
    //    this ticket, someone with no account had nowhere to go.
    await page.goto("/login");
    await page.getByRole("link", { name: /créer mon établissement/i }).click();
    await expect(page).toHaveURL(/\/signup$/);

    await page.getByLabel("Nom de l'établissement").fill(establishment.name);
    await page.getByLabel("Votre nom").fill("Camille Dubois");
    await page.getByLabel("Adresse e-mail").fill(establishment.email);
    await page.getByLabel("Mot de passe").fill(PASSWORD);
    await page.getByRole("button", { name: /^créer mon établissement$/i }).click();

    // 2. Signed in on the spot, on the establishment just created — not
    //    bounced back to a login form to retype the password.
    await expect(page).toHaveURL(/\/configuration$/);
    // Scoped to the header: since SAAS-02 the team form on this page offers
    // "Propriétaire" as a role option too.
    const identity = page.locator(".user-menu-info");
    await expect(identity).toContainText("Camille Dubois");
    await expect(identity).toContainText("Propriétaire");

    const checklist = page.getByText(/0 étape\(s\) sur 3/);
    await expect(checklist).toBeVisible();

    // 3. A table, through the floor plan form.
    const tableName = `T-${establishment.suffix}`;
    // Scoped to its own card: the categories section reuses the same
    // `NameForm`, so "Créer" is on screen twice.
    const tableForm = page
      .locator(".history-card")
      .filter({ has: page.getByLabel("Nouvelle table") });
    await tableForm.getByLabel("Nouvelle table").fill(tableName);
    await tableForm.getByRole("button", { name: /^créer$/i }).click();
    await expect(page.getByText(/1 étape\(s\) sur 3/)).toBeVisible();

    // 4. A product, through the catalogue form this ticket added — the step
    //    that was impossible before it, and without which the till has
    //    nothing to sell.
    const productName = `Test SAAS-01 ${establishment.suffix}`;
    await page.getByLabel("Nouveau produit").fill(productName);
    await page.getByLabel("Prix de vente (€)").fill("3.20");
    await page.getByLabel("Stock initial (facultatif)").fill("12");
    await page.getByRole("button", { name: /ajouter au catalogue/i }).click();
    await expect(page.getByText(/2 étape\(s\) sur 3/)).toBeVisible();

    // 5. The first service, from the checklist's own link.
    await page.getByRole("link", { name: /y aller/i }).click();
    await expect(page).toHaveURL(/\/caisse$/);
    await page.getByRole("button", { name: /ouvrir le service/i }).click();
    const openDialog = page.getByRole("dialog");
    await openDialog.getByLabel(/fond de caisse d'ouverture/i).fill("50.00");
    await openDialog.getByRole("button", { name: /^ouvrir le service$/i }).click();
    await expect(page.getByText("Service ouvert", { exact: true })).toBeVisible();

    // 6. The establishment can actually trade: its own table opens, and its
    //    own product is in the drawer at the price it was given. This is
    //    what "usable without SQL" has to mean — the rows are not merely
    //    present, they reach the till.
    await page.getByRole("button", { name: new RegExp(escapeRegExp(tableName)) }).click();
    const ticket = page.getByRole("dialog");
    await expect(ticket).toBeVisible();
    await ticket.getByRole("button", { name: new RegExp(escapeRegExp(productName)) }).click();
    await expect(ticket.locator(".ticket-line")).toContainText(productName);
    // The decimal separator is the sale screen's business, not this
    // ticket's — what matters is that the price typed at signup is the one
    // the till charges.
    await expect(ticket.locator(".ticket-line")).toContainText(/3[.,]20\s*€/);

    // 7. Nothing left to prompt: the checklist retires itself.
    await page.goto("/configuration");
    await expect(page.getByText(/étape\(s\) sur 3/)).toHaveCount(0);
  });

  test("refuses a second account on an e-mail already taken, and says so", async ({ page }) => {
    const establishment = newEstablishment("dup");

    await page.goto("/signup");
    await page.getByLabel("Nom de l'établissement").fill(establishment.name);
    await page.getByLabel("Votre nom").fill("Camille Dubois");
    await page.getByLabel("Adresse e-mail").fill(establishment.email);
    await page.getByLabel("Mot de passe").fill(PASSWORD);
    await page.getByRole("button", { name: /^créer mon établissement$/i }).click();
    await expect(page).toHaveURL(/\/configuration$/);

    await page.getByRole("button", { name: /se déconnecter/i }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.goto("/signup");
    await page.getByLabel("Nom de l'établissement").fill("Un autre nom");
    await page.getByLabel("Votre nom").fill("Quelqu'un d'autre");
    await page.getByLabel("Adresse e-mail").fill(establishment.email);
    await page.getByLabel("Mot de passe").fill(PASSWORD);
    await page.getByRole("button", { name: /^créer mon établissement$/i }).click();

    // `.form-error` rather than role=alert: Next's own route announcer is
    // an empty role="alert" that is always in the tree.
    await expect(page.locator("p.form-error")).toContainText(/existe déjà/i);
    // Still on the form, and the typed values survive the error (UX-05).
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByLabel("Nom de l'établissement")).toHaveValue("Un autre nom");
  });
});
