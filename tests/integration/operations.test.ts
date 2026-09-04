import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import {
  countClosingsSince,
  listStaleOpenBusinessDays,
  listUnexplainedVariances,
} from "../../lib/repositories/operations";
import { getOperationsReport } from "../../lib/services/operations";
import { createTestTenant, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";

/**
 * OPS-02, database side: the facts an operator needs that no in-process
 * counter can hold — services nobody closed, and closings whose cash gap was
 * never explained.
 */

let tenant: TestTenant;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool);
});

async function openDay(hoursAgo: number): Promise<number> {
  const {
    rows: [day],
  } = await pool.query<{ id: number }>(
    `INSERT INTO business_days (location_id, opened_at, opening_cash)
     VALUES ($1, now() - make_interval(hours => $2), 100.00) RETURNING id`,
    [tenant.locationId, hoursAgo],
  );
  return day.id;
}

async function closeDay(
  dayId: number,
  options: { expected: string; counted: string; reason?: string | null; hoursAgo?: number },
): Promise<void> {
  await pool.query(
    `UPDATE business_days
        SET status = 'CLOSED',
            closed_at = now() - make_interval(hours => $2),
            expected_cash = $3,
            counted_cash = $4,
            variance_reason = $5
      WHERE id = $1`,
    [dayId, options.hoursAgo ?? 1, options.expected, options.counted, options.reason ?? null],
  );
}

describe("operational facts (OPS-02)", () => {
  it("reports a service still open well past a plausible one", async () => {
    await openDay(30);

    const stale = await listStaleOpenBusinessDays(pool, 24);
    expect(stale).toHaveLength(1);
    expect(stale[0].location_id).toBe(tenant.locationId);
    expect(stale[0].hours_open).toBeGreaterThanOrEqual(30);
  });

  it("says nothing about a service that has simply crossed midnight", async () => {
    // DEC-04 is explicit that a session may run past midnight without
    // closing itself; a normal late night must not page anyone.
    await openDay(10);
    expect(await listStaleOpenBusinessDays(pool, 24)).toEqual([]);
  });

  it("ignores a long service that was eventually closed", async () => {
    const day = await openDay(40);
    await closeDay(day, { expected: "150.00", counted: "150.00" });

    expect(await listStaleOpenBusinessDays(pool, 24)).toEqual([]);
  });

  it("reports a variance beyond the establishment's own threshold with no reason", async () => {
    const day = await openDay(30);
    // The seeded default threshold is 5,00 € (migrations/0002).
    await closeDay(day, { expected: "150.00", counted: "120.00" });

    const variances = await listUnexplainedVariances(pool, new Date(Date.now() - 86_400_000));
    expect(variances).toHaveLength(1);
    expect(variances[0].business_day_id).toBe(day);
    expect(Number(variances[0].cash_variance)).toBe(-30);
  });

  it("stays silent on a variance under the threshold", async () => {
    const day = await openDay(30);
    await closeDay(day, { expected: "150.00", counted: "148.00" });

    expect(await listUnexplainedVariances(pool, new Date(Date.now() - 86_400_000))).toEqual([]);
  });

  it("stays silent once the variance carries a reason", async () => {
    const day = await openDay(30);
    await closeDay(day, {
      expected: "150.00",
      counted: "120.00",
      reason: "Erreur de rendu monnaie",
    });

    expect(await listUnexplainedVariances(pool, new Date(Date.now() - 86_400_000))).toEqual([]);
  });

  it("uses each establishment's own threshold, not one number for everyone", async () => {
    const tolerant = await createTestTenant(pool, "Tolerant Org");
    await pool.query(
      "UPDATE location_settings SET cash_discrepancy_threshold = 50.00 WHERE location_id = $1",
      [tolerant.locationId],
    );
    const {
      rows: [day],
    } = await pool.query<{ id: number }>(
      `INSERT INTO business_days (location_id, opened_at, opening_cash)
       VALUES ($1, now() - make_interval(hours => 30), 100.00) RETURNING id`,
      [tolerant.locationId],
    );
    await closeDay(day.id, { expected: "150.00", counted: "120.00" });

    // The same 30 € gap: an alert for an establishment whose threshold is
    // 5 €, normal for one that set 50 €.
    expect(await listUnexplainedVariances(pool, new Date(Date.now() - 86_400_000))).toEqual([]);
  });

  it("forgets a variance once it falls out of the window", async () => {
    const day = await openDay(60);
    await closeDay(day, { expected: "150.00", counted: "120.00", hoursAgo: 48 });

    // An already-handled gap that keeps firing for days is how an alert
    // becomes wallpaper.
    expect(await listUnexplainedVariances(pool, new Date(Date.now() - 86_400_000))).toEqual([]);
  });

  it("states the instant a stale service was opened in a machine-readable form", async () => {
    await openDay(30);

    const report = await getOperationsReport();
    const alert = report.alerts.find((entry) => entry.id.startsWith("business_day_not_closed"));
    expect(alert).toBeDefined();
    // ISO 8601, not a locale-dependent Date.toString(). The first version
    // typed `opened_at` as a string while node-postgres returns a Date, so
    // the payload carried "Wed Sep 02 2026 22:13:24 GMT+0200 (Central
    // European Summer Time)" — unusable by a collector, and different on
    // another machine.
    expect(alert?.observed).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it("counts closings in the window as context", async () => {
    const first = await openDay(30);
    await closeDay(first, { expected: "150.00", counted: "150.00", hoursAgo: 20 });
    const second = await openDay(10);
    await closeDay(second, { expected: "90.00", counted: "90.00", hoursAgo: 2 });
    const old = await openDay(80);
    await closeDay(old, { expected: "10.00", counted: "10.00", hoursAgo: 70 });

    expect(await countClosingsSince(pool, new Date(Date.now() - 86_400_000))).toBe(2);
  });
});
