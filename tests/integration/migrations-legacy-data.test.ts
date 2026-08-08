import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migrations must survive a database that already holds data — not just an
 * empty one.
 *
 * ORD-01's `0006_order_lifecycle.sql` originally assumed `orders` was empty
 * everywhere ("zero rows in every environment this migration has run
 * against so far") and added its columns accordingly. The assumption was
 * false for any machine that had processed a sale beforehand: three separate
 * statements failed on such a database, and because the runner stops at the
 * first failing migration, `pnpm db:migrate` and the entire integration
 * suite became unrunnable there. CI never saw it — it starts from an empty
 * database every time, which is exactly the blind spot this test closes.
 *
 * It runs the real migration files, via the real runner, against a
 * throwaway database seeded with pre-ORD-01 rows, and then checks that the
 * data was *converted* rather than merely tolerated.
 */

const migrationsDir = path.join(process.cwd(), "migrations");
const LEGACY_DB = "kalloud_legacy_migration_test";

/** Admin connection (to the maintenance `postgres` database) used to create/drop the throwaway database. */
function adminUrl(): string {
  const url = new URL(requireTestDatabaseUrl());
  url.pathname = "/postgres";
  return url.toString();
}

function legacyUrl(): string {
  const url = new URL(requireTestDatabaseUrl());
  url.pathname = `/${LEGACY_DB}`;
  return url.toString();
}

function requireTestDatabaseUrl(): string {
  const connectionString = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL_TEST is not set.");
  }
  return connectionString;
}

async function withClient<T>(connectionString: string, fn: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Applies migration files whose numeric prefix falls within [from, to], in
 * filename order, each in its own transaction — the same contract as
 * scripts/lib/migrate-core.mjs, restricted to a range so the "before" state
 * of a past release can be reconstructed.
 */
async function applyMigrationRange(client: Client, from: number, to: number): Promise<string[]> {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) => {
      const index = Number(file.slice(0, 4));
      return index >= from && index <= to;
    });

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return files;
}

/** The shape a database had before ORD-01: prototype statuses, no author, no order number. */
async function seedPreOrd01Data(client: Client): Promise<void> {
  await client.query("INSERT INTO organizations (name) VALUES ('Legacy Org')");
  await client.query("INSERT INTO locations (organization_id, name) VALUES (1, 'Legacy Loc')");
  await client.query("INSERT INTO location_settings (location_id) VALUES (1)");
  await client.query(
    "INSERT INTO users (email, password_hash, name) VALUES ('legacy@example.test', 'x', 'Legacy User')",
  );
  await client.query(
    "INSERT INTO memberships (user_id, organization_id, location_id, role) VALUES (1, 1, 1, 'OWNER')",
  );
  await client.query("INSERT INTO business_days (location_id, opening_cash) VALUES (1, 100)");
  await client.query("INSERT INTO categories (location_id, name) VALUES (1, 'Boissons')");
  await client.query(
    "INSERT INTO products (location_id, category_id, name, price, stock_quantity) VALUES (1, 1, 'Café', 2.50, 10)",
  );
  // One of each prototype status, including a mixed sale and a cancelled
  // one — the cancelled row is what proves `closed_at` was not blindly
  // renamed into `paid_at`.
  await client.query(`
    INSERT INTO orders (location_id, business_day_id, status, payment_method, cash_amount, card_amount, total_amount, created_at, closed_at)
    VALUES
      (1, 1, 'COMPLETED', 'CARD',  0.00, 10.00, 10.00, now() - interval '3 hour', now() - interval '3 hour'),
      (1, 1, 'COMPLETED', 'MIXED', 4.00,  6.00, 10.00, now() - interval '2 hour', now() - interval '2 hour'),
      (1, 1, 'PENDING',   NULL,    0.00,  0.00,  7.50, now() - interval '1 hour', NULL),
      (1, 1, 'CANCELLED', NULL,    0.00,  0.00,  5.00, now() - interval '30 min', now() - interval '20 min')
  `);
}

beforeAll(async () => {
  await withClient(adminUrl(), async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${LEGACY_DB}`);
    await client.query(`CREATE DATABASE ${LEGACY_DB}`);
  });
});

afterAll(async () => {
  await withClient(adminUrl(), async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${LEGACY_DB}`);
  });
});

describe("FND-05: migrations run against a database that already holds data", () => {
  let orders: {
    order_number: number;
    status: string;
    paid_at: string | null;
    cancelled_at: string | null;
    created_by: number | null;
  }[];

  beforeAll(async () => {
    await withClient(legacyUrl(), async (client) => {
      // Rebuild the pre-ORD-01 world, then run everything from ORD-01 on.
      await applyMigrationRange(client, 1, 5);
      await seedPreOrd01Data(client);
      await applyMigrationRange(client, 6, 9999);

      const { rows } = await client.query(
        "SELECT order_number, status, paid_at, cancelled_at, created_by FROM orders ORDER BY order_number",
      );
      orders = rows;
    });
  });

  it("applies every migration without failing on the existing rows", () => {
    // Reaching this point at all is the regression guard: the original 0006
    // threw here three times over.
    expect(orders).toHaveLength(4);
  });

  it("maps each prototype status onto its DEC-03 counterpart", () => {
    expect(orders.map((order) => order.status)).toEqual(["PAID", "PAID", "OPEN", "CANCELLED"]);
  });

  it("keeps a paid order's timestamp as paid_at and moves a cancelled one to cancelled_at", () => {
    const [paid, , open, cancelled] = orders;
    expect(paid.paid_at).not.toBeNull();
    expect(paid.cancelled_at).toBeNull();
    // Never paid, so no payment timestamp to inherit.
    expect(open.paid_at).toBeNull();
    // The column rename would otherwise have left this order claiming it was paid.
    expect(cancelled.paid_at).toBeNull();
    expect(cancelled.cancelled_at).not.toBeNull();
  });

  it("numbers existing orders chronologically, per establishment", () => {
    expect(orders.map((order) => order.order_number)).toEqual([1, 2, 3, 4]);
  });

  it("resumes the order-number counter above the highest backfilled number", async () => {
    await withClient(legacyUrl(), async (client) => {
      const { rows } = await client.query<{ next_value: number }>(
        "SELECT next_value FROM order_number_counters WHERE location_id = 1",
      );
      // Anything lower would collide with a backfilled number on the
      // (location_id, order_number) unique index at the next real sale.
      expect(rows[0].next_value).toBe(5);
    });
  });

  it("leaves pre-ORD-01 orders without an author rather than inventing one", () => {
    // Attributing them to the establishment's owner would fabricate
    // audit-log evidence about a person (see migrations/0006).
    expect(orders.every((order) => order.created_by === null)).toBe(true);
  });

  it("still refuses an order that has a fiscal snapshot but no author", async () => {
    await withClient(legacyUrl(), async (client) => {
      await expect(
        client.query(`
          INSERT INTO orders (location_id, business_day_id, order_number, status, total_amount, subtotal_amount, tax_amount)
          VALUES (1, 1, 500, 'PAID', 10.00, 8.33, 1.67)
        `),
      ).rejects.toThrow(/orders_author_required_check/);
    });
  });

  it("does not synthesise payment rows it would have to invent an author for", async () => {
    await withClient(legacyUrl(), async (client) => {
      const { rows } = await client.query<{ count: string }>("SELECT COUNT(*) FROM payments");
      // The two legacy PAID orders keep their own cash_amount/card_amount;
      // nothing is lost, it simply is not restated in a ledger whose
      // created_by would be a guess (see migrations/0009).
      expect(rows[0].count).toBe("0");
    });
  });
});
