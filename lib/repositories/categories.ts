import type { Queryable } from "../db";

export interface CategoryRow {
  id: number;
  name: string;
}

/** SEC-06: every query is scoped by location_id; there is no "list all categories" anywhere. */
export async function listCategories(db: Queryable, locationId: number): Promise<CategoryRow[]> {
  const { rows } = await db.query<CategoryRow>(
    "SELECT id, name FROM categories WHERE location_id = $1 ORDER BY name",
    [locationId],
  );
  return rows;
}
