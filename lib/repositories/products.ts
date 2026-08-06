import type { Queryable } from "../db";
import { NotFoundError } from "../errors";

/**
 * Field names intentionally mirror the pre-existing API shape (snake_case,
 * `category` as a joined display name) so the caisse/stock frontends need
 * only their fetch URLs updated in this phase (FND-08); a redesigned,
 * validated contract is API-01 in phase 3.
 */
export interface ProductRow {
  id: number;
  category_id: number | null;
  name: string;
  price: string;
  stock_quantity: number;
  alert_threshold: number;
  is_active: boolean;
  category: string | null;
}

export async function listProducts(db: Queryable, locationId: number): Promise<ProductRow[]> {
  const { rows } = await db.query<ProductRow>(
    `SELECT p.id, p.category_id, p.name, p.price, p.stock_quantity, p.alert_threshold, p.is_active,
            c.name AS category
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.location_id = $1
     ORDER BY p.name`,
    [locationId],
  );
  return rows;
}

export interface CreateProductInput {
  categoryId: number | null;
  name: string;
  price: string;
  stockQuantity?: number;
  alertThreshold?: number;
}

export async function createProduct(
  db: Queryable,
  locationId: number,
  input: CreateProductInput,
): Promise<ProductRow> {
  const {
    rows: [row],
  } = await db.query<Omit<ProductRow, "category">>(
    `INSERT INTO products (location_id, category_id, name, price, stock_quantity, alert_threshold)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, category_id, name, price, stock_quantity, alert_threshold, is_active`,
    [
      locationId,
      input.categoryId,
      input.name,
      input.price,
      input.stockQuantity ?? 0,
      input.alertThreshold ?? 5,
    ],
  );
  return { ...row, category: null };
}

export interface UpdateProductInput {
  name?: string;
  price?: string;
  stockQuantity?: number;
  alertThreshold?: number;
  isActive?: boolean;
}

export async function updateProduct(
  db: Queryable,
  locationId: number,
  productId: number,
  input: UpdateProductInput,
): Promise<ProductRow> {
  const { rows } = await db.query<Omit<ProductRow, "category">>(
    `UPDATE products
     SET name = COALESCE($3, name),
         price = COALESCE($4, price),
         stock_quantity = COALESCE($5, stock_quantity),
         alert_threshold = COALESCE($6, alert_threshold),
         is_active = COALESCE($7, is_active)
     WHERE id = $1 AND location_id = $2
     RETURNING id, category_id, name, price, stock_quantity, alert_threshold, is_active`,
    [
      productId,
      locationId,
      input.name ?? null,
      input.price ?? null,
      input.stockQuantity ?? null,
      input.alertThreshold ?? null,
      input.isActive ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("Produit introuvable.");
  return { ...row, category: null };
}

/**
 * TODO(STK-04, phase 5B): this is the prototype's absolute stock write,
 * kept only so the stock page keeps working through phase 2. It will be
 * removed in favour of a signed, motivated stock_movements ledger entry —
 * this function must not gain new callers in the meantime.
 */
export async function overwriteProductStockQuantity(
  db: Queryable,
  locationId: number,
  productId: number,
  quantity: number,
): Promise<ProductRow> {
  const { rows } = await db.query<Omit<ProductRow, "category">>(
    `UPDATE products SET stock_quantity = $3 WHERE id = $1 AND location_id = $2
     RETURNING id, category_id, name, price, stock_quantity, alert_threshold, is_active`,
    [productId, locationId, quantity],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("Produit introuvable.");
  return { ...row, category: null };
}

export interface LockedProduct {
  id: number;
  name: string;
  price: string;
  stockQuantity: number;
}

/** Locks the row (FOR UPDATE) so concurrent checkouts cannot both oversell the same unit of stock. */
export async function lockActiveProductForCheckout(
  db: Queryable,
  locationId: number,
  productId: number,
): Promise<LockedProduct | null> {
  const { rows } = await db.query<{
    id: number;
    name: string;
    price: string;
    stock_quantity: number;
  }>(
    "SELECT id, name, price, stock_quantity FROM products WHERE id = $1 AND location_id = $2 AND is_active = true FOR UPDATE",
    [productId, locationId],
  );
  const row = rows[0];
  return row
    ? { id: row.id, name: row.name, price: row.price, stockQuantity: row.stock_quantity }
    : null;
}

/**
 * STK-03: same lock, same is_active filter as lockActiveProductForCheckout
 * above — but that function belongs to checkout.ts's own known-prototype
 * flow (TODO(SALE-03) on decrementProductStock explains why it stays
 * untouched) and its name says so. This is the equivalent for
 * lib/services/stock.ts's general-purpose decrement service, so a reader
 * doesn't have to wonder whether reusing "ForCheckout" here means the two
 * are secretly coupled — they are not.
 */
export async function lockActiveProductForStockOperation(
  db: Queryable,
  locationId: number,
  productId: number,
): Promise<LockedProduct | null> {
  const { rows } = await db.query<{
    id: number;
    name: string;
    price: string;
    stock_quantity: number;
  }>(
    "SELECT id, name, price, stock_quantity FROM products WHERE id = $1 AND location_id = $2 AND is_active = true FOR UPDATE",
    [productId, locationId],
  );
  const row = rows[0];
  return row
    ? { id: row.id, name: row.name, price: row.price, stockQuantity: row.stock_quantity }
    : null;
}

/**
 * TODO(SALE-03): called only by checkout.ts's known-prototype payment flow
 * (see that module's own doc comment on P0-02). It updates
 * `products.stock_quantity` without writing a matching `stock_movements`
 * row, so `stock_quantity == SUM(stock_movements.quantity)` (DEC-06,
 * STK-01) does not hold for a product sold through it — a gap DEC-06 itself
 * assigns to SALE-03 ("SALE" movement trigger), not STK-01/STK-03. This
 * function must not gain new callers before SALE-03 replaces it with
 * lib/repositories/stock-movements.ts::recordStockMovement.
 */
export async function decrementProductStock(
  db: Queryable,
  locationId: number,
  productId: number,
  quantity: number,
): Promise<void> {
  await db.query(
    "UPDATE products SET stock_quantity = stock_quantity - $3 WHERE id = $1 AND location_id = $2",
    [productId, locationId, quantity],
  );
}
