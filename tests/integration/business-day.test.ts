import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { ConflictError } from "../../lib/errors";
import { getActiveBusinessDay } from "../../lib/repositories/business-days";
import { listCashMovements } from "../../lib/repositories/cash-movements";
import { openNewBusinessDay } from "../../lib/services/business-day";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * CASH-01's acceptance criterion — "au plus une journée ouverte par
 * établissement" — was already guaranteed by the DB's partial unique index
 * before this change. What was missing, and what these tests actually
 * prove, is the livrable itself: "première ouverture possible". Before
 * openNewBusinessDay existed, the only entry point into `business_days` was
 * closeAndReopenBusinessDay, which requires an active day to close first —
 * a fresh tenant (every real establishment on day one) had no way to open
 * one through the service/API layer at all. scripts/seed.mjs worked around
 * this with a raw INSERT; a real onboarding flow cannot.
 */

let tenant: TestTenant;
let context: RequestContext;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Cash Tenant");
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

describe("CASH-01: business day model reliability", () => {
  it("opens the very first business day for a brand new establishment (no prior row at all)", async () => {
    expect(await getActiveBusinessDay(pool, tenant.locationId)).toBeNull();

    const opened = await openNewBusinessDay(context, 10_000); // 100.00 €

    expect(opened.status).toBe("OPEN");
    expect(opened.opening_cash).toBe("100.00");

    const active = await getActiveBusinessDay(pool, tenant.locationId);
    expect(active?.id).toBe(opened.id);

    // The opening float is recorded as a real, auditable cash movement, not
    // just a column on business_days — CASH-04's expected-cash formula
    // (fond initial + ventes + entrées - sorties) will need it there.
    const movements = await listCashMovements(pool, tenant.locationId);
    expect(movements).toHaveLength(1);
    expect(movements[0].type).toBe("OPENING");
    expect(movements[0].amount).toBe("100.00");
  });

  it("refuses to open a second business day while one is already active", async () => {
    await openNewBusinessDay(context, 0);

    await expect(openNewBusinessDay(context, 5_000)).rejects.toBeInstanceOf(ConflictError);

    // Refused, not silently ignored: still exactly one OPEN row, and its
    // opening_cash is the first day's, not overwritten by the rejected call.
    const active = await getActiveBusinessDay(pool, tenant.locationId);
    expect(active?.opening_cash).toBe("0.00");
  });

  it("lets two different establishments each open their first day independently", async () => {
    const otherTenant = await createTestTenant(pool, "Other Cash Tenant");

    await openNewBusinessDay(context, 0);
    await openNewBusinessDay({ ...context, locationId: otherTenant.locationId }, 2_500);

    expect((await getActiveBusinessDay(pool, tenant.locationId))?.opening_cash).toBe("0.00");
    expect((await getActiveBusinessDay(pool, otherTenant.locationId))?.opening_cash).toBe("25.00");
  });

  it("resolves a genuine race between two simultaneous first-opens into exactly one winner", async () => {
    // Both calls see no active day at the point they check (the pre-check
    // in openNewBusinessDay cannot observe the other transaction), so this
    // exercises the fallback path: the DB's own unique index decides the
    // winner, and the loser's unique-violation is translated into the same
    // ConflictError rather than surfacing as an opaque 500.
    const outcomes = await Promise.allSettled([
      openNewBusinessDay(context, 1_000),
      openNewBusinessDay(context, 2_000),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);

    // Exactly one OPEN row exists for the location — the DB constraint held
    // regardless of which request "won" the application-level race.
    const active = await getActiveBusinessDay(pool, tenant.locationId);
    expect(active).not.toBeNull();
  });

  /**
   * Regression proof for /api/cash-summary's `businessDayOpen` field
   * (CASH-01): the route is a two-line pass-through of exactly this fact —
   * getActiveBusinessDay returning null vs. a row — so proving the fact
   * here is proving the field. Before this change, a fresh tenant and a
   * tenant with a real, empty open day both produced literally identical
   * `{ balance: "0.00" }` responses; there was no way for a client to tell
   * them apart.
   */
  it("makes 'no business day open' distinguishable from 'a business day is open with zero cash'", async () => {
    expect(await getActiveBusinessDay(pool, tenant.locationId)).toBeNull();

    await openNewBusinessDay(context, 0);

    const active = await getActiveBusinessDay(pool, tenant.locationId);
    expect(active).not.toBeNull();
    expect(active?.opening_cash).toBe("0.00");
  });
});
