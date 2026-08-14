import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import {
  createCashMovement,
  listCashMovements,
  OPENING_FLOAT_CATEGORY,
} from "../../lib/repositories/cash-movements";
import { openNewBusinessDay } from "../../lib/services/business-day";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * CASH-03/DEC-11. Most of this ticket's livrable was already true before it
 * (a positive amount, a motive, an author, an establishment, an audit entry,
 * and idempotency against a double-recorded withdrawal): what was missing
 * was the category, and specifically a category CASH-04 can rely on to tell
 * an end-of-service withdrawal apart from any other outflow.
 *
 * The pairing rules themselves are proven at the schema tier
 * (tests/unit/validation.test.ts) and in the database
 * (tests/integration/migrations-legacy-data.test.ts). What is proven here is
 * that the category survives the whole write path, and that the two
 * acceptance clauses which are not about validation — "immuable" and
 * "auditable" — actually hold.
 */

let tenant: TestTenant;
let context: RequestContext;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Cash Movement Tenant");
  const owner = await createTestUser(pool, tenant, "OWNER");
  context = {
    userId: owner.userId,
    userEmail: owner.email,
    userName: "Owner",
    organizationId: tenant.organizationId,
    locationId: tenant.locationId,
    role: "OWNER",
    sessionId: 1,
  };
});

describe("CASH-03: cash movements carry a category", () => {
  it("records the opening float under the one category a client cannot send", async () => {
    const day = await openNewBusinessDay(context, 15_000);

    const [movement] = await listCashMovements(pool, tenant.locationId);
    expect(movement.business_day_id).toBe(day.id);
    expect(movement.type).toBe("OPENING");
    expect(movement.category).toBe(OPENING_FLOAT_CATEGORY);
    // The author and the establishment were already part of the row; the
    // ticket's livrable lists them, so they are asserted rather than assumed.
    expect(movement.created_by).toBe(context.userId);
    expect(movement.location_id).toBe(tenant.locationId);
  });

  it("keeps an end-of-service withdrawal distinguishable from any other outflow", async () => {
    const day = await openNewBusinessDay(context, 15_000);

    await createCashMovement(pool, tenant.locationId, {
      businessDayId: day.id,
      type: "OUT",
      category: "PURCHASE",
      amount: "200.00",
      reason: "Consommables",
      createdBy: context.userId,
    });
    await createCashMovement(pool, tenant.locationId, {
      businessDayId: day.id,
      type: "OUT",
      category: "END_OF_SERVICE_WITHDRAWAL",
      amount: "200.00",
      reason: "Retrait du tiroir",
      createdBy: context.userId,
    });

    // Same sign, same amount, same day: before DEC-11 these two rows were
    // indistinguishable, which is precisely what stops CASH-04 from
    // excluding withdrawals without double-counting them.
    const { rows } = await pool.query<{ category: string; total: string }>(
      `SELECT category, SUM(amount)::TEXT AS total FROM cash_movements
        WHERE location_id = $1 AND type = 'OUT' GROUP BY category ORDER BY category`,
      [tenant.locationId],
    );
    expect(rows).toEqual([
      { category: "END_OF_SERVICE_WITHDRAWAL", total: "200.00" },
      { category: "PURCHASE", total: "200.00" },
    ]);
  });

  it("refuses a category that contradicts the direction, even from the repository", async () => {
    const day = await openNewBusinessDay(context, 0);

    // The repository is below zod: a service calling it directly must still
    // not be able to write an inflow labelled as a withdrawal.
    await expect(
      createCashMovement(pool, tenant.locationId, {
        businessDayId: day.id,
        type: "IN",
        category: "END_OF_SERVICE_WITHDRAWAL",
        amount: "10.00",
        reason: "Incohérent",
        createdBy: context.userId,
      }),
    ).rejects.toThrow(/cash_movements_category_check/);
  });

  /**
   * "Mouvement immuable" (acceptance). There is no update or delete path,
   * and that is a property of the code's surface rather than of any single
   * run — so it is checked the way tests/unit/architecture.test.ts checks
   * this codebase's other structural rules, by reading the module.
   */
  it("exposes no way to modify or delete a recorded movement", () => {
    const source = readFileSync(
      path.join(process.cwd(), "lib/repositories/cash-movements.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/UPDATE\s+cash_movements/i);
    expect(source).not.toMatch(/DELETE\s+FROM\s+cash_movements/i);
  });
});
