import { Pool } from "pg";
import { expect, test } from "@playwright/test";

/**
 * OPS-06: "tests navigateur → API → base → réponse sur les invariants
 * critiques", et « onboarding, ticket, vente, stock, clôture et métriques
 * fondamentales passent sur une base neuve ».
 *
 * One journey, in order, from an establishment that did not exist when the
 * test started. Two things make it different from every other spec in this
 * suite rather than a longer version of them:
 *
 * 1. **No fixture at all.** The establishment is created through the signup
 *    form (SAAS-01), so nothing seeded is read or relied upon — that is what
 *    "base neuve" means here, and it is not a claim: `pnpm test:e2e:fresh`
 *    resets and migrates the database *without seeding it* and runs this
 *    file alone. It passes with zero organizations, zero users and zero
 *    products in the database. The assertions below then prove the tenant
 *    it creates starts empty too, rather than assuming it.
 *
 * 2. **The database is the last assertion, not the screen.** Every other
 *    spec stops at what the interface shows or what an endpoint returns.
 *    Here each step is checked against the raw tables, and the closing's
 *    expected cash is *recomputed from the ledger* — the way an accountant
 *    would — then compared with the figure the application froze. A screen
 *    can agree with an API that agrees with a service that all share the
 *    same wrong assumption; the ledger cannot.
 */

const PASSWORD = "Password123!";

let pool: Pool;
const createdOrganizations: string[] = [];
const createdEmails: string[] = [];

test.beforeAll(() => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
});

test.afterAll(async () => {
  try {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM organizations WHERE name = ANY($1)",
      [createdOrganizations],
    );
    for (const { id } of rows) {
      const { rows: locations } = await pool.query<{ id: number }>(
        "SELECT id FROM locations WHERE organization_id = $1",
        [id],
      );
      for (const location of locations) {
        // Children first: sales and stock history are deliberately not
        // cascade-deletable (see tests/e2e/helpers/tenant.ts).
        await pool.query("DELETE FROM stock_counts WHERE location_id = $1", [location.id]);
        await pool.query("DELETE FROM stock_movements WHERE location_id = $1", [location.id]);
        await pool.query("DELETE FROM payments WHERE location_id = $1", [location.id]);
        await pool.query("DELETE FROM orders WHERE location_id = $1", [location.id]);
      }
      await pool.query("DELETE FROM organizations WHERE id = $1", [id]);
    }
    await pool.query("DELETE FROM login_attempts WHERE email = ANY($1)", [createdEmails]);
    await pool.query("DELETE FROM users WHERE email = ANY($1)", [createdEmails]);
  } finally {
    await pool.end();
  }
});

/** One number, read straight from the tables. */
async function scalar(sql: string, params: unknown[]): Promise<string> {
  const { rows } = await pool.query<{ value: string }>(sql, params);
  return rows[0].value;
}

test("OPS-06: onboarding, ticket, vente, stock, clôture et métriques, sur une base neuve", async ({
  page,
}) => {
  test.slow();
  const suffix = crypto.randomUUID().slice(0, 8);
  const establishment = `E2E OPS-06 ${suffix}`;
  const email = `ops06-${suffix}@example.test`;
  createdOrganizations.push(establishment);
  createdEmails.push(email);

  // ─────────── 1. Onboarding ───────────
  await page.goto("/signup");
  await page.getByLabel("Nom de l'établissement").fill(establishment);
  await page.getByLabel("Votre nom").fill("Nadia Lefèvre");
  await page.getByLabel("Adresse e-mail").fill(email);
  await page.getByLabel("Mot de passe").fill(PASSWORD);
  await page.getByRole("button", { name: /^créer mon établissement$/i }).click();
  await expect(page).toHaveURL(/\/configuration$/);

  const { rows: tenant } = await pool.query<{ location_id: number; organization_id: number }>(
    `SELECT l.id AS location_id, l.organization_id
       FROM locations l JOIN organizations o ON o.id = l.organization_id
      WHERE o.name = $1`,
    [establishment],
  );
  expect(tenant, "signup must create exactly one establishment").toHaveLength(1);
  const locationId = tenant[0].location_id;

  // "Base neuve", asserted rather than assumed: this tenant owns nothing
  // yet, so nothing below can be passing on seeded data.
  for (const table of ["dining_tables", "products", "orders", "business_days", "cash_movements"]) {
    expect(
      await scalar(`SELECT COUNT(*)::TEXT AS value FROM ${table} WHERE location_id = $1`, [
        locationId,
      ]),
      `a new establishment must own no ${table}`,
    ).toBe("0");
  }
  // The settings row exists with DEC-05's fallback tax rate — without it the
  // very first sale could not be taxed.
  expect(
    await scalar(
      "SELECT default_tax_rate::TEXT AS value FROM location_settings WHERE location_id = $1",
      [locationId],
    ),
  ).toBe("20.00");

  // ─────────── 2. Configuration ───────────
  const tableName = `T-${suffix}`;
  const productName = `Test OPS-06 ${suffix}`;

  const tableForm = page
    .locator(".history-card")
    .filter({ has: page.getByLabel("Nouvelle table") });
  await tableForm.getByLabel("Nouvelle table").fill(tableName);
  await tableForm.getByRole("button", { name: /^créer$/i }).click();

  await page.getByLabel("Nouveau produit").fill(productName);
  await page.getByLabel("Prix de vente (€)").fill("4.00");
  await page.getByLabel("Stock initial (facultatif)").fill("10");
  await page.getByRole("button", { name: /ajouter au catalogue/i }).click();
  await expect(page.getByText(/2 étape\(s\) sur 3/)).toBeVisible();

  const { rows: products } = await pool.query<{
    id: number;
    price: string;
    stock_quantity: number;
  }>("SELECT id, price, stock_quantity FROM products WHERE location_id = $1", [locationId]);
  expect(products).toHaveLength(1);
  expect(products[0].price).toBe("4.00");
  const productId = products[0].id;

  // DEC-06's materialised-balance invariant, from the first row onwards: the
  // stock a screen shows is the sum of the movements that produced it, never
  // a number written on its own.
  const stockMatchesLedger = async () => {
    const materialised = await scalar(
      "SELECT stock_quantity::TEXT AS value FROM products WHERE id = $1",
      [productId],
    );
    const ledger = await scalar(
      "SELECT COALESCE(SUM(quantity), 0)::TEXT AS value FROM stock_movements WHERE product_id = $1",
      [productId],
    );
    expect(materialised, "products.stock_quantity must equal SUM(stock_movements)").toBe(ledger);
    return Number(materialised);
  };
  expect(await stockMatchesLedger()).toBe(10);
  expect(
    await scalar(
      "SELECT COUNT(*)::TEXT AS value FROM stock_movements WHERE product_id = $1 AND type = 'OPENING_BALANCE'",
      [productId],
    ),
    "the initial stock must be a traceable movement, not a number typed into a column",
  ).toBe("1");

  // ─────────── 3. Ouverture du service ───────────
  await page.getByRole("link", { name: /y aller/i }).click();
  await expect(page).toHaveURL(/\/caisse$/);
  await page.getByRole("button", { name: /ouvrir le service/i }).click();
  const openDialog = page.getByRole("dialog");
  await openDialog.getByLabel(/fond de caisse d'ouverture/i).fill("100.00");
  await openDialog.getByRole("button", { name: /^ouvrir le service$/i }).click();
  await expect(page.getByText("Service ouvert", { exact: true })).toBeVisible();

  const { rows: days } = await pool.query<{ id: number; opening_cash: string; status: string }>(
    "SELECT id, opening_cash, status FROM business_days WHERE location_id = $1",
    [locationId],
  );
  expect(days).toHaveLength(1);
  expect(days[0]).toMatchObject({ opening_cash: "100.00", status: "OPEN" });
  const businessDayId = days[0].id;

  // CASH-01/CASH-03: the float is written to the journal as well as to the
  // day, so the drawer's history explains its own starting balance.
  expect(
    await scalar(
      "SELECT amount::TEXT AS value FROM cash_movements WHERE business_day_id = $1 AND type = 'OPENING'",
      [businessDayId],
    ),
  ).toBe("100.00");

  // ─────────── 4. Ticket ───────────
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page.getByRole("button", { name: new RegExp(escaped) }).click();
  const ticket = page.getByRole("dialog");
  const productButton = ticket.getByRole("button", {
    name: new RegExp(productName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  });
  await productButton.click();
  await productButton.click();
  await expect(ticket.locator(".ticket-total")).toContainText("8.00");

  // ORD-04: a ticket outlives the browser. Reloading is the cheapest proof
  // that it lives in the database and not in a component's state.
  await page.reload();
  await page.getByRole("button", { name: new RegExp(escaped) }).click();
  const resumed = page.getByRole("dialog");
  await expect(resumed.locator(".ticket-total")).toContainText("8.00");

  const { rows: open } = await pool.query<{ id: number; status: string; total_amount: string }>(
    "SELECT id, status, total_amount FROM orders WHERE location_id = $1",
    [locationId],
  );
  expect(open).toHaveLength(1);
  expect(open[0].status).toBe("OPEN");
  const orderId = open[0].id;
  // The order's total is the sum of its own lines, not a figure the client
  // sent along with them (SALE-06).
  expect(open[0].total_amount).toBe(
    await scalar(
      "SELECT SUM(quantity * unit_price)::DECIMAL(10,2)::TEXT AS value FROM order_items WHERE order_id = $1",
      [orderId],
    ),
  );

  // ─────────── 5. Vente ───────────
  await resumed.getByRole("radio", { name: "Espèces" }).click();
  await resumed.getByRole("button", { name: /encaisser/i }).click();
  await expect(resumed).toBeHidden();

  expect(await scalar("SELECT status AS value FROM orders WHERE id = $1", [orderId])).toBe("PAID");
  // What was taken equals what was charged.
  expect(
    await scalar(
      "SELECT COALESCE(SUM(CASE WHEN type = 'CHARGE' THEN amount ELSE -amount END), 0)::DECIMAL(10,2)::TEXT AS value FROM payments WHERE order_id = $1",
      [orderId],
    ),
  ).toBe("8.00");
  expect(await scalar("SELECT method AS value FROM payments WHERE order_id = $1", [orderId])).toBe(
    "CASH",
  );

  // ─────────── 6. Stock ───────────
  expect(await stockMatchesLedger(), "two units sold must leave eight").toBe(8);
  expect(
    await scalar(
      "SELECT quantity::TEXT AS value FROM stock_movements WHERE product_id = $1 AND type = 'SALE'",
      [productId],
    ),
    "the sale must appear as a negative movement, not as a silent rewrite",
  ).toBe("-2");

  await page.goto("/stock");
  await expect(page.locator(".stock-row").filter({ hasText: productName })).toContainText("8");

  // ─────────── 7. Clôture ───────────
  await page.goto("/caisse");
  await page.getByRole("button", { name: /compter et clôturer la caisse/i }).click();
  const closeDialog = page.getByRole("dialog");
  // 100 € float + 8 € cash sale.
  await expect(closeDialog).toContainText("108,00 €");
  await closeDialog.getByLabel(/espèces comptées/i).fill("108");
  await closeDialog.getByRole("button", { name: /compter et clôturer la caisse/i }).click();
  await expect(closeDialog).toBeHidden();

  // CASH-04's formula, recomputed here from the raw tables the way an
  // accountant would, then compared with the amount the application froze at
  // closing time. This is the assertion the whole spec exists for: a screen
  // can agree with an API that agrees with a service that all share one
  // wrong assumption — the ledger cannot.
  const recomputed = await scalar(
    `SELECT (
         d.opening_cash
       + COALESCE((SELECT SUM(CASE WHEN p.type = 'CHARGE' THEN p.amount ELSE -p.amount END)
                     FROM payments p JOIN orders o ON o.id = p.order_id
                    WHERE p.method = 'CASH' AND o.business_day_id = d.id), 0)
       + COALESCE((SELECT SUM(amount) FROM cash_movements
                    WHERE business_day_id = d.id AND type = 'IN'), 0)
       - COALESCE((SELECT SUM(amount) FROM cash_movements
                    WHERE business_day_id = d.id AND type = 'OUT'), 0)
       )::DECIMAL(10,2)::TEXT AS value
       FROM business_days d WHERE d.id = $1`,
    [businessDayId],
  );
  const { rows: closed } = await pool.query<{
    status: string;
    expected_cash: string;
    counted_cash: string;
    cash_variance: string;
  }>("SELECT status, expected_cash, counted_cash, cash_variance FROM business_days WHERE id = $1", [
    businessDayId,
  ]);
  expect(closed[0].status).toBe("CLOSED");
  expect(closed[0].expected_cash).toBe(recomputed);
  expect(closed[0].expected_cash).toBe("108.00");
  expect(closed[0].counted_cash).toBe("108.00");
  expect(closed[0].cash_variance).toBe("0.00");

  await expect(page.getByText("Aucun service ouvert")).toBeVisible();

  // ─────────── 8. Métriques ───────────
  await page.goto("/bilan");
  const revenue = page.locator(".kpi", { hasText: "Chiffre d'affaires" });
  const orders = page.locator(".kpi", { hasText: "Commandes" });

  // "Aujourd'hui" means *the open service*, not the calendar day — DEC-04's
  // reading of "service en cours", and the service was just closed, so it
  // legitimately reports nothing. Reading the month is what asks the
  // question this step is about: did the sale reach the cockpit at all.
  await expect(revenue.locator("strong")).toHaveText("0,00 €");
  await page.getByRole("tab", { name: "Ce mois" }).click();
  await expect(revenue.locator("strong")).toHaveText("8,00 €");
  await expect(orders.locator("strong")).toHaveText("1");

  // And the cockpit's figure is the ledger's own, not a parallel count.
  expect(
    await scalar(
      "SELECT COALESCE(SUM(total_amount), 0)::DECIMAL(10,2)::TEXT AS value FROM orders WHERE location_id = $1 AND status = 'PAID'",
      [locationId],
    ),
  ).toBe("8.00");

  // SEC-09: the acts that shaped this establishment left a trail.
  const { rows: audit } = await pool.query<{ action: string }>(
    "SELECT DISTINCT action FROM audit_events WHERE location_id = $1",
    [locationId],
  );
  expect(audit.map((row) => row.action)).toEqual(
    expect.arrayContaining(["establishment.create", "business_day.close"]),
  );
});
