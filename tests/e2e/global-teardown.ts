import { Pool } from "pg";
// @ts-expect-error -- plain JS module shared with the CLI runner, see scripts/lib/pg-wait.mjs
import { isLocalDatabaseUrl } from "../../scripts/lib/pg-wait.mjs";

/**
 * Removes the fixtures the e2e suite creates in the database it runs
 * against. Each spec deliberately works on isolated rows of its own — a
 * table per test (helpers/floor.ts::openOwnTable), a product per test — to
 * avoid the shared-state races this suite has been bitten by; nothing ever
 * removed them afterwards, so a developer's floor plan filled up with
 * "Test table 73865b08" and their stock screen with "Test SALE-07 …" at a
 * rate of a few dozen rows per run.
 *
 * CI never noticed because it reseeds from scratch before every run. This is
 * therefore a local-development fix, and it is deliberately a teardown
 * rather than a per-test cleanup: a spec's table accumulates real orders
 * (paid, cancelled, refunded) that the FKs below will not let go until the
 * end, and tearing an order down mid-run would race the very parallelism it
 * exists to survive.
 *
 * Deletion order is dictated by the schema, which cascades in only one
 * place: `order_items` follows its order, but `payments` → `orders`,
 * `orders` → `dining_tables`, `order_items`/`stock_movements` → `products`
 * are all NO ACTION and must be unwound by hand, children first.
 */

const TEST_TABLE_PATTERNS = ["Test table %", "T-%"];
const TEST_PRODUCT_PATTERN = "Test %";

export default async function globalTeardown(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return;

  // Same posture as scripts/reset-db.mjs: this deletes rows, so it refuses
  // to touch anything that is not obviously a local database. A misconfigured
  // DATABASE_URL should leave a remote database untouched and say so, not
  // quietly prune it.
  if (!isLocalDatabaseUrl(connectionString)) {
    console.warn("[e2e teardown] DATABASE_URL is not local — leaving test fixtures in place.");
    return;
  }

  const pool = new Pool({ connectionString });
  try {
    // Orders to remove: those taken on a test table, plus the counter
    // tickets (table_id IS NULL, so invisible to the first rule) that sold a
    // test product. Both markers are names no seeded row uses.
    const { rows: orders } = await pool.query<{ id: number }>(
      `SELECT o.id FROM orders o
        WHERE o.table_id IN (SELECT id FROM dining_tables WHERE name LIKE ANY($1))
           OR o.id IN (
             SELECT oi.order_id FROM order_items oi
               JOIN products p ON p.id = oi.product_id
              WHERE p.name LIKE $2
           )`,
      [TEST_TABLE_PATTERNS, TEST_PRODUCT_PATTERN],
    );
    const orderIds = orders.map((order) => order.id);

    if (orderIds.length > 0) {
      await pool.query("DELETE FROM payments WHERE order_id = ANY($1)", [orderIds]);
      // order_items cascade from here.
      await pool.query("DELETE FROM orders WHERE id = ANY($1)", [orderIds]);
    }

    const { rowCount: tables } = await pool.query(
      "DELETE FROM dining_tables WHERE name LIKE ANY($1)",
      [TEST_TABLE_PATTERNS],
    );

    await pool.query(
      "DELETE FROM stock_movements WHERE product_id IN (SELECT id FROM products WHERE name LIKE $1)",
      [TEST_PRODUCT_PATTERN],
    );
    // Any test product still referenced by a surviving order_item is left
    // alone rather than forced: an order that outlived this cleanup is one
    // the markers above did not claim, and rewriting its lines to tidy a
    // dev screen would be worse than the clutter.
    const { rowCount: products } = await pool.query(
      `DELETE FROM products p
        WHERE p.name LIKE $1
          AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.product_id = p.id)`,
      [TEST_PRODUCT_PATTERN],
    );

    console.log(
      `[e2e teardown] removed ${tables ?? 0} test table(s), ${orderIds.length} order(s), ${products ?? 0} product(s).`,
    );
  } finally {
    await pool.end();
  }
}
