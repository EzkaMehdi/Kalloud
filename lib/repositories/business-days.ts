import type { Queryable } from "../db";
import { NotFoundError } from "../errors";

export interface BusinessDayRow {
  id: number;
  location_id: number;
  opened_at: string;
  closed_at: string | null;
  opening_cash: string;
  closing_cash: string | null;
  status: "OPEN" | "CLOSED";
}

export async function getActiveBusinessDay(
  db: Queryable,
  locationId: number,
): Promise<BusinessDayRow | null> {
  const { rows } = await db.query<BusinessDayRow>(
    "SELECT * FROM business_days WHERE location_id = $1 AND status = 'OPEN' ORDER BY id DESC LIMIT 1",
    [locationId],
  );
  return rows[0] ?? null;
}

export interface BusinessDaySummary {
  revenue: string;
  cash_revenue: string;
  card_revenue: string;
  orders_count: number;
  average_basket: string;
}

export async function getBusinessDaySummary(
  db: Queryable,
  locationId: number,
  businessDayId: number,
): Promise<BusinessDaySummary> {
  const { rows } = await db.query<BusinessDaySummary>(
    `SELECT COALESCE(SUM(total_amount), 0)::DECIMAL(10, 2) AS revenue,
            COALESCE(SUM(cash_amount), 0)::DECIMAL(10, 2) AS cash_revenue,
            COALESCE(SUM(card_amount), 0)::DECIMAL(10, 2) AS card_revenue,
            COUNT(*)::INT AS orders_count,
            COALESCE(AVG(total_amount), 0)::DECIMAL(10, 2) AS average_basket
     FROM orders
     WHERE status = 'COMPLETED' AND location_id = $1 AND business_day_id = $2`,
    [locationId, businessDayId],
  );
  return rows[0];
}

export async function getRevenueBetween(
  db: Queryable,
  locationId: number,
  from: Date,
  to: Date,
): Promise<BusinessDaySummary> {
  const { rows } = await db.query<BusinessDaySummary>(
    `SELECT COALESCE(SUM(total_amount), 0)::DECIMAL(10, 2) AS revenue,
            COALESCE(SUM(cash_amount), 0)::DECIMAL(10, 2) AS cash_revenue,
            COALESCE(SUM(card_amount), 0)::DECIMAL(10, 2) AS card_revenue,
            COUNT(*)::INT AS orders_count,
            COALESCE(AVG(total_amount), 0)::DECIMAL(10, 2) AS average_basket
     FROM orders
     WHERE status = 'COMPLETED' AND location_id = $1 AND closed_at >= $2 AND closed_at < $3`,
    [locationId, from, to],
  );
  return rows[0];
}

/**
 * `closingCash`/`openingCash` are `DECIMAL(10,2)`-shaped strings ("150.00"),
 * as produced by `fromCents()` — see the note on CreateCashMovementInput.
 */
export async function closeBusinessDay(
  db: Queryable,
  locationId: number,
  businessDayId: number,
  closingCash: string,
): Promise<BusinessDayRow> {
  const { rows } = await db.query<BusinessDayRow>(
    `UPDATE business_days SET status = 'CLOSED', closed_at = now(), closing_cash = $3
     WHERE id = $1 AND location_id = $2 RETURNING *`,
    [businessDayId, locationId, closingCash],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("Journée de caisse introuvable.");
  return row;
}

export async function openBusinessDay(
  db: Queryable,
  locationId: number,
  openingCash: string,
): Promise<BusinessDayRow> {
  const {
    rows: [row],
  } = await db.query<BusinessDayRow>(
    "INSERT INTO business_days (location_id, opening_cash, status) VALUES ($1, $2, 'OPEN') RETURNING *",
    [locationId, openingCash],
  );
  return row;
}
