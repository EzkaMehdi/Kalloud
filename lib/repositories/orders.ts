import type { Queryable } from "../db";

export interface OrderListRow {
  id: number;
  order_number: number;
  table_id: number | null;
  table_name: string | null;
  status: string;
  payment_method: string | null;
  cash_amount: string;
  card_amount: string;
  total_amount: string;
  subtotal_amount: string | null;
  tax_amount: string | null;
  /**
   * NULL only for orders that predate ORD-01, whose author the prototype
   * never recorded (see migrations/0006). Every order the application
   * creates has one, and the database enforces it for any row carrying a
   * fiscal snapshot.
   */
  created_by: number | null;
  notes: string | null;
  created_at: string;
  paid_at: string | null;
  cancelled_at: string | null;
  refunded_at: string | null;
}

export async function listOrders(
  db: Queryable,
  locationId: number,
  limit = 100,
): Promise<OrderListRow[]> {
  const { rows } = await db.query<OrderListRow>(
    `SELECT o.id, o.order_number, o.table_id, t.name AS table_name, o.status, o.payment_method,
            o.cash_amount, o.card_amount, o.total_amount, o.subtotal_amount, o.tax_amount,
            o.created_by, o.notes, o.created_at, o.paid_at, o.cancelled_at, o.refunded_at
     FROM orders o
     LEFT JOIN dining_tables t ON t.id = o.table_id
     WHERE o.location_id = $1
     ORDER BY o.created_at DESC
     LIMIT $2`,
    [locationId, limit],
  );
  return rows;
}

/**
 * Hands out the next order number for a location, starting at 1 and never
 * reused or reset (ORD-01). Backed by a dedicated counter row rather than a
 * Postgres SEQUENCE because a SEQUENCE cannot be scoped per location_id.
 *
 * The `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` is what makes this
 * race-free without an explicit `FOR UPDATE`: two concurrent checkouts for
 * the same location both attempt the insert, one is turned into the update
 * by the ON CONFLICT clause and waits behind the other's row lock, so no two
 * callers can ever read back the same `next_value` (proven by
 * tests/integration/orders.test.ts's concurrent-checkout case, not just
 * asserted here).
 *
 * Must be called inside the same transaction as the order INSERT that
 * consumes the returned number — see performCheckout — so a rolled-back
 * checkout does not "waste" a gap in the sequence for no reason (an
 * occasional gap from a genuinely failed transaction is fine; the counter
 * advancing on every retry attempt while the client is still deciding
 * whether to resubmit is not something we invite).
 */
export async function nextOrderNumber(db: Queryable, locationId: number): Promise<number> {
  const {
    rows: [row],
  } = await db.query<{ order_number: number }>(
    `INSERT INTO order_number_counters (location_id, next_value)
     VALUES ($1, 2)
     ON CONFLICT (location_id) DO UPDATE SET next_value = order_number_counters.next_value + 1
     RETURNING next_value - 1 AS order_number`,
    [locationId],
  );
  return row.order_number;
}
