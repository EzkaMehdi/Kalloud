import { pool } from "../db";
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
}

const EMPTY_SUMMARY: DashboardSummary = {
  revenue: "0.00",
  cash_revenue: "0.00",
  card_revenue: "0.00",
  orders_count: 0,
  average_basket: "0.00",
};

/**
 * Ports the prototype's `/api/dashboard` (now scoped by locationId). Period
 * boundaries still use the server's local date, not the establishment's
 * configured timezone (location_settings.timezone, CFG-00) — making every
 * period genuinely timezone-correct and clarifying "service en cours" vs.
 * calendar day is BI-03 (phase 6), not this port.
 */
export async function getDashboardSummary(
  locationId: number,
  query: DashboardQuery,
): Promise<DashboardSummary> {
  const today = new Date();
  const year = query.year ?? today.getFullYear();
  const month = query.month ?? today.getMonth() + 1;

  if (query.period === "day") {
    const activeDay = await getActiveBusinessDay(pool, locationId);
    if (activeDay) {
      return getBusinessDaySummary(pool, locationId, activeDay.id);
    }
    return EMPTY_SUMMARY;
  }

  let from: Date;
  let to: Date;
  if (query.period === "year") {
    from = new Date(year, 0, 1);
    to = new Date(year + 1, 0, 1);
  } else {
    from = new Date(year, month - 1, 1);
    to = new Date(year, month, 1);
  }

  return getRevenueBetween(pool, locationId, from, to);
}
