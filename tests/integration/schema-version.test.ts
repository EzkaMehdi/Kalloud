import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { getSchemaVersionStatus } from "../../lib/schema-version";

/**
 * OPS-05: the readiness check that makes a rollback loud instead of silent.
 *
 * Migrations here are forward-only, so rolling an image back leaves the
 * previous release running against a *newer* schema. That usually appears
 * to work — the old code ignores the new columns — right up to the query
 * that hits a renamed one, mid-service. The two mismatches are reported
 * differently because they are different situations, and an operator woken
 * at 3am should not have to work out which one they are in.
 */

const FUTURE_MIGRATION = "9999_migration_venue_du_futur.sql";
let removed: string | null = null;

beforeEach(() => {
  removed = null;
});

afterEach(async () => {
  await pool.query("DELETE FROM schema_migrations WHERE id = $1", [FUTURE_MIGRATION]);
  if (removed) {
    await pool.query("INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING", [
      removed,
    ]);
  }
});

describe("schema version (OPS-05)", () => {
  it("matches when the database carries exactly this image's migrations", async () => {
    const status = await getSchemaVersionStatus();
    expect(status.matches).toBe(true);
    expect(status.missing).toEqual([]);
    expect(status.unknown).toEqual([]);
    expect(status.applied).toBe(status.expected);
  });

  it("reports a database ahead of the image as a rollback, not as a failed deploy", async () => {
    await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [FUTURE_MIGRATION]);

    const status = await getSchemaVersionStatus();
    expect(status.matches).toBe(false);
    expect(status.unknown).toEqual([FUTURE_MIGRATION]);
    // Not reported as missing: the deploy did not fail, someone rolled back.
    expect(status.missing).toEqual([]);
  });

  it("reports an image ahead of the database as an unfinished deploy", async () => {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
    );
    removed = rows[0].id;
    await pool.query("DELETE FROM schema_migrations WHERE id = $1", [removed]);

    const status = await getSchemaVersionStatus();
    expect(status.matches).toBe(false);
    expect(status.missing).toEqual([removed]);
    expect(status.unknown).toEqual([]);
  });

  it("tells the two apart when both are true at once", async () => {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
    );
    removed = rows[0].id;
    await pool.query("DELETE FROM schema_migrations WHERE id = $1", [removed]);
    await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [FUTURE_MIGRATION]);

    const status = await getSchemaVersionStatus();
    expect(status.missing).toEqual([removed]);
    expect(status.unknown).toEqual([FUTURE_MIGRATION]);
  });
});
