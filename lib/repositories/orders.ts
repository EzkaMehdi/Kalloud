import type { Queryable } from "../db";

export interface OrderListRow {
  id: number;
  table_id: number | null;
  table_name: string | null;
  status: string;
  payment_method: string | null;
  cash_amount: string;
  card_amount: string;
  total_amount: string;
  created_at: string;
  closed_at: string | null;
}

export async function listOrders(
  db: Queryable,
  locationId: number,
  limit = 100,
): Promise<OrderListRow[]> {
  const { rows } = await db.query<OrderListRow>(
    `SELECT o.id, o.table_id, t.name AS table_name, o.status, o.payment_method,
            o.cash_amount, o.card_amount, o.total_amount, o.created_at, o.closed_at
     FROM orders o
     LEFT JOIN dining_tables t ON t.id = o.table_id
     WHERE o.location_id = $1
     ORDER BY o.created_at DESC
     LIMIT $2`,
    [locationId, limit],
  );
  return rows;
}
