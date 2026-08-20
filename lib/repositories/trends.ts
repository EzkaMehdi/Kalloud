import type { Queryable } from "../db";

export interface HourlyTrendRow {
  hour: number;
  revenue: string;
  orders_count: number;
}

export interface DailyTrendRow {
  date: string;
  revenue: string;
  orders_count: number;
}

export interface ProductSalesRow {
  product_id: number;
  product_name: string;
  category_id: number | null;
  category_name: string | null;
  quantity: number;
  revenue: string;
}

export interface CategorySalesRow {
  category_id: number | null;
  category_name: string;
  quantity: number;
  revenue: string;
}

export interface TableTurnoverRow {
  table_id: number;
  table_name: string;
  tickets_count: number;
  /** `null` only if every ticket's `paid_at` somehow matched `created_at` to the microsecond — never happens with real traffic. */
  average_service_minutes: number | null;
}

/**
 * BI-08: revenue is net (CHARGE minus REFUND) per order, the same
 * definition `getRevenueBetween`/`getBusinessDaySummary` (BI-01) already
 * use — computed once here as a CTE, then each breakdown below groups
 * that same per-order figure differently, rather than a second
 * implementation of "CA net" per query.
 */
const NET_PER_ORDER = `
  SELECT o.id, o.table_id, o.created_at, o.paid_at,
         COALESCE(SUM(CASE WHEN p.type = 'CHARGE' THEN p.amount ELSE -p.amount END), 0) AS net
  FROM orders o
  LEFT JOIN payments p ON p.order_id = o.id AND p.location_id = o.location_id
  WHERE o.location_id = $1 AND o.paid_at >= $2 AND o.paid_at < $3
  GROUP BY o.id
`;

/** BI-08: "évolution heure" — net revenue and order count, by local hour of day, across the whole range. */
export async function getHourlyTrend(
  db: Queryable,
  locationId: number,
  from: Date,
  to: Date,
  timezone: string,
): Promise<HourlyTrendRow[]> {
  const { rows } = await db.query<HourlyTrendRow>(
    `WITH per_order AS (${NET_PER_ORDER})
     SELECT EXTRACT(HOUR FROM (paid_at AT TIME ZONE $4))::INT AS hour,
            COALESCE(SUM(net), 0)::DECIMAL(10, 2) AS revenue,
            COUNT(*)::INT AS orders_count
     FROM per_order
     GROUP BY hour
     ORDER BY hour`,
    [locationId, from, to, timezone],
  );
  return rows;
}

/** BI-08: "évolution jour" — net revenue and order count, one row per calendar day (in `timezone`) in the range. */
export async function getDailyTrend(
  db: Queryable,
  locationId: number,
  from: Date,
  to: Date,
  timezone: string,
): Promise<DailyTrendRow[]> {
  const { rows } = await db.query<DailyTrendRow>(
    `WITH per_order AS (${NET_PER_ORDER})
     SELECT ((paid_at AT TIME ZONE $4)::DATE)::TEXT AS date,
            COALESCE(SUM(net), 0)::DECIMAL(10, 2) AS revenue,
            COUNT(*)::INT AS orders_count
     FROM per_order
     GROUP BY date
     ORDER BY date`,
    [locationId, from, to, timezone],
  );
  return rows;
}

/**
 * BI-08: "ventes par produit". Line amount (`quantity * unit_price -
 * discount_amount`), not order-level net — a partial refund is an amount,
 * never a list of items (`ORD-10`), so no per-line refund exists to net
 * against. `PAID` and `REFUNDED` orders both count, the same choice
 * `listSoldItems` (`BI-02`) already made and documents: dropping a later-
 * refunded line would disagree with the order-level total it explains.
 */
export async function getSalesByProduct(
  db: Queryable,
  locationId: number,
  from: Date,
  to: Date,
): Promise<ProductSalesRow[]> {
  const { rows } = await db.query<ProductSalesRow>(
    `SELECT oi.product_id, p.name AS product_name, p.category_id, c.name AS category_name,
            SUM(oi.quantity)::INT AS quantity,
            SUM(oi.quantity * oi.unit_price - oi.discount_amount)::DECIMAL(10, 2) AS revenue
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN products p ON p.id = oi.product_id AND p.location_id = o.location_id
     LEFT JOIN categories c ON c.id = p.category_id AND c.location_id = o.location_id
     WHERE o.location_id = $1 AND o.status IN ('PAID', 'REFUNDED') AND o.paid_at >= $2 AND o.paid_at < $3
     GROUP BY oi.product_id, p.name, p.category_id, c.name
     ORDER BY revenue DESC`,
    [locationId, from, to],
  );
  return rows;
}

/** BI-08: "ventes par catégorie" — the same lines as `getSalesByProduct`, grouped one level up. */
export async function getSalesByCategory(
  db: Queryable,
  locationId: number,
  from: Date,
  to: Date,
): Promise<CategorySalesRow[]> {
  const { rows } = await db.query<CategorySalesRow>(
    `SELECT p.category_id, COALESCE(c.name, 'Sans catégorie') AS category_name,
            SUM(oi.quantity)::INT AS quantity,
            SUM(oi.quantity * oi.unit_price - oi.discount_amount)::DECIMAL(10, 2) AS revenue
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN products p ON p.id = oi.product_id AND p.location_id = o.location_id
     LEFT JOIN categories c ON c.id = p.category_id AND c.location_id = o.location_id
     WHERE o.location_id = $1 AND o.status IN ('PAID', 'REFUNDED') AND o.paid_at >= $2 AND o.paid_at < $3
     GROUP BY p.category_id, c.name
     ORDER BY revenue DESC`,
    [locationId, from, to],
  );
  return rows;
}

/**
 * BI-08: "rotation des tables et durée moyenne de service" —
 * "calcul de rotation limité aux tickets avec table" (the acceptance
 * criterion, verbatim): `table_id IS NOT NULL` excludes counter sales,
 * whose "service duration" (open to paid) is typically seconds and would
 * not describe a table turning over at all.
 */
export async function getTableTurnover(
  db: Queryable,
  locationId: number,
  from: Date,
  to: Date,
): Promise<TableTurnoverRow[]> {
  const { rows } = await db.query<TableTurnoverRow>(
    `SELECT o.table_id, t.name AS table_name,
            COUNT(*)::INT AS tickets_count,
            AVG(EXTRACT(EPOCH FROM (o.paid_at - o.created_at)) / 60)::DECIMAL(10, 2) AS average_service_minutes
     FROM orders o
     JOIN dining_tables t ON t.id = o.table_id AND t.location_id = o.location_id
     WHERE o.location_id = $1 AND o.table_id IS NOT NULL AND o.status IN ('PAID', 'REFUNDED')
       AND o.paid_at >= $2 AND o.paid_at < $3
     GROUP BY o.table_id, t.name
     ORDER BY t.name`,
    [locationId, from, to],
  );
  return rows;
}

/** The establishment-wide average of `getTableTurnover`'s own duration — table tickets only, same restriction. */
export async function getAverageServiceMinutes(
  db: Queryable,
  locationId: number,
  from: Date,
  to: Date,
): Promise<number | null> {
  const { rows } = await db.query<{ average_service_minutes: string | null }>(
    `SELECT AVG(EXTRACT(EPOCH FROM (paid_at - created_at)) / 60)::DECIMAL(10, 2) AS average_service_minutes
     FROM orders
     WHERE location_id = $1 AND table_id IS NOT NULL AND status IN ('PAID', 'REFUNDED')
       AND paid_at >= $2 AND paid_at < $3`,
    [locationId, from, to],
  );
  const value = rows[0]?.average_service_minutes;
  return value === null || value === undefined ? null : Number(value);
}
