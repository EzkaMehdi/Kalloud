import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { lastBackupAgeHours } from "../../lib/observability/backups";
import { createTestTenant, createTestUser } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";

const run = promisify(execFile);

/**
 * OPS-03's acceptance criterion, verbatim: "restauration testée sur un
 * environnement isolé dans les cibles convenues."
 *
 * A backup nobody has restored is a hypothesis. This drill is the whole
 * round trip against a real Postgres — write distinctive data, take a real
 * `pg_dump`, restore it into a database that did not exist a moment ago,
 * and read the data back out — because every part of this chain has a way
 * of failing that only shows up when it is exercised: a missing client
 * binary, an owner that exists on one server and not the other, a dump
 * truncated by a stream that was never awaited.
 *
 * It runs against `kalloud_test`, never the development database, and the
 * drill target is dropped afterwards.
 */

const connectionString = process.env.DATABASE_URL!;
const DRILL_DATABASE = "kalloud_restore_drill_test";

let backupDir: string;
let organizationName: string;

async function script(name: string, args: string[] = []) {
  return run("node", [join(process.cwd(), "scripts", name), ...args], {
    env: { ...process.env, DATABASE_URL: connectionString, BACKUP_DIR: backupDir },
  });
}

async function dropDrillDatabase() {
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${DRILL_DATABASE}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  backupDir = await mkdtemp(join(tmpdir(), "kalloud-backup-"));
}, 60_000);

afterAll(async () => {
  await dropDrillDatabase();
  await rm(backupDir, { recursive: true, force: true });
}, 60_000);

describe("backup and restore drill (OPS-03)", () => {
  it("restores an isolated database that holds exactly what was backed up", async () => {
    await resetDatabase(pool);
    const tenant = await createTestTenant(pool, "Sauvegarde Test");
    const user = await createTestUser(pool, tenant, "OWNER");
    await pool.query(
      `INSERT INTO audit_events (location_id, actor_user_id, action, target_type, target_id)
         VALUES ($1, $2, 'drill.marker', 'location', $3)`,
      [tenant.locationId, user.userId, String(tenant.locationId)],
    );
    const { rows: before } = await pool.query<{ name: string }>(
      "SELECT name FROM organizations WHERE id = $1",
      [tenant.organizationId],
    );
    organizationName = before[0].name;

    const backup = await script("backup.mjs");
    expect(backup.stdout).toContain("pg_dump via");

    const startedAt = Date.now();
    const restore = await script("restore.mjs", ["--into", DRILL_DATABASE]);
    const elapsedMs = Date.now() - startedAt;
    expect(restore.stdout).toContain("Terminé en");

    // Read the restored database directly: the assertion has to be that
    // the *data* came back, not that a command exited zero.
    const drillUrl = new URL(connectionString);
    drillUrl.pathname = `/${DRILL_DATABASE}`;
    const drill = new Client({ connectionString: drillUrl.toString() });
    await drill.connect();
    try {
      const { rows: organizations } = await drill.query<{ name: string }>(
        "SELECT name FROM organizations ORDER BY id",
      );
      expect(organizations.map((row) => row.name)).toContain(organizationName);

      const { rows: users } = await drill.query<{ email: string; password_hash: string }>(
        "SELECT email, password_hash FROM users WHERE email = $1",
        [user.email],
      );
      expect(users).toHaveLength(1);
      // The hash comes back intact: an account restored without its
      // credentials is an establishment that cannot log in on the worst
      // day of its year.
      expect(users[0].password_hash).toMatch(/^\$2[aby]\$/);

      const { rows: audit } = await drill.query<{ action: string }>(
        "SELECT action FROM audit_events WHERE action = 'drill.marker'",
      );
      expect(audit).toHaveLength(1);

      // Constraints and defaults survive, not just rows — a restore that
      // returns data into a schema without its guards is a database that
      // will accept the next invalid write.
      const { rows: constraints } = await drill.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count FROM information_schema.table_constraints
            WHERE table_schema = 'public' AND constraint_type = 'FOREIGN KEY'`,
      );
      expect(Number(constraints[0].count)).toBeGreaterThan(10);

      const { rows: migrations } = await drill.query<{ applied: number }>(
        "SELECT COUNT(*)::INT AS applied FROM schema_migrations",
      );
      expect(migrations[0].applied).toBeGreaterThan(0);
    } finally {
      await drill.end();
    }

    // DEC-10 allows 4 working hours for the whole environment. The
    // database step is the part these scripts own, and it has to leave
    // room for everything else — application, secrets, DNS.
    expect(elapsedMs).toBeLessThan(5 * 60 * 1000);
  }, 120_000);

  it("refuses to restore over the application's own database", async () => {
    const applicationDatabase = new URL(connectionString).pathname.replace(/^\//, "");

    // DEC-10: "jamais directement en production". The guard is in the
    // script rather than only in the runbook, because the mistake it
    // prevents is a forgotten flag at 3am.
    await expect(script("restore.mjs", ["--into", applicationDatabase])).rejects.toMatchObject({
      code: 1,
    });
  }, 60_000);

  it("refuses a dump whose checksum does not match its manifest", async () => {
    const { appendFile, readdir } = await import("node:fs/promises");
    const dump = (await readdir(backupDir)).find((entry) => entry.endsWith(".dump"))!;
    await appendFile(join(backupDir, dump), "corruption");

    // Checked *before* the target is dropped: discovering a bad dump after
    // emptying the destination leaves nothing at all.
    await expect(script("restore.mjs", ["--into", DRILL_DATABASE])).rejects.toMatchObject({
      code: 1,
    });

    const drillUrl = new URL(connectionString);
    drillUrl.pathname = `/${DRILL_DATABASE}`;
    const drill = new Client({ connectionString: drillUrl.toString() });
    await drill.connect();
    try {
      const { rows } = await drill.query("SELECT COUNT(*)::INT AS count FROM organizations");
      expect(rows[0].count).toBeGreaterThan(0);
    } finally {
      await drill.end();
    }
  }, 60_000);

  it("reports the age of the newest backup from its manifest", async () => {
    const age = await lastBackupAgeHours(backupDir);
    expect(age).not.toBeNull();
    expect(age).toBeLessThan(1);
  });

  it("reports no backup at all when the directory is empty or absent", async () => {
    expect(await lastBackupAgeHours(join(tmpdir(), "kalloud-backup-does-not-exist"))).toBeNull();
  });
});
