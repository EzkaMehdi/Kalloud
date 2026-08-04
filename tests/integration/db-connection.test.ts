import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Minimal example proving the integration test tier (`FND-04`) can reach a
 * real PostgreSQL instance, mutate it, and reset the slice of state it
 * touched. Richer integration tests (migrations, repositories, route
 * handlers) are added alongside `FND-05`/`FND-06` once the real schema and
 * a dedicated `kalloud_test` database exist; this test intentionally stays
 * schema-agnostic so it keeps working through that migration.
 */
const connectionString =
  process.env.DATABASE_URL_TEST ??
  process.env.DATABASE_URL ??
  "postgresql://kalloud:kalloud_dev_password@localhost:5433/kalloud";

const tableName = `_vitest_smoke_${randomUUID().replace(/-/g, "")}`;
let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString });
  await pool.query(`CREATE TABLE ${tableName} (id SERIAL PRIMARY KEY, label TEXT NOT NULL)`);
});

afterAll(async () => {
  await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
  await pool.end();
});

describe("PostgreSQL integration harness", () => {
  it("round-trips a row through a real database", async () => {
    await pool.query(`INSERT INTO ${tableName} (label) VALUES ($1)`, ["hello-from-vitest"]);
    const { rows } = await pool.query(`SELECT label FROM ${tableName} ORDER BY id`);
    expect(rows).toEqual([{ label: "hello-from-vitest" }]);
  });

  it("can reset its own state between runs", async () => {
    await pool.query(`TRUNCATE TABLE ${tableName}`);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM ${tableName}`);
    expect(rows[0].count).toBe(0);
  });
});
