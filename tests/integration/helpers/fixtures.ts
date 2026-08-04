import type { Pool } from "pg";
import { hashPassword } from "../../../lib/auth/password";
import type { Role } from "../../../lib/authz";

export interface TestTenant {
  organizationId: number;
  locationId: number;
}

/** Creates a minimal but complete tenant (org + location + settings) for integration tests. */
export async function createTestTenant(pool: Pool, name = "Test Org"): Promise<TestTenant> {
  const {
    rows: [org],
  } = await pool.query<{ id: number }>(
    "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
    [name],
  );
  const {
    rows: [location],
  } = await pool.query<{ id: number }>(
    "INSERT INTO locations (organization_id, name) VALUES ($1, $2) RETURNING id",
    [org.id, `${name} - Location`],
  );
  await pool.query("INSERT INTO location_settings (location_id) VALUES ($1)", [location.id]);
  return { organizationId: org.id, locationId: location.id };
}

export interface TestUser {
  userId: number;
  email: string;
  password: string;
}

let sequence = 0;

/** Creates a user with an active membership on `tenant` holding `role`, returning the plaintext password used. */
export async function createTestUser(
  pool: Pool,
  tenant: TestTenant,
  role: Role,
  overrides: { email?: string; password?: string } = {},
): Promise<TestUser> {
  sequence += 1;
  const email =
    overrides.email ?? `${role.toLowerCase()}-${tenant.organizationId}-${sequence}@example.test`;
  const password = overrides.password ?? "Password123!";
  const passwordHash = await hashPassword(password);
  const {
    rows: [user],
  } = await pool.query<{ id: number }>(
    "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id",
    [email, passwordHash, `${role} Test User`],
  );
  await pool.query(
    "INSERT INTO memberships (user_id, organization_id, location_id, role) VALUES ($1, $2, $3, $4)",
    [user.id, tenant.organizationId, tenant.locationId, role],
  );
  return { userId: user.id, email, password };
}
