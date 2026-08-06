import type { Queryable } from "../db";

export type PaymentType = "CHARGE" | "REFUND";
/**
 * Deliberately narrower than lib/validation/primitives.ts's `PaymentMethod`
 * (`CASH | CARD | MIXED`): MIXED describes an order's overall payment mix
 * (it has both a CASH and a CARD line), never a single payment line's own
 * method.
 */
export type PaymentLineMethod = "CASH" | "CARD";

export interface PaymentRow {
  id: number;
  location_id: number;
  order_id: number;
  type: PaymentType;
  method: PaymentLineMethod;
  amount: string;
  refunded_payment_id: number | null;
  created_by: number;
  created_at: string;
}

export interface RecordChargeInput {
  orderId: number;
  method: PaymentLineMethod;
  amount: string;
  createdBy: number;
}

/** Records a CHARGE line. `amount` is a `DECIMAL(10,2)`-shaped string, as produced by `fromCents()`. */
export async function recordCharge(
  db: Queryable,
  locationId: number,
  input: RecordChargeInput,
): Promise<PaymentRow> {
  const {
    rows: [payment],
  } = await db.query<PaymentRow>(
    `INSERT INTO payments (location_id, order_id, type, method, amount, created_by)
     VALUES ($1, $2, 'CHARGE', $3, $4, $5)
     RETURNING id, location_id, order_id, type, method, amount, refunded_payment_id, created_by, created_at`,
    [locationId, input.orderId, input.method, input.amount, input.createdBy],
  );
  return payment;
}

export interface RecordRefundInput {
  orderId: number;
  refundedPaymentId: number;
  method: PaymentLineMethod;
  amount: string;
  createdBy: number;
}

/**
 * Records a REFUND line linked to the CHARGE it reverses (DEC-05: never
 * deletes or edits the original CHARGE). Does not itself verify the refund
 * amount against the charge's remaining balance, that the referenced
 * payment is actually a CHARGE on the same order, or that its own `method`
 * matches the charge's — those are business rules for the caller (ORD-10)
 * to enforce, not something this table's shape can guarantee.
 */
export async function recordRefund(
  db: Queryable,
  locationId: number,
  input: RecordRefundInput,
): Promise<PaymentRow> {
  const {
    rows: [payment],
  } = await db.query<PaymentRow>(
    `INSERT INTO payments (location_id, order_id, type, method, amount, refunded_payment_id, created_by)
     VALUES ($1, $2, 'REFUND', $3, $4, $5, $6)
     RETURNING id, location_id, order_id, type, method, amount, refunded_payment_id, created_by, created_at`,
    [
      locationId,
      input.orderId,
      input.method,
      input.amount,
      input.refundedPaymentId,
      input.createdBy,
    ],
  );
  return payment;
}

export async function listPaymentsForOrder(
  db: Queryable,
  locationId: number,
  orderId: number,
): Promise<PaymentRow[]> {
  const { rows } = await db.query<PaymentRow>(
    `SELECT id, location_id, order_id, type, method, amount, refunded_payment_id, created_by, created_at
     FROM payments
     WHERE location_id = $1 AND order_id = $2
     ORDER BY created_at`,
    [locationId, orderId],
  );
  return rows;
}

export interface NetPayments {
  cash: string;
  card: string;
}

/**
 * SALE-02's "charges nettes vérifiables" acceptance criterion, made
 * concrete: CHARGE minus REFUND, per method, for one order. This is also
 * the shape CASH-04's expected-cash formula ("fond initial + ventes
 * espèces nettes + entrées - sorties") will need — computed here once
 * rather than re-derived ad hoc at every call site.
 */
export async function getNetPaymentsForOrder(
  db: Queryable,
  locationId: number,
  orderId: number,
): Promise<NetPayments> {
  const { rows } = await db.query<{ method: PaymentLineMethod; net: string }>(
    `SELECT method,
            COALESCE(SUM(CASE WHEN type = 'CHARGE' THEN amount ELSE -amount END), 0)::DECIMAL(10, 2) AS net
     FROM payments
     WHERE location_id = $1 AND order_id = $2
     GROUP BY method`,
    [locationId, orderId],
  );
  const byMethod = new Map(rows.map((row) => [row.method, row.net]));
  return {
    cash: byMethod.get("CASH") ?? "0.00",
    card: byMethod.get("CARD") ?? "0.00",
  };
}
