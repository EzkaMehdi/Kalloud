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

export interface PaymentHistoryRow extends PaymentRow {
  order_number: number;
}

export interface PaymentHistoryFilters {
  /** Inclusive lower bound on `created_at`. */
  from?: string;
  /** Exclusive upper bound. */
  to?: string;
  method?: PaymentLineMethod;
  type?: PaymentType;
  limit: number;
  offset: number;
}

export interface PaymentHistoryPage {
  payments: PaymentHistoryRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * BI-02: "paiements" — every CHARGE and REFUND line across the
 * establishment, filterable and paginated. `listPaymentsForOrder` (SALE-02)
 * answers "what settled this one order"; this answers "what moved through
 * the till this month", the question a cockpit's payments drill-down asks.
 */
export async function listPaymentsHistory(
  db: Queryable,
  locationId: number,
  filters: PaymentHistoryFilters,
): Promise<PaymentHistoryPage> {
  const conditions = ["p.location_id = $1"];
  const values: unknown[] = [locationId];

  if (filters.from) {
    values.push(filters.from);
    conditions.push(`p.created_at >= $${values.length}`);
  }
  if (filters.to) {
    values.push(filters.to);
    conditions.push(`p.created_at < $${values.length}`);
  }
  if (filters.method) {
    values.push(filters.method);
    conditions.push(`p.method = $${values.length}`);
  }
  if (filters.type) {
    values.push(filters.type);
    conditions.push(`p.type = $${values.length}`);
  }
  const where = conditions.join(" AND ");

  const { rows: countRows } = await db.query<{ total: string }>(
    `SELECT COUNT(*)::TEXT AS total FROM payments p WHERE ${where}`,
    values,
  );

  const { rows } = await db.query<PaymentHistoryRow>(
    `SELECT p.id, p.location_id, p.order_id, o.order_number, p.type, p.method, p.amount,
            p.refunded_payment_id, p.created_by, p.created_at
     FROM payments p
     JOIN orders o ON o.id = p.order_id AND o.location_id = p.location_id
     WHERE ${where}
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, filters.limit, filters.offset],
  );

  return {
    payments: rows,
    total: Number(countRows[0].total),
    limit: filters.limit,
    offset: filters.offset,
  };
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
