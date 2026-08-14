import { pool } from "../db";
import { getExpectedCash } from "../repositories/cash-movements";
import { getLocationSettings } from "../repositories/settings";
import { zonedTime, zonedToday } from "../time";
import {
  getActiveBusinessDay,
  getBusinessDaySummary,
  getRevenueBetween,
} from "../repositories/business-days";

export type DashboardPeriod = "day" | "month" | "year";

export interface DashboardQuery {
  period: DashboardPeriod;
  year?: number;
  month?: number;
}

export interface DashboardSummary {
  revenue: string;
  cash_revenue: string;
  card_revenue: string;
  orders_count: number;
  average_basket: string;
  /**
   * CASH-04: expected cash in the drawer, from the one shared formula.
   *
   * `null` outside `period=day`, and that is the honest answer rather than a
   * missing field: expected cash is a property of a cash session (DEC-04),
   * not of a calendar month. Summing drawers across a month would produce a
   * number that looks meaningful and reconciles against nothing.
   */
  expected_cash: string | null;
}

const EMPTY_SUMMARY: DashboardSummary = {
  revenue: "0.00",
  cash_revenue: "0.00",
  card_revenue: "0.00",
  orders_count: 0,
  average_basket: "0.00",
  expected_cash: null,
};

/**
 * CFG-01/GATE-4B: period boundaries are computed in the establishment's own
 * timezone (`location_settings.timezone`), not the server's.
 *
 * This used to build `new Date(year, month - 1, 1)` — midnight where the
 * server happens to be. On a UTC host serving a Paris restaurant, every
 * month began two hours late, silently moving a late-evening sale into the
 * following month's figures. "Fuseau réellement appliqué" is a GATE-4B
 * criterion, so it is applied here rather than deferred.
 *
 * What remains for BI-03 (phase 6) is the harder question the comment this
 * replaces was really about: whether "aujourd'hui" should mean the calendar
 * day or the service, for an establishment that closes after midnight.
 * `period=day` still answers with the open business day, which is the
 * honest reading of "service en cours".
 */
export async function getDashboardSummary(
  locationId: number,
  query: DashboardQuery,
): Promise<DashboardSummary> {
  if (query.period === "day") {
    const activeDay = await getActiveBusinessDay(pool, locationId);
    if (activeDay) {
      const [summary, expectedCash] = await Promise.all([
        getBusinessDaySummary(pool, locationId, activeDay.id),
        getExpectedCash(pool, locationId, activeDay.id),
      ]);
      return { ...summary, expected_cash: expectedCash.expected };
    }
    return EMPTY_SUMMARY;
  }

  const settings = await getLocationSettings(pool, locationId);
  const timeZone = settings?.timezone ?? "Europe/Paris";
  const today = zonedToday(timeZone);
  const year = query.year ?? today.year;
  const month = query.month ?? today.month;

  const from =
    query.period === "year" ? zonedTime(timeZone, year, 1, 1) : zonedTime(timeZone, year, month, 1);
  const to =
    query.period === "year"
      ? zonedTime(timeZone, year + 1, 1, 1)
      : month === 12
        ? zonedTime(timeZone, year + 1, 1, 1)
        : zonedTime(timeZone, year, month + 1, 1);

  return { ...(await getRevenueBetween(pool, locationId, from, to)), expected_cash: null };
}
