import type { Queryable } from "../db";
import { ConflictError, NotFoundError } from "../errors";

/**
 * ORD-03: occupancy is derived, never stored. `dining_tables.status` was
 * dropped in migration 0011 — a table is occupied exactly when it carries an
 * open ticket, which is what `open_order_id` answers. Callers should read
 * that field rather than reintroduce a boolean of their own.
 */
export interface DiningTableRow {
  id: number;
  name: string;
  /** CFG-03: a deactivated table keeps its history but leaves the floor plan. */
  is_active: boolean;
  display_order: number;
  /** The table's live ticket, or null when it is free. At most one, enforced by `one_open_order_per_table`. */
  open_order_id: number | null;
  /** Convenience mirror of `open_order_id !== null`, so clients do not each re-derive it. */
  is_occupied: boolean;
  /** Running total of the open ticket, as a DECIMAL string; null when free. */
  open_order_total: string | null;
}

const TABLE_WITH_OPEN_ORDER = `
  SELECT t.id, t.name, t.is_active, t.display_order,
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
    `${TABLE_WITH_OPEN_ORDER} WHERE t.location_id = $1 AND t.is_active ORDER BY t.display_order, t.id`,
    [locationId],
  );
  return rows;
}

/** CFG-03: everything the configuration screen manages, deactivated tables included. */
export async function listAllDiningTables(
  db: Queryable,
  locationId: number,
): Promise<DiningTableRow[]> {
  const { rows } = await db.query<DiningTableRow>(
    `${TABLE_WITH_OPEN_ORDER} WHERE t.location_id = $1 ORDER BY t.display_order, t.id`,
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
  } = await db.query<{ id: number; name: string; is_active: boolean; display_order: number }>(
    `INSERT INTO dining_tables (location_id, name, display_order)
     VALUES ($1, $2, COALESCE((SELECT MAX(display_order) + 1 FROM dining_tables WHERE location_id = $1), 0))
     RETURNING id, name, is_active, display_order`,
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

/**
 * CFG-03: activates or deactivates a table.
 *
 * Deactivating one that still carries an open ticket is refused — that is
 * the acceptance criterion, "impossibilité de désactiver silencieusement une
 * table avec ticket ouvert". Checked inside the same statement rather than
 * by a prior read, so a ticket opened a moment ago by another device cannot
 * slip through the gap.
 */
export async function setDiningTableActive(
  db: Queryable,
  locationId: number,
  tableId: number,
  isActive: boolean,
): Promise<DiningTableRow> {
  const { rows } = await db.query<{ id: number }>(
    `UPDATE dining_tables t
     SET is_active = $3
     WHERE t.id = $1 AND t.location_id = $2
       AND ($3 = TRUE OR NOT EXISTS (
         SELECT 1 FROM orders o
         WHERE o.table_id = t.id AND o.location_id = t.location_id AND o.status = 'OPEN'
       ))
     RETURNING t.id`,
    [tableId, locationId, isActive],
  );
  if (!rows[0]) {
    const existing = await findDiningTable(db, locationId, tableId);
    if (!existing) throw new NotFoundError("Table introuvable.");
    throw new ConflictError(
      "Cette table porte un ticket ouvert : encaissez-le ou annulez-le avant de la désactiver.",
    );
  }
  const table = await findDiningTable(db, locationId, tableId);
  if (!table) throw new NotFoundError("Table introuvable.");
  return table;
}

/** CFG-03: reorders the floor plan. The order given is the order stored. */
export async function reorderDiningTables(
  db: Queryable,
  locationId: number,
  orderedIds: number[],
): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    const { rowCount } = await db.query(
      "UPDATE dining_tables SET display_order = $3 WHERE id = $1 AND location_id = $2",
      [id, locationId, index],
    );
    if (!rowCount) {
      // An id from another establishment, or one that does not exist: the
      // whole reorder is refused rather than partially applied.
      throw new NotFoundError("Table introuvable.");
    }
  }
}
