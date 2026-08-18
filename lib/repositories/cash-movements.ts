import type { Queryable } from "../db";
import { NotFoundError } from "../errors";
import type { CashMovementCategory } from "../validation/primitives";

export type CashMovementType = "OPENING" | "IN" | "OUT";

/**
 * CASH-03/DEC-11: the opening float's category. It lives here rather than in
 * the client-facing enum because `CASH_MOVEMENT_TYPES` deliberately keeps
 * `OPENING` out of what an API caller may send — only the business-day
 * service records one.
 */
export const OPENING_FLOAT_CATEGORY = "OPENING_FLOAT";

export type StoredCashMovementCategory = CashMovementCategory | typeof OPENING_FLOAT_CATEGORY;

export interface CashMovementRow {
  id: number;
  location_id: number;
  business_day_id: number | null;
  type: CashMovementType;
  category: StoredCashMovementCategory;
  amount: string;
  reason: string;
  created_by: number;
  created_at: string;
}

export interface CreateCashMovementInput {
  businessDayId: number | null;
  type: CashMovementType;
  /** Constrained against `type` by `migrations/0016` and by createCashMovementSchema. */
  category: StoredCashMovementCategory;
  /**
   * A `DECIMAL(10,2)`-shaped string ("20.00"), as produced by
   * `fromCents()`. Deliberately not a JS number: binary floating point
   * cannot represent every 2-decimal amount exactly, and this column is the
   * cash journal (DEC-05).
   */
  amount: string;
  reason: string;
  createdBy: number;
}

export async function createCashMovement(
  db: Queryable,
  locationId: number,
  input: CreateCashMovementInput,
): Promise<CashMovementRow> {
  const {
    rows: [row],
  } = await db.query<CashMovementRow>(
    `INSERT INTO cash_movements (location_id, business_day_id, type, category, amount, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      locationId,
      input.businessDayId,
      input.type,
      input.category,
      input.amount,
      input.reason,
      input.createdBy,
    ],
  );
  return row;
}

/**
 * CASH-07: `businessDayId` bounds the journal to one cash session.
 *
 * Without it the screen listed the establishment's last 100 movements
 * whatever service they belonged to, so the morning after a close the
 * journal still showed yesterday's float and withdrawals underneath today's
 * balance — two numbers that describe different periods, stacked as if they
 * explained each other. DEC-04 is explicit that a day is aggregated by
 * `business_day_id` and never by calendar date, and this is the last read
 * that ignored it.
 *
 * The filter is opt-in rather than mandatory because tests legitimately
 * assert over everything an establishment ever recorded; the route — the
 * only caller that feeds a screen — always passes it.
 */
export async function listCashMovements(
  db: Queryable,
  locationId: number,
  options: { businessDayId?: number; limit?: number } = {},
): Promise<CashMovementRow[]> {
  const { businessDayId, limit = 100 } = options;
  const { rows } = await db.query<CashMovementRow>(
    `SELECT * FROM cash_movements
      WHERE location_id = $1 AND ($2::INT IS NULL OR business_day_id = $2)
      ORDER BY created_at DESC, id DESC LIMIT $3`,
    [locationId, businessDayId ?? null, limit],
  );
  return rows;
}

export interface CashMovementHistoryFilters {
  /** Inclusive lower bound on `created_at`. */
  from?: string;
  /** Exclusive upper bound. */
  to?: string;
  type?: CashMovementType;
  category?: StoredCashMovementCategory;
  limit: number;
  offset: number;
}

export interface CashMovementHistoryPage {
  movements: CashMovementRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * BI-02: "caisse" — the establishment's whole movement history, filterable
 * and paginated. `listCashMovements` (CASH-07) deliberately answers a
 * narrower question — the *open service's own* journal, empty when none is
 * open, because a live caisse screen showing yesterday's movements under
 * today's balance would invite reading them as today's. A cockpit's
 * historical drill-down asks the opposite question — "what happened last
 * month" — so it is its own function rather than a widened CASH-07, which
 * would have reintroduced exactly the ambiguity that task closed.
 */
export async function listCashMovementsHistory(
  db: Queryable,
  locationId: number,
  filters: CashMovementHistoryFilters,
): Promise<CashMovementHistoryPage> {
  const conditions = ["location_id = $1"];
  const values: unknown[] = [locationId];

  if (filters.from) {
    values.push(filters.from);
    conditions.push(`created_at >= $${values.length}`);
  }
  if (filters.to) {
    values.push(filters.to);
    conditions.push(`created_at < $${values.length}`);
  }
  if (filters.type) {
    values.push(filters.type);
    conditions.push(`type = $${values.length}`);
  }
  if (filters.category) {
    values.push(filters.category);
    conditions.push(`category = $${values.length}`);
  }
  const where = conditions.join(" AND ");

  const { rows: countRows } = await db.query<{ total: string }>(
    `SELECT COUNT(*)::TEXT AS total FROM cash_movements WHERE ${where}`,
    values,
  );

  const { rows } = await db.query<CashMovementRow>(
    `SELECT * FROM cash_movements
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, filters.limit, filters.offset],
  );

  return {
    movements: rows,
    total: Number(countRows[0].total),
    limit: filters.limit,
    offset: filters.offset,
  };
}

/**
 * CASH-04: the expected cash in the drawer, and the terms it is made of.
 *
 *     fond initial + ventes espèces nettes + entrées − sorties
 *
 * This is the single definition. Before it, three places answered the
 * question differently: `/api/cash-summary` summed the movement ledger,
 * while the closing computed `opening_cash + cash_revenue` and ignored cash
 * movements entirely — a day opened at 150 €, selling 100 € in cash, with a
 * 200 € end-of-service withdrawal, closed at 250 € while the drawer held
 * 50 €. Every caller now shares this function, so they cannot drift again.
 *
 * Two double-counting traps are closed structurally rather than by
 * convention:
 *
 * - The opening float exists twice in the schema — as
 *   `business_days.opening_cash` and as the `OPENING` movement written
 *   beside it (CASH-01). It is read once, from the day, and `OPENING` is
 *   excluded from the movement sums. A legacy day whose float predates the
 *   movement ledger is therefore still counted correctly.
 * - A withdrawal is a single `OUT` row, subtracted once. The
 *   end-of-service withdrawal (DEC-11) is deliberately *not* special-cased
 *   here: it leaves the drawer exactly like any other outflow, and treating
 *   it apart is what would create the double count `CASH-04` forbids. Its
 *   category exists so the closing screen can *show* it (CASH-05), not so
 *   the arithmetic can bend around it.
 *
 * The breakdown is returned, not just the total: DEC-04 requires the
 * closing screen to show the detail of the calculation above the counted
 * amount, and a total alone cannot be explained to a cashier who disagrees
 * with it.
 */
export interface ExpectedCash {
  /** `business_days.opening_cash` — the float stated when the service was opened. */
  opening_cash: string;
  /** Cash charges minus cash refunds (ORD-10/DEC-09). */
  cash_sales: string;
  /** `IN` movements only; the opening float is not one of them. */
  cash_in: string;
  /** `OUT` movements, withdrawals included, each counted once. */
  cash_out: string;
  expected: string;
}

export async function getExpectedCash(
  db: Queryable,
  locationId: number,
  businessDayId: number,
): Promise<ExpectedCash> {
  const { rows } = await db.query<ExpectedCash>(
    `WITH movements AS (
       SELECT
         COALESCE(SUM(amount) FILTER (WHERE type = 'IN'), 0)  AS cash_in,
         COALESCE(SUM(amount) FILTER (WHERE type = 'OUT'), 0) AS cash_out
       FROM cash_movements
       WHERE location_id = $1 AND business_day_id = $2
     ),
     sales AS (
       -- ORD-10/DEC-09: "les ventes nettes intègrent les remboursements
       -- espèces". Read from the payments ledger, because a refunded order
       -- keeps its original amount for the whole life of the sale — the
       -- money handed back is a REFUND line, not a rewrite of what was
       -- taken.
       SELECT COALESCE(
                SUM(CASE WHEN p.type = 'CHARGE' THEN p.amount ELSE -p.amount END), 0
              ) AS cash_sales
       FROM payments p
       JOIN orders o ON o.id = p.order_id AND o.location_id = p.location_id
       WHERE p.method = 'CASH' AND o.location_id = $1 AND o.business_day_id = $2
     ),
     day AS (
       SELECT opening_cash FROM business_days WHERE id = $2 AND location_id = $1
     )
     SELECT
       day.opening_cash::DECIMAL(10, 2)                       AS opening_cash,
       sales.cash_sales::DECIMAL(10, 2)                       AS cash_sales,
       movements.cash_in::DECIMAL(10, 2)                      AS cash_in,
       movements.cash_out::DECIMAL(10, 2)                     AS cash_out,
       (day.opening_cash + sales.cash_sales + movements.cash_in - movements.cash_out)
         ::DECIMAL(10, 2)                                     AS expected
     FROM day, sales, movements`,
    [locationId, businessDayId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("Journée de caisse introuvable.");
  return row;
}
