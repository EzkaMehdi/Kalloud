import { pool } from "../db";
import { listStockAtRisk, type StockRiskRow } from "../repositories/products";
import { getLocationSettings } from "../repositories/settings";

/**
 * BI-10: "ruptures, sous-seuils et actions de réapprovisionnement" — the
 * two lists behind `BI-01`'s `stockOutOfStock`/`stockLowStock` counts,
 * split from the same query (`listStockAtRisk`) so the counts and these
 * lists can never disagree about which product belongs in which bucket.
 */

export interface StockRiskProduct {
  id: number;
  name: string;
  stockQuantity: number;
  alertThreshold: number;
  categoryName: string | null;
}

export interface StockAtRisk {
  outOfStock: StockRiskProduct[];
  lowStock: StockRiskProduct[];
  timezone: string;
  computedAt: string;
}

function toRiskProduct(row: StockRiskRow): StockRiskProduct {
  return {
    id: row.id,
    name: row.name,
    stockQuantity: row.stock_quantity,
    alertThreshold: row.alert_threshold,
    categoryName: row.category_name,
  };
}

export async function getStockAtRisk(locationId: number): Promise<StockAtRisk> {
  const [settings, rows] = await Promise.all([
    getLocationSettings(pool, locationId),
    listStockAtRisk(pool, locationId),
  ]);

  const outOfStock: StockRiskProduct[] = [];
  const lowStock: StockRiskProduct[] = [];
  for (const row of rows) {
    (row.stock_quantity === 0 ? outOfStock : lowStock).push(toRiskProduct(row));
  }

  return {
    outOfStock,
    lowStock,
    timezone: settings.timezone,
    computedAt: new Date().toISOString(),
  };
}
