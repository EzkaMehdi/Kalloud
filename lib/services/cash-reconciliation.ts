import { pool } from "../db";
import { getActiveBusinessDay, getLastClosedBusinessDay } from "../repositories/business-days";
import { getExpectedCash } from "../repositories/cash-movements";
import { getLocationSettings } from "../repositories/settings";

/**
 * BI-09: "fond, ventes espèces, entrées, sorties, attendu, compté et
 * écart" — the acceptance is explicit that this block must show "valeurs
 * identiques au détail de clôture" (`CASH-05`'s own closing modal), so it
 * is built on the one formula that already produces that detail
 * (`getExpectedCash`, `CASH-04`) rather than a second one that could
 * drift. The whole reason `getExpectedCash` returns the four terms and
 * not just their sum (`CASH-04`'s own note: "un total seul ne s'explique
 * pas à un caissier qui le conteste") is exactly what this block needed.
 */

export interface CashReconciliation {
  /**
   * `"open"`: the live figures for the session in progress — identical to
   * what `CASH-05`'s closing modal would show if opened right now.
   * `"closed"`: the last service's own frozen reconciliation, exactly as
   * signed off at close — `expected`/`counted`/`variance` are read back
   * from `business_days`, never recomputed, so they always agree with
   * each other the way they did at that moment. `"never_opened"`: no
   * service has ever been opened for this establishment.
   */
  status: "open" | "closed" | "never_opened";
  openingCash: string;
  cashSales: string;
  cashIn: string;
  cashOut: string;
  expected: string;
  /** `null` while open (nothing counted yet) or if no service was ever closed. */
  counted: string | null;
  /** `null` under the same conditions as `counted`. */
  variance: string | null;
  varianceReason: string | null;
  closedAt: string | null;
  timezone: string;
  computedAt: string;
}

const ZERO_BREAKDOWN = {
  openingCash: "0.00",
  cashSales: "0.00",
  cashIn: "0.00",
  cashOut: "0.00",
  expected: "0.00",
};

export async function getCashReconciliation(locationId: number): Promise<CashReconciliation> {
  const settings = await getLocationSettings(pool, locationId);
  const timezone = settings.timezone;
  const computedAt = new Date().toISOString();

  const activeDay = await getActiveBusinessDay(pool, locationId);
  if (activeDay) {
    const expected = await getExpectedCash(pool, locationId, activeDay.id);
    return {
      status: "open",
      openingCash: expected.opening_cash,
      cashSales: expected.cash_sales,
      cashIn: expected.cash_in,
      cashOut: expected.cash_out,
      expected: expected.expected,
      counted: null,
      variance: null,
      varianceReason: null,
      closedAt: null,
      timezone,
      computedAt,
    };
  }

  const lastClosed = await getLastClosedBusinessDay(pool, locationId);
  if (!lastClosed) {
    return {
      status: "never_opened",
      ...ZERO_BREAKDOWN,
      counted: null,
      variance: null,
      varianceReason: null,
      closedAt: null,
      timezone,
      computedAt,
    };
  }

  // The breakdown (opening/cashSales/cashIn/cashOut) is read live from the
  // same ledger `getExpectedCash` always reads — under normal operation it
  // sums to exactly `lastClosed.expected_cash`, because nothing in the
  // ledger changes after a close. `expected`/`counted`/`variance` below are
  // deliberately the *frozen* columns, not this live recomputation: they
  // are what was actually reconciled at close time, and a later cash
  // refund against one of that service's orders (DEC-05/ORD-10 allow a
  // refund at any time) would move the live `cashSales` without making the
  // signed-off `variance` wrong — it would just no longer be the same
  // question. Freezing `expected`/`counted`/`variance` keeps that
  // reconciliation internally consistent (`variance` really does equal
  // `counted - expected`, both exactly as recorded) instead of silently
  // rewriting a settled figure.
  const expected = await getExpectedCash(pool, locationId, lastClosed.id);
  return {
    status: "closed",
    openingCash: expected.opening_cash,
    cashSales: expected.cash_sales,
    cashIn: expected.cash_in,
    cashOut: expected.cash_out,
    expected: lastClosed.expected_cash ?? expected.expected,
    counted: lastClosed.counted_cash,
    variance: lastClosed.cash_variance,
    varianceReason: lastClosed.variance_reason,
    closedAt: lastClosed.closed_at,
    timezone,
    computedAt,
  };
}
