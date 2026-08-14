import type { Queryable } from "../db";
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

export async function listCashMovements(
  db: Queryable,
  locationId: number,
  limit = 100,
): Promise<CashMovementRow[]> {
  const { rows } = await db.query<CashMovementRow>(
    "SELECT * FROM cash_movements WHERE location_id = $1 ORDER BY created_at DESC LIMIT $2",
    [locationId, limit],
  );
  return rows;
}

/**
 * TODO(CASH-04, phase 5A): this reproduces the prototype's formula
 * (opening/in/out +/- cash sales), which does not net out refunds or
 * end-of-service withdrawals correctly. The DEC-04/DEC-05-correct formula
 * ("fond initial + ventes espèces nettes + entrées - sorties") lands with
 * the cash reconciliation rewrite once payments/refunds exist as their own
 * ledger (SALE-02).
 */
export async function getCashBalance(
  db: Queryable,
  locationId: number,
  businessDayId: number,
): Promise<string> {
  const { rows } = await db.query<{ balance: string }>(
    `SELECT (
       COALESCE(
         (SELECT SUM(CASE WHEN type IN ('OPENING', 'IN') THEN amount ELSE -amount END)
          FROM cash_movements WHERE location_id = $1 AND business_day_id = $2),
         0
       ) + COALESCE(
         -- ORD-10/DEC-09: "les ventes nettes intègrent les remboursements
         -- espèces". Read from the payments ledger, because a refunded
         -- order keeps its original cash_amount — the money handed back is
         -- a REFUND line, not a rewrite of what was taken.
         (SELECT SUM(CASE WHEN p.type = 'CHARGE' THEN p.amount ELSE -p.amount END)
          FROM payments p
          JOIN orders o ON o.id = p.order_id AND o.location_id = p.location_id
          WHERE p.method = 'CASH' AND o.location_id = $1 AND o.business_day_id = $2),
         0
       )
     )::DECIMAL(10, 2) AS balance`,
    [locationId, businessDayId],
  );
  return rows[0].balance;
}
