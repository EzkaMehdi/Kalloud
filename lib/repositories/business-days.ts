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
  // ORD-10/DEC-09: computed from the payments ledger, not from the orders'
  // inline amounts. "CA net = SUM(commandes PAID.total) − SUM(remboursements)"
  // cannot be read off `orders.total_amount`, which keeps the amount
  // originally charged for the whole life of the sale — a refunded order
  // still carries its full total, by design (nothing is ever rewritten).
  // Netting CHARGE against REFUND is the only place that arithmetic is true.
  const { rows } = await db.query<BusinessDaySummary>(
    `WITH net AS (
       SELECT p.method,
              SUM(CASE WHEN p.type = 'CHARGE' THEN p.amount ELSE -p.amount END) AS amount
       FROM payments p
       JOIN orders o ON o.id = p.order_id AND o.location_id = p.location_id
       WHERE o.location_id = $1 AND o.business_day_id = $2
       GROUP BY p.method
     ),
     counted AS (
       SELECT COUNT(*)::INT AS orders_count
       FROM orders
       WHERE location_id = $1 AND business_day_id = $2 AND status IN ('PAID', 'REFUNDED')
     )
     SELECT COALESCE((SELECT SUM(amount) FROM net), 0)::DECIMAL(10, 2) AS revenue,
            COALESCE((SELECT amount FROM net WHERE method = 'CASH'), 0)::DECIMAL(10, 2) AS cash_revenue,
            COALESCE((SELECT amount FROM net WHERE method = 'CARD'), 0)::DECIMAL(10, 2) AS card_revenue,
            (SELECT orders_count FROM counted) AS orders_count,
            CASE
              WHEN (SELECT orders_count FROM counted) = 0 THEN 0
              ELSE COALESCE((SELECT SUM(amount) FROM net), 0) / (SELECT orders_count FROM counted)
            END::DECIMAL(10, 2) AS average_basket`,
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
    // Same netting as getBusinessDaySummary, over a date range. Payments are
    // attributed to the period their order was paid in, not the moment the
    // refund happened: a sale refunded next week belongs to this week's
    // figures, reduced.
    `WITH net AS (
       SELECT p.method,
              SUM(CASE WHEN p.type = 'CHARGE' THEN p.amount ELSE -p.amount END) AS amount
       FROM payments p
       JOIN orders o ON o.id = p.order_id AND o.location_id = p.location_id
       WHERE o.location_id = $1 AND o.paid_at >= $2 AND o.paid_at < $3
       GROUP BY p.method
     ),
     counted AS (
       SELECT COUNT(*)::INT AS orders_count
       FROM orders
       WHERE location_id = $1 AND paid_at >= $2 AND paid_at < $3
         AND status IN ('PAID', 'REFUNDED')
     )
     SELECT COALESCE((SELECT SUM(amount) FROM net), 0)::DECIMAL(10, 2) AS revenue,
            COALESCE((SELECT amount FROM net WHERE method = 'CASH'), 0)::DECIMAL(10, 2) AS cash_revenue,
            COALESCE((SELECT amount FROM net WHERE method = 'CARD'), 0)::DECIMAL(10, 2) AS card_revenue,
            (SELECT orders_count FROM counted) AS orders_count,
            CASE
              WHEN (SELECT orders_count FROM counted) = 0 THEN 0
              ELSE COALESCE((SELECT SUM(amount) FROM net), 0) / (SELECT orders_count FROM counted)
            END::DECIMAL(10, 2) AS average_basket`,
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
