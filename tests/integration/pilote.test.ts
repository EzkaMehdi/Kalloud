import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
// @ts-expect-error -- plain JS module shared with the CLI scripts, same precedent as tests/unit/backup-retention.test.ts
import { inspectPilotDatabase } from "../../scripts/lib/pilote-core.mjs";
import { createTestTenant, createTestUser } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";

/**
 * OPS-09's acceptance, first half: "données de démo séparées des données
 * pilote".
 *
 * `FND-14` and `OPS-05`'s configuration gate are both *preventive* — they
 * stop the demo tenant being created. Neither answers the question an
 * operator asks before handing an establishment to a real customer: is any
 * of it in here right now? A database restored from a developer's dump
 * passes both guards and is still full of "Kalloud Lounge".
 */

beforeEach(async () => {
  await resetDatabase(pool);
});

describe("pilot readiness (OPS-09)", () => {
  it("declares an empty, migrated database ready", async () => {
    const report = await inspectPilotDatabase(pool);
    expect(report.ready).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.summary.organisations).toBe(0);
  });

  it("declares a database holding only the real customer ready", async () => {
    // A pilot is built by signup plus an import, and nothing else.
    const tenant = await createTestTenant(pool, "Le Comptoir du Port");
    await pool.query("UPDATE users SET email = $1 WHERE id = $2", [
      "patron@comptoirduport.fr",
      (await createTestUser(pool, tenant, "OWNER")).userId,
    ]);
    await pool.query(
      "INSERT INTO products (location_id, name, price) VALUES ($1, 'Café allongé', '2.50')",
      [tenant.locationId],
    );

    const report = await inspectPilotDatabase(pool);
    expect(report.findings).toEqual([]);
    expect(report.ready).toBe(true);
    expect(report.summary.produits).toBe(1);
  });

  it("refuses a database carrying the demo accounts", async () => {
    const tenant = await createTestTenant(pool, "Peu importe");
    const user = await createTestUser(pool, tenant, "OWNER");
    await pool.query("UPDATE users SET email = 'owner@kalloud.test' WHERE id = $1", [user.userId]);

    const report = await inspectPilotDatabase(pool);
    expect(report.ready).toBe(false);
    expect(report.findings[0].what).toContain("démonstration");
  });

  it("refuses a database carrying the demo establishment", async () => {
    await createTestTenant(pool, "Kalloud Lounge");

    const report = await inspectPilotDatabase(pool);
    expect(report.ready).toBe(false);
    expect(report.findings.map((finding: { what: string }) => finding.what).join(" ")).toContain(
      "démonstration",
    );
  });

  it("refuses a database still holding what the test suites leave behind", async () => {
    // Harmless on a developer's machine, never wanted in front of a
    // customer: "Test table 73865b08" on their floor plan would be the
    // first thing they see.
    const tenant = await createTestTenant(pool, "Le Comptoir du Port");
    await pool.query(
      "INSERT INTO dining_tables (location_id, name) VALUES ($1, 'Test table abc')",
      [tenant.locationId],
    );

    const report = await inspectPilotDatabase(pool);
    expect(report.ready).toBe(false);
    expect(report.findings.map((finding: { what: string }) => finding.what).join(" ")).toContain(
      "dining_tables",
    );
  });

  it("counts what the database actually holds, so the operator can recognise it", async () => {
    const tenant = await createTestTenant(pool, "Le Comptoir du Port");
    await createTestUser(pool, tenant, "OWNER");
    await pool.query(
      "INSERT INTO dining_tables (location_id, name) VALUES ($1, 'Terrasse 1'), ($1, 'Terrasse 2')",
      [tenant.locationId],
    );

    const report = await inspectPilotDatabase(pool);
    expect(report.summary).toMatchObject({
      organisations: 1,
      etablissements: 1,
      tables: 2,
      commandes: 0,
    });
  });
});
