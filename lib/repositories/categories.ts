import type { Queryable } from "../db";
import { NotFoundError } from "../errors";

export interface CategoryRow {
  id: number;
  name: string;
  /** CFG-02/DEC-05: the class a product inherits when it has none of its own. */
  tax_class_id: number | null;
}

/** SEC-06: every query is scoped by location_id; there is no "list all categories" anywhere. */
export async function listCategories(db: Queryable, locationId: number): Promise<CategoryRow[]> {
  const { rows } = await db.query<CategoryRow>(
    "SELECT id, name, tax_class_id FROM categories WHERE location_id = $1 ORDER BY name",
    [locationId],
  );
  return rows;
}

/** CFG-02: creating and renaming categories, and setting the tax class they pass down (DEC-05's fallback). */
export interface CategoryInput {
  name: string;
  taxClassId: number | null;
}

export async function createCategory(
  db: Queryable,
  locationId: number,
  input: CategoryInput,
): Promise<CategoryRow> {
  const {
    rows: [row],
  } = await db.query<CategoryRow>(
    `INSERT INTO categories (location_id, name, tax_class_id) VALUES ($1, $2, $3)
     RETURNING id, name, tax_class_id`,
    [locationId, input.name, input.taxClassId],
  );
  return row;
}

export async function updateCategory(
  db: Queryable,
  locationId: number,
  categoryId: number,
  input: CategoryInput,
): Promise<CategoryRow> {
  const { rows } = await db.query<CategoryRow>(
    `UPDATE categories SET name = $3, tax_class_id = $4
     WHERE id = $1 AND location_id = $2
     RETURNING id, name, tax_class_id`,
    [categoryId, locationId, input.name, input.taxClassId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("Catégorie introuvable.");
  return row;
}
