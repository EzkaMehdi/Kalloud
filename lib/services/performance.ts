import { pool } from "../db";
import {
  getActiveBusinessDay,
  getBusinessDaySummary,
  getRevenueBetween,
} from "../repositories/business-days";
import { fromCents, sumCents, toCents } from "../money";
import { getLocationSettings } from "../repositories/settings";
import { zonedTime, zonedToday } from "../time";
import type { MetricsQuery } from "./metrics";

/**
 * BI-07: "CA net, commandes, panier moyen et comparaison pertinente" —
 * DEC-09's comparison rule, not "hier" but a genuinely comparable period.
 * For month/year, the previous equivalent calendar period (mois précédent,
 * année précédente). For a single day — a chosen `"day"`, or the calendar
 * day a `"service"` opened on — DEC-09 is explicit that comparing to
 * yesterday would blame a real, structural weekday effect on performance:
 * "un lundi se compare à la moyenne des lundis récents (ou au lundi
 * précédent à défaut d'historique suffisant)".
 *
 * Reuses `lib/services/metrics.ts`'s own `MetricsQuery` (the period
 * contract `BI-03` built) and the same repository formulas `BI-01` already
 * settled on (`getRevenueBetween`, `getBusinessDaySummary`) — no second
 * implementation of "CA net" exists here either.
 *
 * No route calls this yet, the same choice `BI-01`/`BI-03` made: this is
 * the service and its tests, not a screen.
 */

export interface ComparisonFigure<T> {
  current: T;
  /** `null` when there is nothing yet to compare against — no service open, or too new an establishment. */
  previous: T | null;
  /** `null` whenever `previous` is `null` or zero — a percentage against zero is not a real number. */
  changePercent: number | null;
}

export interface PerformanceComparison {
  netRevenue: ComparisonFigure<string>;
  ordersCount: ComparisonFigure<number>;
  averageBasket: ComparisonFigure<string>;
  /** States what "previous" means here in words — DEC-09 gives a different rule per period kind. */
  comparisonLabel: string;
  timezone: string;
  computedAt: string;
}

const MONTH_NAMES = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];

interface RevenueFigures {
  revenue: string;
  orders_count: number;
  average_basket: string;
}

function percentChange(current: number, previous: number | null): number | null {
  if (previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function buildComparison(
  current: RevenueFigures,
  previous: RevenueFigures | null,
): Pick<PerformanceComparison, "netRevenue" | "ordersCount" | "averageBasket"> {
  return {
    netRevenue: {
      current: current.revenue,
      previous: previous?.revenue ?? null,
      changePercent: percentChange(
        Number(current.revenue),
        previous ? Number(previous.revenue) : null,
      ),
    },
    ordersCount: {
      current: current.orders_count,
      previous: previous?.orders_count ?? null,
      changePercent: percentChange(current.orders_count, previous?.orders_count ?? null),
    },
    averageBasket: {
      current: current.average_basket,
      previous: previous?.average_basket ?? null,
      changePercent: percentChange(
        Number(current.average_basket),
        previous ? Number(previous.average_basket) : null,
      ),
    },
  };
}

/**
 * DEC-09: "un lundi se compare à la moyenne des lundis récents (ou au
 * lundi précédent à défaut d'historique suffisant)". The average of the
 * last `weeksBack` occurrences of the same calendar weekday — going back
 * exactly 7 days at a time lands on the same weekday by construction, so
 * no weekday arithmetic is needed. Averaging a single occurrence *is* "le
 * lundi précédent": that fallback is not a separate code path, just what
 * this reduces to with one data point — the same reasoning `BI-01`
 * applied to the stock alert count and expected cash, kept to one formula
 * rather than a formula plus a special case.
 *
 * `orders_count` in the result may be fractional (an average of whole
 * counts): the honest shape of "a typical Monday does 2.5 commandes", not
 * rounded away before a caller ever sees it.
 */
async function averageOverPastSameWeekday(
  locationId: number,
  timezone: string,
  year: number,
  month: number,
  day: number,
  weeksBack: number,
): Promise<RevenueFigures> {
  const revenueCents: number[] = [];
  let totalOrders = 0;
  for (let week = 1; week <= weeksBack; week++) {
    const from = zonedTime(timezone, year, month, day - 7 * week);
    const to = zonedTime(timezone, year, month, day - 7 * week + 1);
    const summary = await getRevenueBetween(pool, locationId, from, to);
    revenueCents.push(toCents(summary.revenue));
    totalOrders += summary.orders_count;
  }
  const totalRevenueCents = sumCents(revenueCents);
  return {
    revenue: fromCents(Math.round(totalRevenueCents / weeksBack)),
    orders_count: totalOrders / weeksBack,
    average_basket:
      totalOrders > 0 ? fromCents(Math.round(totalRevenueCents / totalOrders)) : "0.00",
  };
}

/** Capitalised weekday name in `timezone`, e.g. "Lundi". */
function weekdayName(timezone: string, at: Date): string {
  const name = new Intl.DateTimeFormat("fr-FR", { weekday: "long", timeZone: timezone }).format(at);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const WEEKS_BACK = 4;

export async function getPerformanceComparison(
  locationId: number,
  query: MetricsQuery,
): Promise<PerformanceComparison> {
  const settings = await getLocationSettings(pool, locationId);
  const timezone = settings.timezone;
  const computedAt = new Date().toISOString();

  if (query.period === "service") {
    const activeDay = await getActiveBusinessDay(pool, locationId);
    if (!activeDay) {
      return {
        ...buildComparison({ revenue: "0.00", orders_count: 0, average_basket: "0.00" }, null),
        comparisonLabel: "Aucun service ouvert",
        timezone,
        computedAt,
      };
    }
    const current = await getBusinessDaySummary(pool, locationId, activeDay.id);
    const openedAt = new Date(activeDay.opened_at);
    const { year, month, day } = zonedToday(timezone, openedAt);
    const previous = await averageOverPastSameWeekday(
      locationId,
      timezone,
      year,
      month,
      day,
      WEEKS_BACK,
    );
    return {
      ...buildComparison(current, previous),
      comparisonLabel: `Moyenne des ${WEEKS_BACK} derniers ${weekdayName(timezone, openedAt)}s`,
      timezone,
      computedAt,
    };
  }

  if (query.period === "day") {
    const today = zonedToday(timezone);
    const year = query.year ?? today.year;
    const month = query.month ?? today.month;
    const day = query.day ?? today.day;
    const from = zonedTime(timezone, year, month, day);
    const to = zonedTime(timezone, year, month, day + 1);
    const current = await getRevenueBetween(pool, locationId, from, to);
    const previous = await averageOverPastSameWeekday(
      locationId,
      timezone,
      year,
      month,
      day,
      WEEKS_BACK,
    );
    return {
      ...buildComparison(current, previous),
      comparisonLabel: `Moyenne des ${WEEKS_BACK} derniers ${weekdayName(timezone, from)}s`,
      timezone,
      computedAt,
    };
  }

  if (query.period === "month") {
    const today = zonedToday(timezone);
    const year = query.year ?? today.year;
    const month = query.month ?? today.month;
    const from = zonedTime(timezone, year, month, 1);
    const to = zonedTime(timezone, year, month + 1, 1);
    const current = await getRevenueBetween(pool, locationId, from, to);
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prevFrom = zonedTime(timezone, prevYear, prevMonth, 1);
    const prevTo = zonedTime(timezone, prevYear, prevMonth + 1, 1);
    const previous = await getRevenueBetween(pool, locationId, prevFrom, prevTo);
    return {
      ...buildComparison(current, previous),
      comparisonLabel: `Mois précédent (${MONTH_NAMES[prevMonth - 1]} ${prevYear})`,
      timezone,
      computedAt,
    };
  }

  if (query.period === "year") {
    const today = zonedToday(timezone);
    const year = query.year ?? today.year;
    const from = zonedTime(timezone, year, 1, 1);
    const to = zonedTime(timezone, year + 1, 1, 1);
    const current = await getRevenueBetween(pool, locationId, from, to);
    const prevFrom = zonedTime(timezone, year - 1, 1, 1);
    const prevTo = zonedTime(timezone, year, 1, 1);
    const previous = await getRevenueBetween(pool, locationId, prevFrom, prevTo);
    return {
      ...buildComparison(current, previous),
      comparisonLabel: `Année précédente (${year - 1})`,
      timezone,
      computedAt,
    };
  }

  // "range": DEC-09 defines no rule for an arbitrary range — the
  // immediately preceding period of the same duration is this service's
  // own, documented extrapolation of "période précédente comparable",
  // exactly the way a range period had no defined default in BI-03 either.
  const from = new Date(query.from);
  const to = new Date(query.to);
  const current = await getRevenueBetween(pool, locationId, from, to);
  const durationMs = to.getTime() - from.getTime();
  const prevTo = from;
  const prevFrom = new Date(from.getTime() - durationMs);
  const previous = await getRevenueBetween(pool, locationId, prevFrom, prevTo);
  return {
    ...buildComparison(current, previous),
    comparisonLabel: "Période précédente de même durée",
    timezone,
    computedAt,
  };
}
