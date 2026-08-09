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
  /** ORD-08: the author by name, so a history row does not need a second lookup. */
  created_by_name: string | null;
  /** ORD-11: what the discount took off, or null when there was none. */
  discount_amount: string | null;
  notes: string | null;
  created_at: string;
  paid_at: string | null;
  cancelled_at: string | null;
  refunded_at: string | null;
}

export interface OrderHistoryFilters {
  /** Terminal statuses only; `OPEN` is never history (see below). */
  status?: "PAID" | "CANCELLED" | "REFUNDED";
  /** Inclusive lower bound on when the order reached its terminal state. */
  from?: string;
  /** Exclusive upper bound. */
  to?: string;
  limit: number;
  offset: number;
}

export interface OrderHistoryPage {
  orders: OrderListRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * ORD-12: the establishment's sales history — filterable, paginated, and
 * counted.
 *
 * `OPEN` tickets are excluded deliberately. Before ORD-02 no order could be
 * open, so listing every status was harmless; now a ticket being typed at a
 * table would appear in the Bilan's "dernières commandes" — a running total
 * with no payment method, sitting among real sales, under a heading that
 * says "encaissée". A ticket in progress is not history.
 *
 * Ordered and filtered on `settled_at`, the moment the order reached its
 * terminal state, rather than on `created_at`: a ticket opened before
 * midnight and paid after it belongs to the day it was paid, which is the
 * question a history screen is actually asking.
 *
 * `total` is returned alongside the page because a paginator that cannot
 * say how many rows there are can only offer "next" — never "3 of 12".
 */
export async function listOrderHistory(
  db: Queryable,
  locationId: number,
  filters: OrderHistoryFilters,
): Promise<OrderHistoryPage> {
  const conditions = ["o.location_id = $1", "o.status <> 'OPEN'"];
  const values: unknown[] = [locationId];

  if (filters.status) {
    values.push(filters.status);
    conditions.push(`o.status = $${values.length}`);
  }
  if (filters.from) {
    values.push(filters.from);
    conditions.push(`COALESCE(o.paid_at, o.cancelled_at, o.created_at) >= $${values.length}`);
  }
  if (filters.to) {
    values.push(filters.to);
    conditions.push(`COALESCE(o.paid_at, o.cancelled_at, o.created_at) < $${values.length}`);
  }
  const where = conditions.join(" AND ");

  const { rows: countRows } = await db.query<{ total: string }>(
    `SELECT COUNT(*)::TEXT AS total FROM orders o WHERE ${where}`,
    values,
  );

  const { rows } = await db.query<OrderListRow>(
    `SELECT o.id, o.order_number, o.table_id, t.name AS table_name, o.status, o.payment_method,
            o.cash_amount, o.card_amount, o.total_amount, o.subtotal_amount, o.tax_amount,
            o.discount_amount, o.created_by, u.name AS created_by_name, o.notes, o.created_at,
            o.paid_at, o.cancelled_at, o.refunded_at
     FROM orders o
     LEFT JOIN dining_tables t ON t.id = o.table_id AND t.location_id = o.location_id
     LEFT JOIN users u ON u.id = o.created_by
     WHERE ${where}
     ORDER BY COALESCE(o.paid_at, o.cancelled_at, o.created_at) DESC, o.id DESC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, filters.limit, filters.offset],
  );

  return {
    orders: rows,
    total: Number(countRows[0].total),
    limit: filters.limit,
    offset: filters.offset,
  };
}

/** Convenience wrapper kept for callers that only want the most recent page. */
export async function listOrders(
  db: Queryable,
  locationId: number,
  limit = 100,
): Promise<OrderListRow[]> {
  const page = await listOrderHistory(db, locationId, { limit, offset: 0 });
  return page.orders;
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
