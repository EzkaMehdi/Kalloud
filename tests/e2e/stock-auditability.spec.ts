import { Pool } from "pg";
import { expect, test, type Page } from "@playwright/test";
import { createThrowawayTenant, type ThrowawayTenant } from "./helpers/tenant";

/**
 * STK-10's acceptance criterion: "chaque opération visible correspond à un
 * mouvement auditable."
 *
 * The seven items of its livrable — réception, perte, correction,
 * inventaire, alertes, état vide, resynchronisation — are each already
 * driven through the interface by the specs written with their own ticket
 * (stock-adjustment, stock-count, stock-list). Repeating them here would
 * add files, not coverage.
 *
 * What none of them assert is the *correspondence*. They check that the
 * balance moved; this checks that what a person did on screen left a record
 * naming what they did, who they are, and when — the difference between a
 * stock that changed and a stock whose change can be accounted for.
 *
 * The trail is read from the database directly: `listAuditEvents` exists but
 * no endpoint exposes it yet (DEC-07 grants the right to consult it; the
 * screen is later work). Same precedent as tests/e2e/tenant-isolation.spec.ts.
 */

interface AuditRow {
  action: string;
  actor_user_id: number;
  after_data: { type?: string; delta?: number; counted?: number; difference?: number };
}

test.describe.serial("STK-10: every visible operation leaves an auditable trace", () => {
  let tenant: ThrowawayTenant;

  test.beforeAll(async () => {
    tenant = await createThrowawayTenant("STK-10");
  });

  test.afterAll(() => tenant.dispose());

  async function auditFor(action: string): Promise<AuditRow[]> {
    const { rows } = await tenant.pool.query<AuditRow>(
      "SELECT action, actor_user_id, after_data FROM audit_events WHERE location_id = $1 AND action = $2 ORDER BY id",
      [tenant.locationId, action],
    );
    return rows;
  }

  async function movements() {
    const { rows } = await tenant.pool.query<{ type: string; quantity: number; reason: string }>(
      "SELECT type, quantity, reason FROM stock_movements WHERE location_id = $1 ORDER BY id",
      [tenant.locationId],
    );
    return rows;
  }

  /** Drives the adjustment dialog exactly as a user does. */
  async function adjust(page: Page, type: string, quantity: string, reason: string) {
    await page
      .locator(".stock-row")
      .getByRole("button", { name: /ajouter du stock/i })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/type de mouvement/i).selectOption(type);
    await dialog.getByLabel(/quantité/i).fill(quantity);
    await dialog.getByLabel(/motif/i).fill(reason);
    await dialog.getByRole("button", { name: /enregistrer le mouvement/i }).click();
    await expect(dialog).toHaveCount(0);
  }

  test("records each of the four operations with its own audited movement", async ({ page }) => {
    await tenant.login(page);
    const created = await page.request.post("/api/products", {
      data: { categoryId: null, name: "Sirop", price: "3.00", stockQuantity: 20 },
    });
    expect(created.ok()).toBeTruthy();

    await page.goto("/stock");
    await adjust(page, "RECEIPT", "6", "Livraison du mardi");
    await adjust(page, "LOSS", "2", "Bouteille cassée");
    await adjust(page, "RETURN", "1", "Retour client");
    await adjust(page, "CORRECTION", "3", "Écart constaté");

    // Four clicks, four ledger movements, in the order they were performed
    // and with the words the operator used — not a fixed label the screen
    // supplied for them (the prompt's failing, STK-05).
    const ledger = await movements();
    expect(ledger.map((row) => [row.type, row.quantity])).toEqual([
      ["OPENING_BALANCE", 20],
      ["RECEIPT", 6],
      ["LOSS", -2],
      ["RETURN", 1],
      ["CORRECTION", 3],
    ]);
    expect(ledger.map((row) => row.reason)).toContain("Bouteille cassée");

    // And four audit entries, each naming the operation and its author.
    const audited = await auditFor("stock.adjust");
    expect(audited).toHaveLength(4);
    expect(audited.map((row) => row.after_data.type)).toEqual([
      "RECEIPT",
      "LOSS",
      "RETURN",
      "CORRECTION",
    ]);
    expect(audited.every((row) => typeof row.actor_user_id === "number")).toBe(true);
    expect(audited.map((row) => row.after_data.delta)).toEqual([6, -2, 1, 3]);
  });

  test("audits a physical count, including the one that produced no movement", async ({ page }) => {
    await tenant.login(page);
    await page.goto("/stock");

    const row = page.locator(".stock-row").filter({ hasText: "Sirop" });
    const before = (await movements()).length;

    // A count with an écart: it corrects, so it also moves the ledger.
    await row.getByRole("button", { name: /^compter/i }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel(/quantité comptée/i).fill("25");
    await dialog.getByRole("button", { name: /enregistrer le comptage/i }).click();
    await expect(dialog).toHaveCount(0);

    // A count that matched: no movement, and that is correct — but the
    // operation was still performed, so it must still be accounted for.
    await row.getByRole("button", { name: /^compter/i }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel(/quantité comptée/i).fill("25");
    await dialog.getByRole("button", { name: /enregistrer le comptage/i }).click();
    await expect(dialog).toHaveCount(0);

    // One new movement for two counts.
    expect((await movements()).length).toBe(before + 1);

    // But two audit entries: the acceptance is about every operation being
    // accountable, and "counted, nothing was wrong" is an operation.
    const audited = await auditFor("stock.count");
    expect(audited).toHaveLength(2);
    // 20 + 6 − 2 + 1 + 3 = 28 après le test précédent, donc compter 25 fait −3.
    expect(audited.map((row) => row.after_data.difference)).toEqual([-3, 0]);
    expect(audited.map((row) => row.after_data.counted)).toEqual([25, 25]);
  });

  test("leaves nothing behind when an operation is refused", async ({ page }) => {
    await tenant.login(page);
    await page.goto("/stock");

    const beforeMovements = (await movements()).length;
    const beforeAudits = (await auditFor("stock.adjust")).length;

    // Refused server-side: only a CORRECTION may go below zero (DEC-06).
    await page
      .locator(".stock-row")
      .getByRole("button", { name: /ajouter du stock/i })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/type de mouvement/i).selectOption("LOSS");
    await dialog.getByLabel(/quantité/i).fill("999");
    await dialog.getByLabel(/motif/i).fill("Tentative impossible");
    await dialog.getByRole("button", { name: /enregistrer le mouvement/i }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();

    // A refusal is not an operation: no movement, and no audit entry either.
    // An audit trail that recorded attempts would make every real entry
    // harder to trust.
    expect((await movements()).length).toBe(beforeMovements);
    expect((await auditFor("stock.adjust")).length).toBe(beforeAudits);
  });
});

/**
 * The seeded catalogue is the state every developer and every CI run starts
 * from, and it is written by `scripts/seed.mjs` in raw SQL — a third writer
 * beside the service and the migrations. It inserted `stock_quantity`
 * without the `OPENING_BALANCE` movement explaining it, so a freshly seeded
 * database violated STK-09's invariant on its very first `pnpm db:seed`:
 * nine products whose balance no movement accounted for.
 *
 * The integration suite could not see it — it builds its own tenants and
 * never runs the seed. This tier does, which is why the guard lives here.
 */
test("STK-09/STK-10: the seeded catalogue reconciles with its own ledger", async ({ page }) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query<{ name: string; balance: number; ledger: number }>(
      `SELECT p.name, p.stock_quantity AS balance,
              COALESCE((SELECT SUM(m.quantity) FROM stock_movements m
                         WHERE m.product_id = p.id AND m.location_id = p.location_id), 0)::INT AS ledger
         FROM products p
        WHERE p.stock_quantity <> COALESCE((SELECT SUM(m.quantity) FROM stock_movements m
                                             WHERE m.product_id = p.id AND m.location_id = p.location_id), 0)`,
    );
    expect(rows, "every product's balance must be explained by its movements").toEqual([]);
  } finally {
    await pool.end();
  }
  // `page` is unused on purpose: this asserts about the database the running
  // server was seeded with, not about a screen.
  expect(page).toBeTruthy();
});
