import type { Queryable } from "../db";

export type CashMovementType = "OPENING" | "IN" | "OUT";

export interface CashMovementRow {
  id: number;
  location_id: number;
  business_day_id: number | null;
  type: CashMovementType;
  amount: string;
  reason: string;
  created_by: number;
  created_at: string;
}

export interface CreateCashMovementInput {
  businessDayId: number | null;
  type: CashMovementType;
  amount: number;
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
    `INSERT INTO cash_movements (location_id, business_day_id, type, amount, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [locationId, input.businessDayId, input.type, input.amount, input.reason, input.createdBy],
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
         (SELECT SUM(cash_amount) FROM orders WHERE status = 'COMPLETED' AND location_id = $1 AND business_day_id = $2),
         0
       )
     )::DECIMAL(10, 2) AS balance`,
    [locationId, businessDayId],
  );
  return rows[0].balance;
}
