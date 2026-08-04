import type { Queryable } from "../db";
import { NotFoundError } from "../errors";

export type DiningTableStatus = "FREE" | "OCCUPIED";

export interface DiningTableRow {
  id: number;
  name: string;
  status: DiningTableStatus;
}

export async function listDiningTables(
  db: Queryable,
  locationId: number,
): Promise<DiningTableRow[]> {
  const { rows } = await db.query<DiningTableRow>(
    "SELECT id, name, status FROM dining_tables WHERE location_id = $1 ORDER BY id",
    [locationId],
  );
  return rows;
}

export async function createDiningTable(
  db: Queryable,
  locationId: number,
  name: string,
): Promise<DiningTableRow> {
  const {
    rows: [row],
  } = await db.query<DiningTableRow>(
    "INSERT INTO dining_tables (location_id, name) VALUES ($1, $2) RETURNING id, name, status",
    [locationId, name],
  );
  return row;
}

/** CFG-03 (phase 4B) territory: renaming is a floor-plan configuration change, gated by "tables:manage". */
export async function renameDiningTable(
  db: Queryable,
  locationId: number,
  tableId: number,
  name: string,
): Promise<DiningTableRow> {
  const { rows } = await db.query<DiningTableRow>(
    "UPDATE dining_tables SET name = $3 WHERE id = $1 AND location_id = $2 RETURNING id, name, status",
    [tableId, locationId, name],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("Table introuvable.");
  return row;
}

/**
 * Flipping FREE/OCCUPIED is routine service activity, not floor-plan
 * configuration, so it is gated by "orders:create" at the route level, not
 * "tables:manage". ORD-03 (phase 4A) will derive this status from open
 * orders instead of a direct write; this stays a plain column update until
 * then.
 */
export async function setDiningTableStatus(
  db: Queryable,
  locationId: number,
  tableId: number,
  status: DiningTableStatus,
): Promise<DiningTableRow> {
  const { rows } = await db.query<DiningTableRow>(
    "UPDATE dining_tables SET status = $3 WHERE id = $1 AND location_id = $2 RETURNING id, name, status",
    [tableId, locationId, status],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("Table introuvable.");
  return row;
}
