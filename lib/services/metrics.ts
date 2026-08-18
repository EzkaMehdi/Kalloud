import { pool } from "../db";
import {
  getActiveBusinessDay,
  getBusinessDaySummary,
  getLastClosedBusinessDay,
  getRevenueBetween,
} from "../repositories/business-days";
import { getExpectedCash } from "../repositories/cash-movements";
import { METRIC_DICTIONARY, type MetricId } from "../metrics/dictionary";
import { getStockAlertCounts } from "../repositories/products";
import { getLocationSettings } from "../repositories/settings";
import { zonedTime, zonedToday } from "../time";

/**
 * BI-01: the metrics service DEC-09 asks for — "chaque KPI expose source,
 * période, fuseau et fraîcheur". Everything financial or stock-related this
 * codebase already computes correctly (`getBusinessDaySummary`,
 * `getRevenueBetween`, `getExpectedCash`) is reused as-is: this module adds
 * no second implementation of a formula that already has one — the whole
 * point of a "contrat des métriques" is that a number the caisse screen and
 * the cockpit both show is provably the same call, not two SQL statements
 * that happen to agree today. What it adds is the self-describing envelope
 * around each value, and the two figures nothing yet computed as a scoped,
 * tested aggregate (`stock_out_of_stock`/`stock_low_stock`,
 * `cash_variance`).
 *
 * No route calls this yet — BI-02 onward are the consumers (history
 * queries, the comparison block, the cash-reconciliation and stock-at-risk
 * cockpit blocks). BI-01's own livrable is the service and its tests, not a
 * screen.
 */

export type MetricsPeriodKind = "day" | "month" | "year";

export interface MetricsQuery {
  period: MetricsPeriodKind;
  year?: number;
  month?: number;
}

/**
 * Not every metric shares the query's period: DEC-09 fixes stock alerts as
 * "Instantané" and cash variance as "À la clôture" regardless of what a
 * caller asked for — a KPI's period is a property of its own definition,
 * not of the request. `"none"` is the honest answer when a metric has
 * nothing to report for the requested period (no business day open, no
 * business day ever closed yet) rather than a zero that would look like a
 * real measurement.
 */
export type MetricPeriod =
  | { kind: "business_day"; from: string; to: string | null }
  | { kind: "range"; from: string; to: string }
  | { kind: "last_close"; closedAt: string | null }
  | { kind: "instant" }
  | { kind: "none" };

export interface Metric<T> {
  id: MetricId;
  version: number;
  label: string;
  source: readonly string[];
  value: T;
  period: MetricPeriod;
  /** The establishment's own timezone (`location_settings.timezone`), never the server's or the client's. */
  timezone: string;
  /** ISO instant this value was computed at — DEC-09's "fraîcheur". */
  computedAt: string;
}

export interface MetricsResult {
  netRevenue: Metric<string>;
  ordersCount: Metric<number>;
  averageBasket: Metric<string>;
  expectedCash: Metric<string | null>;
  cashVariance: Metric<string | null>;
  stockOutOfStock: Metric<number>;
  stockLowStock: Metric<number>;
}

export async function getMetrics(locationId: number, query: MetricsQuery): Promise<MetricsResult> {
  const settings = await getLocationSettings(pool, locationId);
  const timezone = settings.timezone;
  // One instant for every metric in this call: two KPIs computed a
  // millisecond apart from the same request would otherwise carry two
  // different "fraîcheur" timestamps for no reason a reader could act on.
  const computedAt = new Date().toISOString();

  function envelope<T>(id: MetricId, value: T, period: MetricPeriod): Metric<T> {
    const definition = METRIC_DICTIONARY[id];
    return {
      id,
      version: definition.version,
      label: definition.label,
      source: definition.source,
      value,
      period,
      timezone,
      computedAt,
    };
  }

  let revenue: { revenue: string; orders_count: number; average_basket: string };
  let revenuePeriod: MetricPeriod;
  let expectedCashValue: string | null = null;
  let expectedCashPeriod: MetricPeriod = { kind: "none" };

  if (query.period === "day") {
    // "Service en cours" (DEC-04): the open business day, not the calendar
    // day — the same reading lib/services/dashboard.ts already settled on.
    const activeDay = await getActiveBusinessDay(pool, locationId);
    if (activeDay) {
      const [summary, expected] = await Promise.all([
        getBusinessDaySummary(pool, locationId, activeDay.id),
        getExpectedCash(pool, locationId, activeDay.id),
      ]);
      revenue = summary;
      revenuePeriod = { kind: "business_day", from: activeDay.opened_at, to: null };
      expectedCashValue = expected.expected;
      expectedCashPeriod = revenuePeriod;
    } else {
      revenue = { revenue: "0.00", orders_count: 0, average_basket: "0.00" };
      revenuePeriod = { kind: "none" };
      // expectedCashPeriod stays "none": there is no session to expect cash for.
    }
  } else {
    const today = zonedToday(timezone);
    const year = query.year ?? today.year;
    const month = query.month ?? today.month;
    const from =
      query.period === "year"
        ? zonedTime(timezone, year, 1, 1)
        : zonedTime(timezone, year, month, 1);
    const to =
      query.period === "year"
        ? zonedTime(timezone, year + 1, 1, 1)
        : month === 12
          ? zonedTime(timezone, year + 1, 1, 1)
          : zonedTime(timezone, year, month + 1, 1);
    revenue = await getRevenueBetween(pool, locationId, from, to);
    revenuePeriod = { kind: "range", from: from.toISOString(), to: to.toISOString() };
    // expectedCashPeriod stays "none": expected cash is a property of one
    // session (DEC-04), not of a month or a year — summing drawers across a
    // range would produce a number that reconciles against nothing.
  }

  const [lastClosed, stockAlerts] = await Promise.all([
    getLastClosedBusinessDay(pool, locationId),
    getStockAlertCounts(pool, locationId),
  ]);

  return {
    netRevenue: envelope("net_revenue", revenue.revenue, revenuePeriod),
    ordersCount: envelope("orders_count", revenue.orders_count, revenuePeriod),
    averageBasket: envelope("average_basket", revenue.average_basket, revenuePeriod),
    expectedCash: envelope("expected_cash", expectedCashValue, expectedCashPeriod),
    cashVariance: envelope("cash_variance", lastClosed?.cash_variance ?? null, {
      kind: "last_close",
      closedAt: lastClosed?.closed_at ?? null,
    }),
    stockOutOfStock: envelope("stock_out_of_stock", stockAlerts.out_of_stock, { kind: "instant" }),
    stockLowStock: envelope("stock_low_stock", stockAlerts.low_stock, { kind: "instant" }),
  };
}
