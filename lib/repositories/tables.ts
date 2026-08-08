import type { Queryable } from "../db";
import { NotFoundError } from "../errors";

/**
 * ORD-03: occupancy is derived, never stored. `dining_tables.status` was
 * dropped in migration 0011 — a table is occupied exactly when it carries an
 * open ticket, which is what `open_order_id` answers. Callers should read
 * that field rather than reintroduce a boolean of their own.
 */
export interface DiningTableRow {
  id: number;
  name: string;
  /** The table's live ticket, or null when it is free. At most one, enforced by `one_open_order_per_table`. */
  open_order_id: number | null;
  /** Convenience mirror of `open_order_id !== null`, so clients do not each re-derive it. */
  is_occupied: boolean;
  /** Running total of the open ticket, as a DECIMAL string; null when free. */
  open_order_total: string | null;
}

const TABLE_WITH_OPEN_ORDER = `
  SELECT t.id, t.name,
         o.id AS open_order_id,
         (o.id IS NOT NULL) AS is_occupied,
         o.total_amount AS open_order_total
  FROM dining_tables t
  LEFT JOIN orders o
    ON o.table_id = t.id
   AND o.location_id = t.location_id
   AND o.status = 'OPEN'
`;

export async function listDiningTables(
  db: Queryable,
  locationId: number,
): Promise<DiningTableRow[]> {
  const { rows } = await db.query<DiningTableRow>(
    `${TABLE_WITH_OPEN_ORDER} WHERE t.location_id = $1 ORDER BY t.id`,
    [locationId],
  );
  return rows;
}

export async function findDiningTable(
  db: Queryable,
  locationId: number,
  tableId: number,
): Promise<DiningTableRow | null> {
  const { rows } = await db.query<DiningTableRow>(
    `${TABLE_WITH_OPEN_ORDER} WHERE t.location_id = $1 AND t.id = $2`,
    [locationId, tableId],
  );
  return rows[0] ?? null;
}

export async function createDiningTable(
  db: Queryable,
  locationId: number,
  name: string,
): Promise<DiningTableRow> {
  const {
    rows: [row],
  } = await db.query<{ id: number; name: string }>(
    "INSERT INTO dining_tables (location_id, name) VALUES ($1, $2) RETURNING id, name",
    [locationId, name],
  );
  // A table cannot be born occupied, so this needs no round-trip to re-derive.
  return { ...row, open_order_id: null, is_occupied: false, open_order_total: null };
}

/** CFG-03 (phase 4B) territory: renaming is a floor-plan configuration change, gated by "tables:manage". */
export async function renameDiningTable(
  db: Queryable,
  locationId: number,
  tableId: number,
  name: string,
): Promise<DiningTableRow> {
  const { rows } = await db.query<{ id: number }>(
    "UPDATE dining_tables SET name = $3 WHERE id = $1 AND location_id = $2 RETURNING id",
    [tableId, locationId, name],
  );
  if (!rows[0]) throw new NotFoundError("Table introuvable.");
  const table = await findDiningTable(db, locationId, tableId);
  if (!table) throw new NotFoundError("Table introuvable.");
  return table;
}
