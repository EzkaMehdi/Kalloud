#!/usr/bin/env node
// FND-06: turns a freshly migrated, empty database into something a
// developer can actually open the app and take a sale against — one
// organization, one location, business settings, a tax-class example, a
// starter catalog, a floor plan and an already-open service — without ever
// hand-running SQL. Safe to re-run: it no-ops once an organization exists.
import bcrypt from "bcryptjs";
import { Client } from "pg";

// Dev-only credential, documented in README.md. Never used outside a local
// or CI database; production onboarding (SAAS-01, phase 7) creates its own
// owner account through a real signup flow.
const DEV_PASSWORD = "Kalloud123!";

const DEV_USERS = [
  { email: "owner@kalloud.test", name: "Amine (Owner)", role: "OWNER" },
  { email: "manager@kalloud.test", name: "Sofia (Manager)", role: "MANAGER" },
  { email: "cashier@kalloud.test", name: "Yanis (Cashier)", role: "CASHIER" },
];

// Only "Boissons"/"Plats"/"Desserts" get an explicit tax class; "Chichas"
// intentionally has none so the seed also demonstrates the DEC-05 fallback
// rule (falls back to the location's default_tax_rate).
const CATEGORY_DEFS = [
  { name: "Chichas", taxClass: null },
  { name: "Boissons", taxClass: "food" },
  { name: "Plats", taxClass: "food" },
  { name: "Desserts", taxClass: "food" },
];

const PRODUCT_DEFS = [
  { category: "Chichas", name: "Chicha Signature", price: "25.00", stock: 12, threshold: 4 },
  { category: "Chichas", name: "Chicha Classique", price: "20.00", stock: 8, threshold: 3 },
  { category: "Boissons", name: "Thé à la menthe", price: "4.00", stock: 30, threshold: 8 },
  { category: "Boissons", name: "Mojito passion", price: "8.00", stock: 14, threshold: 5 },
  { category: "Boissons", name: "Café latte", price: "5.00", stock: 18, threshold: 5 },
  { category: "Boissons", name: "Eau minérale", price: "3.00", stock: 24, threshold: 6 },
  { category: "Plats", name: "Brunch Kalloud", price: "19.00", stock: 6, threshold: 2 },
  { category: "Plats", name: "Croque monsieur", price: "9.50", stock: 10, threshold: 3 },
  { category: "Desserts", name: "Tiramisu maison", price: "7.00", stock: 7, threshold: 3 },
];

const TABLE_COUNT = 7;
// DEC-03: direct sale is a null table_id, not a fake "Comptoir" row, so no
// counter table is seeded here (avoids the duplicated concept the audit
// flagged).
const OPENING_CASH = "150.00";

async function alreadySeeded(client) {
  const { rows } = await client.query("SELECT id FROM organizations LIMIT 1");
  return rows.length > 0;
}

async function seed(client) {
  await client.query("BEGIN");
  try {
    const {
      rows: [org],
    } = await client.query("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [
      "Kalloud Démo",
    ]);
    const {
      rows: [location],
    } = await client.query(
      "INSERT INTO locations (organization_id, name) VALUES ($1, $2) RETURNING id",
      [org.id, "Kalloud Lounge"],
    );

    await client.query(
      `INSERT INTO location_settings (location_id, timezone, currency, default_tax_rate, cash_discrepancy_threshold)
       VALUES ($1, 'Europe/Paris', 'EUR', 20.00, 5.00)`,
      [location.id],
    );

    await client.query(
      "INSERT INTO tax_classes (location_id, name, rate, is_default) VALUES ($1, 'Standard', 20.00, true)",
      [location.id],
    );
    const {
      rows: [foodTax],
    } = await client.query(
      "INSERT INTO tax_classes (location_id, name, rate, is_default) VALUES ($1, 'Restauration sur place', 10.00, false) RETURNING id",
      [location.id],
    );

    const categoryIdByName = {};
    for (const def of CATEGORY_DEFS) {
      const taxClassId = def.taxClass === "food" ? foodTax.id : null;
      const {
        rows: [category],
      } = await client.query(
        "INSERT INTO categories (location_id, tax_class_id, name) VALUES ($1, $2, $3) RETURNING id",
        [location.id, taxClassId, def.name],
      );
      categoryIdByName[def.name] = category.id;
    }

    for (const product of PRODUCT_DEFS) {
      await client.query(
        `INSERT INTO products (location_id, category_id, name, price, stock_quantity, alert_threshold)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          location.id,
          categoryIdByName[product.category],
          product.name,
          product.price,
          product.stock,
          product.threshold,
        ],
      );
    }

    for (let index = 1; index <= TABLE_COUNT; index += 1) {
      await client.query("INSERT INTO dining_tables (location_id, name) VALUES ($1, $2)", [
        location.id,
        `Table ${index}`,
      ]);
    }

    const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
    const userIdByRole = {};
    for (const user of DEV_USERS) {
      const {
        rows: [row],
      } = await client.query(
        "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id",
        [user.email, passwordHash, user.name],
      );
      userIdByRole[user.role] = row.id;
      await client.query(
        "INSERT INTO memberships (user_id, organization_id, location_id, role) VALUES ($1, $2, $3, $4)",
        [row.id, org.id, location.id, user.role],
      );
    }

    const {
      rows: [businessDay],
    } = await client.query(
      "INSERT INTO business_days (location_id, opening_cash, status) VALUES ($1, $2, 'OPEN') RETURNING id",
      [location.id, OPENING_CASH],
    );
    await client.query(
      `INSERT INTO cash_movements (location_id, business_day_id, type, amount, reason, created_by)
       VALUES ($1, $2, 'OPENING', $3, 'Fond de caisse initial', $4)`,
      [location.id, businessDay.id, OPENING_CASH, userIdByRole.OWNER],
    );

    await client.query("COMMIT");
    return { organizationId: org.id, locationId: location.id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("[seed] DATABASE_URL is not set.");
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    if (await alreadySeeded(client)) {
      console.log("[seed] Data already present, skipping (safe to re-run).");
      return;
    }

    const { organizationId, locationId } = await seed(client);
    console.log(
      `[seed] Seeded "Kalloud Démo" (organization #${organizationId}, location #${locationId}).`,
    );
    console.log(`[seed] Dev accounts (all use the password: ${DEV_PASSWORD}):`);
    for (const user of DEV_USERS) {
      console.log(`  ${user.role.padEnd(8)} ${user.email}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[seed] Failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
