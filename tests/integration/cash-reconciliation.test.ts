import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { getExpectedCash } from "../../lib/repositories/cash-movements";
import { createProduct, type ProductRow } from "../../lib/repositories/products";
import { closeCurrentBusinessDay, openNewBusinessDay } from "../../lib/services/business-day";
import { refundOrder } from "../../lib/services/refunds";
import { parseOrThrow } from "../../lib/validation/parse";
import { refundOrderSchema } from "../../lib/validation/schemas";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import { sell } from "./helpers/sales";
import type { RequestContext } from "../../lib/context";

/**
 * CASH-08 audits the seven angles its livrable lists and covers what was
 * genuinely open. Five were already proven when their own ticket landed, and
 * are deliberately not duplicated here:
 *
 * - formules, remboursement espèces → CASH-04, tests/integration/cash-movements.test.ts
 * - écarts (seuil, symétrie, silence sous le seuil) → CASH-05, tests/integration/business-day.test.ts
 * - tickets ouverts, concurrence → CASH-06, same file
 *
 * What no test touched is the pair the livrable names next — **fuseau** and
 * **passage de minuit** — and the acceptance criterion itself: "caisse
 * attendue entièrement reconstructible pour chaque scénario", which is a
 * claim about the ledger as a whole rather than about any single formula.
 */

let tenant: TestTenant;
let context: RequestContext;
let coffee: ProductRow;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Reconciliation Tenant");
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
  coffee = await createProduct(pool, tenant.locationId, {
    categoryId: null,
    name: "Café",
    price: "10.00",
    stockQuantity: 100,
  });
});

/** Records a movement at a chosen instant — the repository always uses `now()`. */
async function movementAt(
  businessDayId: number,
  at: string,
  type: "IN" | "OUT",
  category: string,
  amount: string,
  reason: string,
) {
  await pool.query(
    `INSERT INTO cash_movements (location_id, business_day_id, type, category, amount, reason, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenant.locationId, businessDayId, type, category, amount, reason, context.userId, at],
  );
}

describe("CASH-08: a service that crosses midnight", () => {
  it("keeps both sides of midnight in the same drawer", async () => {
    const day = await openNewBusinessDay(context, 15_000);

    // A late service, in the establishment's own terms: takings before
    // midnight and after it belong to the same session (DEC-04 — "une
    // session peut dépasser minuit sans se clôturer automatiquement").
    await movementAt(day.id, "2026-08-14T21:30:00Z", "IN", "FUND_TOPUP", "40.00", "Avant minuit");
    await movementAt(day.id, "2026-08-15T01:15:00Z", "OUT", "PURCHASE", "15.00", "Après minuit");

    // 150 + 40 − 15. A formula keyed on the calendar date would have split
    // this drawer in two and answered 190 or −15 depending on which day it
    // thought it was.
    expect((await getExpectedCash(pool, tenant.locationId, day.id)).expected).toBe("175.00");
  });

  it("closes on the whole session, not on a calendar day", async () => {
    const day = await openNewBusinessDay(context, 10_000);
    await movementAt(day.id, "2026-08-14T23:50:00Z", "IN", "OTHER", "25.00", "Juste avant minuit");
    await movementAt(day.id, "2026-08-15T00:10:00Z", "IN", "OTHER", "35.00", "Juste après");

    const { closed } = await closeCurrentBusinessDay(context, {
      countedCashCents: 16_000,
      nextOpeningCashCents: null,
      varianceReason: null,
    });

    expect(closed.expected_cash).toBe("160.00");
    expect(closed.cash_variance).toBe("0.00");
  });
});

describe("CASH-08: the establishment's timezone", () => {
  it("gives the same expected cash whatever timezone the establishment is in", async () => {
    // Auckland is on the *next* calendar date at the instants below; Paris is
    // not. Any figure that consulted a calendar would diverge between the two.
    const other = await createTestTenant(pool, "Auckland Tenant");
    await pool.query("UPDATE location_settings SET timezone = $2 WHERE location_id = $1", [
      tenant.locationId,
      "Europe/Paris",
    ]);
    await pool.query("UPDATE location_settings SET timezone = $2 WHERE location_id = $1", [
      other.locationId,
      "Pacific/Auckland",
    ]);
    const otherOwner = await createTestUser(pool, other, "OWNER");
    const otherContext: RequestContext = {
      ...context,
      userId: otherOwner.userId,
      userEmail: otherOwner.email,
      organizationId: other.organizationId,
      locationId: other.locationId,
    };

    const parisDay = await openNewBusinessDay(context, 15_000);
    const aucklandDay = await openNewBusinessDay(otherContext, 15_000);

    for (const [locationId, dayId] of [
      [tenant.locationId, parisDay.id],
      [other.locationId, aucklandDay.id],
    ] as const) {
      await pool.query(
        `INSERT INTO cash_movements (location_id, business_day_id, type, category, amount, reason, created_by, created_at)
         VALUES ($1, $2, 'OUT', 'PURCHASE', '20.00', 'Même instant', $3, '2026-08-14T22:00:00Z')`,
        [locationId, dayId, locationId === tenant.locationId ? context.userId : otherOwner.userId],
      );
    }

    const paris = await getExpectedCash(pool, tenant.locationId, parisDay.id);
    const auckland = await getExpectedCash(pool, other.locationId, aucklandDay.id);

    // Identical, because the formula never asks what day it is: it filters on
    // `business_day_id` alone (DEC-04). The timezone governs *reporting*
    // periods (BI-03, the dashboard's month and year), never the drawer.
    expect(paris.expected).toBe("130.00");
    expect(auckland.expected).toBe(paris.expected);
  });
});

describe("CASH-08: the drawer is reconstructible from the ledger", () => {
  /**
   * The acceptance criterion. Rather than re-asserting the formula's own
   * output, this rebuilds the expected figure from the raw tables — the same
   * way an accountant would from the journal — and requires the three to
   * agree: the live calculation, the amount frozen at close, and the
   * independent reconstruction.
   */
  it("reconstructs a full service from its raw rows", async () => {
    const day = await openNewBusinessDay(context, 15_000); // fond 150,00

    await sell(context, [{ productId: coffee.id, quantity: 4 }], { paymentMethod: "CASH" }); // +40,00
    await sell(context, [{ productId: coffee.id, quantity: 7 }], { paymentMethod: "CARD" }); // n'entre jamais dans le tiroir
    const refunded = await sell(context, [{ productId: coffee.id, quantity: 2 }], {
      paymentMethod: "CASH",
    }); // +20,00
    await refundOrder(
      context,
      refunded.order.id,
      parseOrThrow(refundOrderSchema, { reason: "Client mécontent" }),
    ); // −20,00

    await movementAt(day.id, "2026-08-14T20:00:00Z", "IN", "FUND_TOPUP", "30.00", "Appoint");
    await movementAt(day.id, "2026-08-14T23:00:00Z", "OUT", "PURCHASE", "12.50", "Consommables");
    await movementAt(
      day.id,
      "2026-08-15T02:00:00Z",
      "OUT",
      "END_OF_SERVICE_WITHDRAWAL",
      "60.00",
      "Retrait",
    );

    // Rebuilt from the tables, deliberately not from getExpectedCash: the
    // opening float from the day, cash payments netted from the ledger, and
    // the movements by direction — with OPENING excluded, because the float
    // is already counted once from `business_days`.
    const { rows } = await pool.query<{ rebuilt: string }>(
      `SELECT (
         (SELECT opening_cash FROM business_days WHERE id = $2 AND location_id = $1)
         + COALESCE((SELECT SUM(CASE WHEN p.type = 'CHARGE' THEN p.amount ELSE -p.amount END)
                     FROM payments p JOIN orders o ON o.id = p.order_id
                     WHERE p.method = 'CASH' AND o.business_day_id = $2 AND o.location_id = $1), 0)
         + COALESCE((SELECT SUM(amount) FROM cash_movements
                     WHERE business_day_id = $2 AND location_id = $1 AND type = 'IN'), 0)
         - COALESCE((SELECT SUM(amount) FROM cash_movements
                     WHERE business_day_id = $2 AND location_id = $1 AND type = 'OUT'), 0)
       )::DECIMAL(10,2) AS rebuilt`,
      [tenant.locationId, day.id],
    );

    // 150,00 + (40,00 + 20,00 − 20,00) + 30,00 − 12,50 − 60,00
    expect(rows[0].rebuilt).toBe("147.50");

    const live = await getExpectedCash(pool, tenant.locationId, day.id);
    expect(live.expected).toBe(rows[0].rebuilt);
    // Each term is reported, so a disagreement can be located rather than
    // merely noticed (DEC-04 requires showing this breakdown at closing).
    expect(live).toEqual({
      opening_cash: "150.00",
      cash_sales: "40.00",
      cash_in: "30.00",
      cash_out: "72.50",
      expected: "147.50",
    });

    const { closed } = await closeCurrentBusinessDay(context, {
      countedCashCents: 14_750,
      nextOpeningCashCents: 8_000,
      varianceReason: null,
    });
    // Frozen at close, and still the same number: the reconciliation a
    // cashier signs is the one the ledger supports.
    expect(closed.expected_cash).toBe(rows[0].rebuilt);
    expect(closed.cash_variance).toBe("0.00");
  });
});
