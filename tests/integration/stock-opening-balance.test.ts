import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { createProduct } from "../../lib/repositories/products";
import { createProductWithInitialStock } from "../../lib/services/products";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * STK-02's acceptance criterion, verbatim: "solde avant/après migration
 * identique et vérifié par test." The migration itself
 * (migrations/0008_backfill_opening_stock.sql) already ran once,
 * automatically, against an empty `products` table before any test file in
 * this suite executes (tests/integration/global-setup.ts) — there is
 * nothing left for it to backfill by the time a test creates its own
 * fixtures. To prove the backfill logic itself, not just that it compiled,
 * these tests re-run the migration's own SQL text (read from disk, not
 * retyped) against a product deliberately set up to simulate "stock that
 * existed before the ledger did".
 */

let tenant: TestTenant;
let context: RequestContext;

const backfillSql = readFileSync(
  join(process.cwd(), "migrations", "0008_backfill_opening_stock.sql"),
  "utf8",
)
  // The two ALTER statements already applied once via global-setup and are
  // not repeatable (DROP NOT NULL / ADD CONSTRAINT on an already-altered,
  // already-constrained column errors on a second run) — only the backfill
  // INSERT itself needs re-running here.
  .split("INSERT INTO")[1];
const backfillInsertSql = `INSERT INTO${backfillSql}`;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Stock Backfill Tenant");
  const owner = await createTestUser(pool, tenant, "OWNER");
  context = {
    userId: owner.userId,
    userEmail: owner.email,
    userName: "Owner",
    organizationId: tenant.organizationId,
    locationId: tenant.locationId,
    role: "OWNER",
    sessionId: 1,
  };
});

describe("STK-02: backfilling existing stock into the ledger", () => {
  it("records a matching OPENING_BALANCE movement without changing the balance it explains", async () => {
    // Simulates a product whose stock_quantity predates the ledger: created
    // directly via the repository (bypassing STK-02's own
    // createProductWithInitialStock), the same shape the real historical
    // data was in before this migration first ran.
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Chicha préexistante",
      price: "16.00",
      stockQuantity: 25,
    });

    await pool.query(backfillInsertSql);

    const { rows: movements } = await pool.query(
      "SELECT quantity, type, created_by, reason FROM stock_movements WHERE product_id = $1",
      [product.id],
    );
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(25);
    expect(movements[0].type).toBe("OPENING_BALANCE");
    expect(movements[0].created_by).toBeNull();

    const { rows: products } = await pool.query(
      "SELECT stock_quantity FROM products WHERE id = $1",
      [product.id],
    );
    expect(products[0].stock_quantity).toBe(25);
  });

  it("does not create a movement for a product already at zero stock", async () => {
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Jamais réapprovisionné",
      price: "5.00",
      stockQuantity: 0,
    });

    await pool.query(backfillInsertSql);

    const { rows } = await pool.query("SELECT * FROM stock_movements WHERE product_id = $1", [
      product.id,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("is safe to run twice (idempotent in effect on a balance already backfilled) — WHERE stock_quantity <> 0 keeps matching, so re-running duplicates rather than corrupts", async () => {
    // Documents a real limitation rather than hiding it: the backfill is a
    // one-shot migration, not a repeatable reconciliation job. Run twice
    // against the same untouched product, it records two OPENING_BALANCE
    // entries — both individually correct, but doubling the ledger's
    // explanation for a balance that only changed once. Migrations are
    // tracked and applied exactly once in every real environment
    // (scripts/lib/migrate-core.mjs), so this never happens outside of this
    // test deliberately forcing it.
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Produit test double-run",
      price: "9.00",
      stockQuantity: 4,
    });

    await pool.query(backfillInsertSql);
    await pool.query(backfillInsertSql);

    const { rows } = await pool.query(
      "SELECT quantity FROM stock_movements WHERE product_id = $1",
      [product.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(8);
  });

  it("rejects a non-OPENING_BALANCE movement with no author (0008's author-required CHECK)", async () => {
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Sans auteur",
      price: "3.00",
      stockQuantity: 0,
    });

    await expect(
      pool.query(
        `INSERT INTO stock_movements (location_id, product_id, quantity, type, reason, created_by)
         VALUES ($1, $2, 5, 'RECEIPT', 'sans auteur', NULL)`,
        [tenant.locationId, product.id],
      ),
    ).rejects.toThrow(/stock_movements_author_required_check/);
  });
});

describe("STK-02: new products no longer reopen the gap the backfill closed", () => {
  it("records a real, attributed OPENING_BALANCE movement when a product is created with starting stock", async () => {
    const product = await createProductWithInitialStock(context, {
      categoryId: null,
      name: "Nouveau produit",
      price: "12.00",
      stockQuantity: 15,
    });

    expect(product.stock_quantity).toBe(15);

    const { rows } = await pool.query(
      "SELECT quantity, type, created_by FROM stock_movements WHERE product_id = $1",
      [product.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(15);
    expect(rows[0].type).toBe("OPENING_BALANCE");
    // Unlike the historical backfill, this movement has a real actor: the
    // user who created the product.
    expect(rows[0].created_by).toBe(context.userId);
  });

  it("records no movement for a product created with no starting stock", async () => {
    const product = await createProductWithInitialStock(context, {
      categoryId: null,
      name: "Sans stock au départ",
      price: "7.00",
    });

    expect(product.stock_quantity).toBe(0);
    const { rows } = await pool.query("SELECT * FROM stock_movements WHERE product_id = $1", [
      product.id,
    ]);
    expect(rows).toHaveLength(0);
  });
});
