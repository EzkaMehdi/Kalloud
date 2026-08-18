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

/**
 * SALE-01: the catalog shape `listProducts` returns — `ProductRow` plus the
 * fields the livrable asks for that a plain product row doesn't carry on
 * its own:
 * - `tax_rate_percent`/`tax_class_name`: the *effective* tax rule after
 *   DEC-05's fallback (product's own tax class → its category's → the
 *   establishment's default), resolved server-side so no client ever
 *   re-derives it differently.
 * - `unit`: DEC-06 fixes a single unit for the whole MVP ("la pièce"), so
 *   this is a constant, not a column — adding one now would model a degree
 *   of freedom the product deliberately doesn't have yet.
 * - `is_available`: distinct from `is_active`. `is_active` is the admin
 *   "still on the menu at all" switch; `is_available` additionally requires
 *   stock — SALE-07 needs both, separately, to show an out-of-stock item
 *   greyed out rather than hidden ("visible mais non ajoutable").
 */
export interface CatalogProductRow extends ProductRow {
  tax_rate_percent: string;
  tax_class_name: string | null;
  unit: "piece";
  is_available: boolean;
}

/**
 * DEC-05's tax fallback (product's own class → its category's → the
 * establishment's default), as a single shared join fragment rather than
 * duplicated SQL: `listProducts` (SALE-01, catalog display) and
 * `lockProductsForSale` (SALE-03, what a sale actually charges) must never
 * be able to resolve the same product to two different rates because one
 * of them drifted from the other.
 *
 * Scoped by `location_id` explicitly, in addition to `tax_class_id`, even
 * though `migrations/0003_business_core.sql` already carries composite
 * `FOREIGN KEY (tax_class_id, location_id)` constraints that guarantee a
 * product's or category's tax class always belongs to its own
 * establishment — enforced at the database level regardless of this join.
 * The extra condition is redundant with that constraint, kept only so the
 * SQL reads as tenant-scoped on its own, without a reader having to go
 * check the schema to know why it's safe.
 */
const TAX_RESOLUTION_JOIN = `
  LEFT JOIN categories c ON c.id = p.category_id AND c.location_id = p.location_id
  LEFT JOIN tax_classes ptc ON ptc.id = p.tax_class_id AND ptc.location_id = p.location_id
  LEFT JOIN tax_classes ctc ON ctc.id = c.tax_class_id AND ctc.location_id = p.location_id
  JOIN location_settings ls ON ls.location_id = p.location_id
`;

/**
 * The single source both the caisse and the stock screens read from
 * ("source unique pour caisse et stock", SALE-01's acceptance) — no filter
 * on `is_active`: a deactivated product must still be listed, with
 * `is_available: false`, for SALE-07's "visible mais non ajoutable" to be
 * satisfiable later without another change to this endpoint.
 */
export async function listProducts(
  db: Queryable,
  locationId: number,
): Promise<CatalogProductRow[]> {
  const { rows } = await db.query<CatalogProductRow>(
    `SELECT p.id, p.category_id, p.name, p.price, p.stock_quantity, p.alert_threshold, p.is_active,
            c.name AS category,
            COALESCE(ptc.rate, ctc.rate, ls.default_tax_rate) AS tax_rate_percent,
            COALESCE(ptc.name, ctc.name) AS tax_class_name,
            'piece' AS unit,
            (p.is_active AND p.stock_quantity > 0) AS is_available
     FROM products p
     ${TAX_RESOLUTION_JOIN}
     WHERE p.location_id = $1
     ORDER BY p.name`,
    [locationId],
  );
  return rows;
}

export interface StockAlertCounts {
  out_of_stock: number;
  low_stock: number;
}

/**
 * BI-01/DEC-09: "Alerte de rupture" (stock_quantity = 0 sur un produit actif)
 * and "Alerte de seuil" (0 < stock_quantity <= alert_threshold), as one
 * counted figure per establishment. Deliberately its own query rather than
 * derived from `listProducts` client-side: STK-08's badges answer "which
 * rows", the cockpit needs "how many" as a tested value in its own right,
 * and computing it here means both can never disagree about what counts as
 * a rupture or a low-stock line.
 */
export async function getStockAlertCounts(
  db: Queryable,
  locationId: number,
): Promise<StockAlertCounts> {
  const { rows } = await db.query<{ out_of_stock: string; low_stock: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE stock_quantity = 0) AS out_of_stock,
       COUNT(*) FILTER (
         WHERE stock_quantity > 0 AND stock_quantity <= alert_threshold
       ) AS low_stock
     FROM products
     WHERE location_id = $1 AND is_active`,
    [locationId],
  );
  // COUNT(...) FILTER returns bigint, which the pg driver hands back as a
  // string — true of every aggregate on this connection already.
  return {
    out_of_stock: Number(rows[0].out_of_stock),
    low_stock: Number(rows[0].low_stock),
  };
}

export interface SaleProductPricing {
  id: number;
  name: string;
  /** `DECIMAL(10,2)`-shaped TTC unit price, as stored on `products.price`. */
  price: string;
  /** `DECIMAL(5,2)`-shaped percentage, resolved via the same fallback as `listProducts`. */
  tax_rate_percent: string;
}

/**
 * SALE-03: locks the requested products (`FOR UPDATE OF p`, so a
 * concurrent price change cannot land between this read and the sale it
 * prices) and resolves each one's effective tax rate in the same query —
 * the pricing/tax half of what a sale needs to know. Only `products` rows
 * are locked, not the joined `categories`/`tax_classes`/`location_settings`
 * — those are read consistently within this same transaction but are not
 * what a sale contends over.
 *
 * Deliberately separate from STK-03's `decrementStockAtomically`, which
 * locks the same rows again moments later for the actual decrement: a
 * second lock acquisition on rows this same transaction already holds is
 * safe (Postgres row locks are re-entrant within one transaction) and
 * costs one extra round trip, which is cheaper than teaching the stock
 * service about pricing/tax — a concern STK-01/STK-03 never had and
 * should not gain now.
 *
 * Inactive products are excluded (same `is_active` gate as
 * `lockActiveProductForStockOperation`), so a missing id in the result is
 * "not found or not sellable" — the caller cannot tell which, matching
 * the checkout error message this replaces.
 */
export async function lockProductsForSale(
  db: Queryable,
  locationId: number,
  productIds: number[],
): Promise<SaleProductPricing[]> {
  const { rows } = await db.query<SaleProductPricing>(
    `SELECT p.id, p.name, p.price,
            COALESCE(ptc.rate, ctc.rate, ls.default_tax_rate) AS tax_rate_percent
     FROM products p
     ${TAX_RESOLUTION_JOIN}
     WHERE p.location_id = $1 AND p.id = ANY($2::int[]) AND p.is_active = true
     FOR UPDATE OF p`,
    [locationId, productIds],
  );
  return rows;
}

export interface CreateProductInput {
  categoryId: number | null;
  /** CFG-02/DEC-05: overrides the category's class, which overrides the establishment default. */
  taxClassId?: number | null;
  name: string;
  price: string;
  /** CFG-02: how the product is counted ("bouteille", "part"), or null for plain units. */
  unit?: string | null;
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
    `INSERT INTO products (location_id, category_id, tax_class_id, name, price, unit, stock_quantity, alert_threshold)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, category_id, name, price, stock_quantity, alert_threshold, is_active`,
    [
      locationId,
      input.categoryId,
      input.taxClassId ?? null,
      input.name,
      input.price,
      input.unit ?? null,
      input.stockQuantity ?? 0,
      input.alertThreshold ?? 5,
    ],
  );
  return { ...row, category: null };
}

export interface UpdateProductInput {
  name?: string;
  price?: string;
  categoryId?: number | null;
  taxClassId?: number | null;
  unit?: string | null;
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
    // COALESCE means "leave it alone when the caller said nothing". For the
    // three nullable columns that is not enough — clearing a category is a
    // real intent — so each carries an explicit "was it provided" flag
    // rather than conflating null with absent (CFG-02).
    `UPDATE products
     SET name = COALESCE($3, name),
         price = COALESCE($4, price),
         stock_quantity = COALESCE($5, stock_quantity),
         alert_threshold = COALESCE($6, alert_threshold),
         is_active = COALESCE($7, is_active),
         category_id = CASE WHEN $8 THEN $9::INT ELSE category_id END,
         tax_class_id = CASE WHEN $10 THEN $11::INT ELSE tax_class_id END,
         unit = CASE WHEN $12 THEN $13::VARCHAR ELSE unit END
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
      input.categoryId !== undefined,
      input.categoryId ?? null,
      input.taxClassId !== undefined,
      input.taxClassId ?? null,
      input.unit !== undefined,
      input.unit ?? null,
    ],
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

/**
 * Used by `lib/services/stock.ts`'s general-purpose decrement service
 * (STK-03) — not by checkout.ts, which locks and prices products through
 * `lockProductsForSale` above instead (SALE-03) and lets
 * `decrementStockAtomically` re-lock the same rows for the actual
 * decrement (see that function's doc comment for why re-locking is
 * intentional rather than merged into one pass).
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
