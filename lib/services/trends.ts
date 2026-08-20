import { pool } from "../db";
import {
  getAverageServiceMinutes,
  getDailyTrend,
  getHourlyTrend,
  getSalesByCategory,
  getSalesByProduct,
  getTableTurnover,
  type CategorySalesRow,
  type DailyTrendRow,
  type HourlyTrendRow,
  type ProductSalesRow,
  type TableTurnoverRow,
} from "../repositories/trends";
import { getLocationSettings } from "../repositories/settings";

/**
 * BI-08: "évolution heure/jour, ventes par catégorie/produit, rotation des
 * tables et durée moyenne de service." Four independent breakdowns of the
 * same underlying, already-proven revenue definition (`lib/repositories/
 * trends.ts`'s own note on why there is exactly one "CA net" formula, not
 * five) — this service is the single call a caller makes to get all of
 * them for one range, each still individually filterable/traceable
 * (product id, category id, table id, hour, calendar day) for a future
 * drill-down (`BI-11`).
 *
 * Takes a plain date range, not `lib/services/metrics.ts`'s five-period
 * contract — `BI-08` depends on `BI-02`/`ORD-12`, not `BI-03`, and every
 * breakdown here answers the same way regardless of which UI period
 * selector produced the range.
 *
 * No route calls this yet, the same choice `BI-01`/`BI-03`/`BI-07` made:
 * the livrable is the service and its tests, not a screen.
 */
export interface SalesTrends {
  hourly: HourlyTrendRow[];
  daily: DailyTrendRow[];
  byProduct: ProductSalesRow[];
  byCategory: CategorySalesRow[];
  tableTurnover: TableTurnoverRow[];
  /** Table tickets only — see `getTableTurnover`'s own note on why a counter sale is excluded. */
  averageServiceMinutes: number | null;
  from: string;
  to: string;
  timezone: string;
  computedAt: string;
}

export async function getSalesTrends(
  locationId: number,
  from: Date,
  to: Date,
): Promise<SalesTrends> {
  const settings = await getLocationSettings(pool, locationId);
  const timezone = settings.timezone;

  const [hourly, daily, byProduct, byCategory, tableTurnover, averageServiceMinutes] =
    await Promise.all([
      getHourlyTrend(pool, locationId, from, to, timezone),
      getDailyTrend(pool, locationId, from, to, timezone),
      getSalesByProduct(pool, locationId, from, to),
      getSalesByCategory(pool, locationId, from, to),
      getTableTurnover(pool, locationId, from, to),
      getAverageServiceMinutes(pool, locationId, from, to),
    ]);

  return {
    hourly,
    daily,
    byProduct,
    byCategory,
    tableTurnover,
    averageServiceMinutes,
    from: from.toISOString(),
    to: to.toISOString(),
    timezone,
    computedAt: new Date().toISOString(),
  };
}
