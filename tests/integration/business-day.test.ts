import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { ConflictError, ValidationError } from "../../lib/errors";
import { getActiveBusinessDay, getLastNextOpeningCash } from "../../lib/repositories/business-days";
import { listCashMovements } from "../../lib/repositories/cash-movements";
import { closeCurrentBusinessDay, openNewBusinessDay } from "../../lib/services/business-day";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * CASH-01's acceptance criterion — "au plus une journée ouverte par
 * établissement" — was already guaranteed by the DB's partial unique index
 * before this change. What was missing, and what these tests actually
 * prove, is the livrable itself: "première ouverture possible". Before
 * openNewBusinessDay existed, the only entry point into `business_days` was
 * the close call, which back then also reopened and which requires an active
 * day to close first — a fresh tenant (every real establishment on day one)
 * had no way to open one through the service/API layer at all.
 * scripts/seed.mjs worked around this with a raw INSERT; a real onboarding
 * flow cannot.
 *
 * The CASH-02 block below covers the other half: closing now closes and
 * nothing else.
 */

let tenant: TestTenant;
let context: RequestContext;

/**
 * CASH-05 made the count part of closing. These CASH-02 tests are about what
 * closing does *not* do, so they always count exactly what is expected: a
 * variance would drag the threshold rule into assertions that are not about
 * it.
 */
const countingExactly = (cents: number) => ({
  countedCashCents: cents,
  nextOpeningCashCents: null,
  varianceReason: null,
});

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

/**
 * CASH-02's acceptance criterion is a negative one — "aucune nouvelle
 * journée ouverte implicitement sans choix" — so the assertions that matter
 * are about what does *not* happen. The previous implementation
 * (closeAndReopenBusinessDay) closed the day and opened the next one in the
 * same transaction, with the next service's opening float typed into the
 * closing dialog; there was no way to simply close a till.
 */
describe("CASH-02: closing a service opens nothing", () => {
  it("leaves the establishment with no open business day at all", async () => {
    const opened = await openNewBusinessDay(context, 15_000); // 150.00 €

    const { closed } = await closeCurrentBusinessDay(context, countingExactly(15_000));

    expect(closed.id).toBe(opened.id);
    expect(closed.status).toBe("CLOSED");
    // The heart of the ticket: previously this was a brand new OPEN row.
    expect(await getActiveBusinessDay(pool, tenant.locationId)).toBeNull();
  });

  it("records no opening float for a service nobody asked to open", async () => {
    await openNewBusinessDay(context, 15_000);
    await closeCurrentBusinessDay(context, countingExactly(15_000));

    // Exactly one OPENING movement: the one from the open above. The old
    // close inserted a second one ("Fond de caisse — nouvelle journée") for
    // the service it silently started, which is money appearing in the
    // journal without anyone having decided to put it there.
    const openings = (await listCashMovements(pool, tenant.locationId)).filter(
      (movement) => movement.type === "OPENING",
    );
    expect(openings).toHaveLength(1);
    expect(openings[0].amount).toBe("150.00");
  });

  it("closes on opening float + cash revenue, and audits it as a close", async () => {
    await openNewBusinessDay(context, 15_000);

    const { closed } = await closeCurrentBusinessDay(context, countingExactly(15_000));

    // No sales in this test, so the expected close is the float itself.
    expect(closed.expected_cash).toBe("150.00");

    const { rows } = await pool.query<{ action: string; target_id: string }>(
      "SELECT action, target_id FROM audit_events WHERE location_id = $1 ORDER BY id DESC LIMIT 1",
      [tenant.locationId],
    );
    // Renamed from `business_day.close_and_reopen`: the audit trail should
    // describe one act, because only one act happened.
    expect(rows[0].action).toBe("business_day.close");
    // `target_id` is a BIGINT, which pg hands back as a string.
    expect(Number(rows[0].target_id)).toBe(closed.id);
  });

  it("refuses to close when no service is open", async () => {
    await expect(closeCurrentBusinessDay(context, countingExactly(15_000))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("lets a new service be opened after a close — as a separate, deliberate call", async () => {
    const first = await openNewBusinessDay(context, 15_000);
    await closeCurrentBusinessDay(context, countingExactly(15_000));

    const second = await openNewBusinessDay(context, 5_000);

    expect(second.id).not.toBe(first.id);
    expect(second.opening_cash).toBe("50.00");
    expect((await getActiveBusinessDay(pool, tenant.locationId))?.id).toBe(second.id);
  });

  it("keeps a closed day closed: closing twice is refused, not repeated", async () => {
    await openNewBusinessDay(context, 15_000);
    await closeCurrentBusinessDay(context, countingExactly(15_000));

    // DEC-04: a closed day is final and there is no reopen path, so the
    // second attempt has nothing to act on. (Two *concurrent* closes racing
    // each other are CASH-06's problem, not this one.)
    await expect(closeCurrentBusinessDay(context, countingExactly(15_000))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

/**
 * CASH-05/DEC-04. The count is what turns a close from "freeze a calculated
 * figure" into a reconciliation: someone states what is physically in the
 * drawer, the difference is recorded, and beyond the establishment's
 * threshold it has to be explained.
 *
 * The default `cash_discrepancy_threshold` is 5,00 € (CFG-00), which is what
 * the amounts below are chosen around.
 */
describe("CASH-05: counting the drawer and explaining the variance", () => {
  it("stores the count, the variance, the reason, the next float, the author and the time", async () => {
    await openNewBusinessDay(context, 15_000); // attendu : 150,00 €

    const { closed } = await closeCurrentBusinessDay(context, {
      countedCashCents: 14_200, // 8,00 € de moins
      nextOpeningCashCents: 10_000,
      varianceReason: "Erreur de rendu de monnaie",
    });

    expect(closed.expected_cash).toBe("150.00");
    expect(closed.counted_cash).toBe("142.00");
    // Generated by the database from the two amounts above, never written by
    // the application — so it cannot drift from its own inputs.
    expect(closed.cash_variance).toBe("-8.00");
    expect(closed.variance_reason).toBe("Erreur de rendu de monnaie");
    expect(closed.next_opening_cash).toBe("100.00");
    // "Auteur et horodatage conservés" (acceptance).
    expect(closed.closed_by).toBe(context.userId);
    expect(closed.closed_at).not.toBeNull();
  });

  it("refuses a variance beyond the threshold when no reason is given", async () => {
    await openNewBusinessDay(context, 15_000);

    await expect(
      closeCurrentBusinessDay(context, {
        countedCashCents: 14_000, // 10,00 € d'écart, seuil 5,00 €
        nextOpeningCashCents: null,
        varianceReason: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Refused, not partially applied: the service is still open.
    expect(await getActiveBusinessDay(pool, tenant.locationId)).not.toBeNull();
  });

  it("treats a surplus exactly like a shortfall", async () => {
    await openNewBusinessDay(context, 15_000);

    // 20,00 € de trop. Instinct says only a shortfall is suspicious; a
    // drawer that is over is just as much an anomaly, and DEC-05 does not
    // distinguish them.
    await expect(
      closeCurrentBusinessDay(context, {
        countedCashCents: 17_000,
        nextOpeningCashCents: null,
        varianceReason: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const { closed } = await closeCurrentBusinessDay(context, {
      countedCashCents: 17_000,
      nextOpeningCashCents: null,
      varianceReason: "Caisse trouvée excédentaire, à investiguer",
    });
    expect(closed.cash_variance).toBe("20.00");
  });

  it("asks for nothing when the variance stays within the threshold", async () => {
    await openNewBusinessDay(context, 15_000);

    // 3,00 € d'écart, sous le seuil de 5,00 €.
    const { closed } = await closeCurrentBusinessDay(context, {
      countedCashCents: 14_700,
      nextOpeningCashCents: null,
      varianceReason: null,
    });

    expect(closed.cash_variance).toBe("-3.00");
    expect(closed.variance_reason).toBeNull();
  });

  it("offers the float the last close left, for the next opening", async () => {
    await openNewBusinessDay(context, 15_000);
    await closeCurrentBusinessDay(context, {
      countedCashCents: 15_000,
      nextOpeningCashCents: 8_000,
      varianceReason: null,
    });

    // Recorded only (DEC-04): nothing was opened by stating it.
    expect(await getActiveBusinessDay(pool, tenant.locationId)).toBeNull();
    expect(await getLastNextOpeningCash(pool, tenant.locationId)).toBe("80.00");
  });

  it("has nothing to offer when the last close stated no float", async () => {
    expect(await getLastNextOpeningCash(pool, tenant.locationId)).toBeNull();

    await openNewBusinessDay(context, 15_000);
    await closeCurrentBusinessDay(context, countingExactly(15_000));

    // A close that named no next float proposes none, rather than quoting
    // the counted amount as if it had been decided.
    expect(await getLastNextOpeningCash(pool, tenant.locationId)).toBeNull();
  });
});
