import type { Pool } from "pg";

/**
 * Tables in an order that satisfies FK dependencies for TRUNCATE ... CASCADE
 * (CASCADE would technically make the order not matter, but keeping it
 * dependency-ordered makes failures easier to reason about). Used by
 * integration tests to reset the whole business schema between cases
 * without paying for a full migration re-run (FND-05 acceptance: "les tests
 * peuvent réinitialiser leur base").
 */
const TABLES_IN_SAFE_TRUNCATE_ORDER = [
  "audit_events",
  "login_attempts",
  "password_reset_tokens",
  "sessions",
  "order_items",
  "orders",
  "cash_movements",
  "business_days",
  "dining_tables",
  "products",
  "categories",
  "tax_classes",
  "location_settings",
  "memberships",
  "locations",
  "users",
  "organizations",
] as const;

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE ${TABLES_IN_SAFE_TRUNCATE_ORDER.join(", ")} RESTART IDENTITY CASCADE`,
  );
}
