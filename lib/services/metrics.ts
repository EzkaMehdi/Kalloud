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
 * No route calls this yet — BI-05 onward are the consumers (the context
 * banner, the comparison block, the cash-reconciliation and stock-at-risk
 * cockpit blocks). BI-01/BI-03's own livrable is the service and its tests,
 * not a screen.
 *
 * BI-03: "clarifier service et périodes calendaires" — DEC-09's own period
 * column lists five distinct values ("Service en cours / jour / mois /
 * année / plage"), and BI-01 only ever implemented one of them under the
 * name `"day"`, which silently meant "the open business day" — DEC-04's
 * *session*, never a chosen calendar day. That conflation is fixed here by
 * splitting it into two real, distinct period kinds: `"service"` (the
 * session — what `expected_cash`/`cash_variance` are properties of, DEC-04)
 * and `"day"` (an actual calendar day, past or present, which a manager can
 * ask about even after the service that covered it has long closed).
 * `"range"` (arbitrary bounds) is new outright — nothing computed one
 * before.
 */

export type MetricsPeriodKind = "service" | "day" | "month" | "year" | "range";

/**
 * A discriminated union, not one object with every field optional: each
 * period kind accepts exactly the parameters that describe it and no
 * others — "aucun filtre visible s'il est ignoré" (BI-03's acceptance)
 * enforced structurally rather than by a caller's discipline. `service`
 * takes nothing (there is only ever one open session); `range` requires
 * both bounds explicitly, because a half-open range has no honest default.
 * `lib/validation/schemas.ts::metricsQuerySchema` is the request-boundary
 * mirror of this same shape, `z.strictObject`-enforced per branch so an
 * irrelevant query parameter (`?period=year&day=12`) is a 400, not a
 * silently ignored no-op.
 */
export type MetricsQuery =
  | { period: "service" }
  | { period: "day"; year?: number; month?: number; day?: number }
  | { period: "month"; year?: number; month?: number }
  | { period: "year"; year?: number }
  | { period: "range"; from: string; to: string };

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

  if (query.period === "service") {
    // DEC-04's session, not a calendar day: the one period `expected_cash`
    // and `cash_variance` (below) can honestly attach to.
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
  } else if (query.period === "day") {
    // A chosen calendar day — defaults to today, but unlike "service" this
    // answers just as well for a day whose service closed weeks ago, or one
    // that never had a service open on it at all (a stocktake-only day).
    const today = zonedToday(timezone);
    const year = query.year ?? today.year;
    const month = query.month ?? today.month;
    const day = query.day ?? today.day;
    const from = zonedTime(timezone, year, month, day);
    // Date.UTC (which zonedTime is built on) normalises an out-of-range day
    // on its own — day 32 of any month lands on the 1st/2nd of the next one
    // — so the day *after* `from` needs no month-end special case.
    const to = zonedTime(timezone, year, month, day + 1);
    revenue = await getRevenueBetween(pool, locationId, from, to);
    revenuePeriod = { kind: "range", from: from.toISOString(), to: to.toISOString() };
    // expectedCashPeriod stays "none": see the "service" branch's comment —
    // still true for a single calendar day, which may span parts of two
    // sessions or none at all.
  } else if (query.period === "month" || query.period === "year") {
    const today = zonedToday(timezone);
    const year = query.year ?? today.year;
    const month = query.period === "month" ? (query.month ?? today.month) : 1;
    const from =
      query.period === "year" ? zonedTime(timezone, year, 1, 1) : zonedTime(timezone, year, month, 1);
    const to =
      query.period === "year"
        ? zonedTime(timezone, year + 1, 1, 1)
        : zonedTime(timezone, year, month + 1, 1);
    revenue = await getRevenueBetween(pool, locationId, from, to);
    revenuePeriod = { kind: "range", from: from.toISOString(), to: to.toISOString() };
    // expectedCashPeriod stays "none": expected cash is a property of one
    // session (DEC-04), not of a month or a year — summing drawers across a
    // range would produce a number that reconciles against nothing.
  } else {
    // "range": the only kind with no default — a half-open range has no
    // honest midpoint to assume, so both bounds are required by
    // metricsQuerySchema before this function is ever reached from a route.
    const from = new Date(query.from);
    const to = new Date(query.to);
    revenue = await getRevenueBetween(pool, locationId, from, to);
    revenuePeriod = { kind: "range", from: query.from, to: query.to };
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
