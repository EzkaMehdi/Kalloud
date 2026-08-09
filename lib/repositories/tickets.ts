import type { Queryable } from "../db";
import { ConflictError, NotFoundError } from "../errors";

/**
 * ORD-02: reading and writing `OPEN` orders — the ticket a table carries
 * while it is being served, before any payment exists.
 *
 * Kept apart from lib/repositories/orders.ts, which answers "what has this
 * establishment sold" (a finished, immutable record). A ticket is the
 * opposite: mutable, unpaid, and the only order state whose contents change
 * after creation.
 */

export interface TicketItemRow {
  id: number;
  product_id: number;
  product_name: string;
  quantity: number;
  unit_price: string;
  notes: string | null;
  /** Live catalog availability, so a ticket resumed after a rupture shows it (SALE-07). */
  is_available: boolean;
}

export interface TicketDiscount {
  type: "FIXED" | "PERCENT";
  /** As entered: a cent amount for FIXED, hundredths of a percent for PERCENT. */
  value: string;
  /** What it actually took off this order, in euros — see migration 0014. */
  amount: string;
  reason: string;
}

export interface TicketRow {
  id: number;
  order_number: number;
  location_id: number;
  table_id: number | null;
  table_name: string | null;
  business_day_id: number | null;
  status: string;
  total_amount: string;
  notes: string | null;
  created_by: number | null;
  created_by_name: string | null;
  version: number;
  created_at: string;
  discount_type: "FIXED" | "PERCENT" | null;
  discount_value: string | null;
  discount_amount: string | null;
  discount_reason: string | null;
}

export interface Ticket extends TicketRow {
  items: TicketItemRow[];
}

const TICKET_SELECT = `
  SELECT o.id, o.order_number, o.location_id, o.table_id, t.name AS table_name,
         o.business_day_id, o.status, o.total_amount, o.notes, o.created_by,
         u.name AS created_by_name, o.version, o.created_at,
         o.discount_type, o.discount_value, o.discount_amount, o.discount_reason
  FROM orders o
  LEFT JOIN dining_tables t ON t.id = o.table_id AND t.location_id = o.location_id
  LEFT JOIN users u ON u.id = o.created_by
`;

export async function findOpenTicketForTable(
  db: Queryable,
  locationId: number,
  tableId: number,
): Promise<TicketRow | null> {
  const { rows } = await db.query<TicketRow>(
    `${TICKET_SELECT} WHERE o.location_id = $1 AND o.table_id = $2 AND o.status = 'OPEN'`,
    [locationId, tableId],
  );
  return rows[0] ?? null;
}

export async function findTicketById(
  db: Queryable,
  locationId: number,
  orderId: number,
): Promise<TicketRow | null> {
  const { rows } = await db.query<TicketRow>(
    `${TICKET_SELECT} WHERE o.location_id = $1 AND o.id = $2`,
    [locationId, orderId],
  );
  return rows[0] ?? null;
}

/**
 * Locks the ticket row for the rest of the transaction. Every mutation goes
 * through this first: the optimistic version check that follows is only
 * meaningful if no one else can slip a write in between reading the version
 * and bumping it.
 */
export async function lockTicket(
  db: Queryable,
  locationId: number,
  orderId: number,
): Promise<{ id: number; status: string; version: number } | null> {
  const { rows } = await db.query<{ id: number; status: string; version: number }>(
    "SELECT id, status, version FROM orders WHERE location_id = $1 AND id = $2 FOR UPDATE",
    [locationId, orderId],
  );
  return rows[0] ?? null;
}

export async function listTicketItems(db: Queryable, orderId: number): Promise<TicketItemRow[]> {
  const { rows } = await db.query<TicketItemRow>(
    `SELECT oi.id, oi.product_id, p.name AS product_name, oi.quantity, oi.unit_price, oi.notes,
            (p.is_active AND p.stock_quantity > 0) AS is_available
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1
     ORDER BY oi.id`,
    [orderId],
  );
  return rows;
}

export async function loadTicket(
  db: Queryable,
  locationId: number,
  orderId: number,
): Promise<Ticket | null> {
  const ticket = await findTicketById(db, locationId, orderId);
  if (!ticket) return null;
  return { ...ticket, items: await listTicketItems(db, orderId) };
}

export interface CreateTicketInput {
  tableId: number | null;
  businessDayId: number;
  orderNumber: number;
  createdBy: number;
}

/**
 * Creates an empty `OPEN` order. Totals start at zero because the ticket has
 * no lines yet — an honest zero, unlike the fiscal snapshot columns, which
 * stay NULL until SALE-03 computes them at payment (see migration 0006).
 */
export async function createOpenTicket(
  db: Queryable,
  locationId: number,
  input: CreateTicketInput,
): Promise<TicketRow> {
  const {
    rows: [row],
  } = await db.query<{ id: number }>(
    `INSERT INTO orders (location_id, table_id, business_day_id, order_number, created_by, status, total_amount)
     VALUES ($1, $2, $3, $4, $5, 'OPEN', '0.00')
     RETURNING id`,
    [locationId, input.tableId, input.businessDayId, input.orderNumber, input.createdBy],
  );
  const ticket = await findTicketById(db, locationId, row.id);
  if (!ticket) throw new NotFoundError("Ticket introuvable après création.");
  return ticket;
}

export interface TicketItemInput {
  productId: number;
  quantity: number;
  unitPrice: string;
  notes: string | null;
}

/**
 * Replaces a ticket's lines wholesale, then bumps its version.
 *
 * A whole-ticket replace rather than per-line add/remove endpoints: the
 * cashier's unit of work is "the ticket as it now stands", and one atomic
 * write against one version is what makes ORD-05's conflict rule
 * ("deux appareils ne s'écrasent pas silencieusement") checkable at all —
 * three separate line mutations would each need their own version dance and
 * could still interleave into a state neither device asked for.
 */
export async function replaceTicketItems(
  db: Queryable,
  orderId: number,
  items: TicketItemInput[],
): Promise<void> {
  await db.query("DELETE FROM order_items WHERE order_id = $1", [orderId]);
  for (const item of items) {
    await db.query(
      "INSERT INTO order_items (order_id, product_id, quantity, unit_price, notes) VALUES ($1, $2, $3, $4, $5)",
      [orderId, item.productId, item.quantity, item.unitPrice, item.notes],
    );
  }
}

/**
 * Bumps the version, refusing the write when the caller's expected version
 * is stale. Returns the new version.
 *
 * The `WHERE version = $3` is the whole mechanism: a device that loaded the
 * ticket at version 4, while another already saved version 5, matches zero
 * rows and is told to reload — rather than having its stale line list
 * silently become the truth (DEC-08's "aucune donnée locale n'écrase
 * silencieusement une donnée serveur plus récente").
 */
export async function bumpTicketVersion(
  db: Queryable,
  locationId: number,
  orderId: number,
  expectedVersion: number,
): Promise<number> {
  const { rows } = await db.query<{ version: number }>(
    `UPDATE orders SET version = version + 1
     WHERE location_id = $1 AND id = $2 AND version = $3
     RETURNING version`,
    [locationId, orderId, expectedVersion],
  );
  const row = rows[0];
  if (!row) {
    throw new ConflictError(
      "Ce ticket a été modifié depuis un autre appareil. Rechargez-le pour repartir de l'état à jour.",
    );
  }
  return row.version;
}

/**
 * ORD-06: `OPEN` -> `CANCELLED`, with the motive kept on the row.
 *
 * Guarded on `status = 'OPEN'` in the UPDATE itself, not just by a prior
 * read: that is what makes it impossible to cancel an order that was paid a
 * moment ago by another device. Nothing is deleted — the ticket stays in
 * history with its lines, which is what "ticket conservé en historique"
 * asks for.
 */
export async function cancelTicket(
  db: Queryable,
  locationId: number,
  orderId: number,
  reason: string,
): Promise<TicketRow> {
  const { rows } = await db.query<{ id: number }>(
    `UPDATE orders
     SET status = 'CANCELLED', cancelled_at = now(), cancellation_reason = $3,
         version = version + 1
     WHERE location_id = $1 AND id = $2 AND status = 'OPEN'
     RETURNING id`,
    [locationId, orderId, reason],
  );
  if (!rows[0]) {
    throw new NotFoundError("Ticket ouvert introuvable.");
  }
  const ticket = await findTicketById(db, locationId, orderId);
  if (!ticket) throw new NotFoundError("Ticket introuvable.");
  return ticket;
}

/**
 * Open counter tickets — direct sales, which belong to no table and so
 * cannot be found on the floor plan.
 *
 * Without this they would be invisible: opened, abandoned, and impossible
 * to reach again or cancel. ORD-07's "un seul parcours" means the counter
 * needs the same "reprendre un ticket" affordance a table already has.
 */
export async function listOpenCounterTickets(
  db: Queryable,
  locationId: number,
): Promise<TicketRow[]> {
  const { rows } = await db.query<TicketRow>(
    `${TICKET_SELECT} WHERE o.location_id = $1 AND o.status = 'OPEN' AND o.table_id IS NULL
     ORDER BY o.created_at`,
    [locationId],
  );
  return rows;
}

/**
 * ORD-11: stores (or clears) the order's discount. All four columns move
 * together — migration 0014's CHECK refuses any other combination.
 */
export async function setTicketDiscount(
  db: Queryable,
  locationId: number,
  orderId: number,
  discount: { type: string; value: string; amount: string; reason: string } | null,
): Promise<void> {
  await db.query(
    `UPDATE orders
     SET discount_type = $3, discount_value = $4, discount_amount = $5, discount_reason = $6
     WHERE location_id = $1 AND id = $2`,
    [
      locationId,
      orderId,
      discount?.type ?? null,
      discount?.value ?? null,
      discount?.amount ?? null,
      discount?.reason ?? null,
    ],
  );
}

/** ORD-08: stores the order's own note. `null` clears it. */
export async function setTicketNotes(
  db: Queryable,
  locationId: number,
  orderId: number,
  notes: string | null,
): Promise<void> {
  await db.query("UPDATE orders SET notes = $3 WHERE location_id = $1 AND id = $2", [
    locationId,
    orderId,
    notes,
  ]);
}

/** Recomputes and stores the running total from the ticket's own lines. */
export async function refreshTicketTotal(
  db: Queryable,
  locationId: number,
  orderId: number,
): Promise<string> {
  const { rows } = await db.query<{ total_amount: string }>(
    `UPDATE orders
     SET total_amount = COALESCE(
       (SELECT SUM(quantity * unit_price) FROM order_items WHERE order_id = $2), 0
     )
     WHERE location_id = $1 AND id = $2
     RETURNING total_amount`,
    [locationId, orderId],
  );
  return rows[0].total_amount;
}
