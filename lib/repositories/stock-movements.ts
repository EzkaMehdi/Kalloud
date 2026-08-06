import type { Queryable } from "../db";
import { NotFoundError } from "../errors";

export type StockMovementType =
  "OPENING_BALANCE" | "SALE" | "RECEIPT" | "CORRECTION" | "LOSS" | "RETURN";

export interface StockMovementRow {
  id: number;
  location_id: number;
  product_id: number;
  quantity: number;
  type: StockMovementType;
  reason: string;
  created_by: number;
  reference_type: string | null;
  reference_id: string | null;
  created_at: string;
}

export interface RecordStockMovementInput {
  productId: number;
  /** Signed: positive is stock coming in, negative is stock going out (DEC-06). */
  quantity: number;
  type: StockMovementType;
  reason: string;
  createdBy: number;
  referenceType?: string | null;
  referenceId?: string | null;
}

export interface StockMovementResult {
  movement: StockMovementRow;
  balance: number;
}

/**
 * The one write path that is allowed to change `products.stock_quantity`
 * from here on: it records the ledger entry that justifies the change and
 * applies it to the materialized balance in the same statement round-trip,
 * so `products.stock_quantity == SUM(stock_movements.quantity)` never has a
 * window where it can be observed to disagree (DEC-06).
 *
 * Deliberately does not check whether the resulting balance would go
 * negative — that refusal is STK-03's "service transactionnel de stock",
 * layered on top of this primitive, not this function's job. A `CORRECTION`
 * is explicitly allowed to land on a negative balance (DEC-06, exceptional
 * documented catch-up case), so a blanket check here would be wrong for at
 * least one of the six movement types, not just permissive by omission.
 *
 * Callers must run this inside `withTransaction` alongside whatever else
 * the operation does (decrementing for a sale, applying a correction) —
 * passing the pool directly would still keep the two writes atomic with
 * each other, but not with the rest of the caller's operation.
 */
export async function recordStockMovement(
  db: Queryable,
  locationId: number,
  input: RecordStockMovementInput,
): Promise<StockMovementResult> {
  const {
    rows: [movement],
  } = await db.query<StockMovementRow>(
    `INSERT INTO stock_movements
       (location_id, product_id, quantity, type, reason, created_by, reference_type, reference_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, location_id, product_id, quantity, type, reason, created_by,
               reference_type, reference_id, created_at`,
    [
      locationId,
      input.productId,
      input.quantity,
      input.type,
      input.reason,
      input.createdBy,
      input.referenceType ?? null,
      input.referenceId ?? null,
    ],
  );

  const {
    rows: [product],
  } = await db.query<{ stock_quantity: number }>(
    `UPDATE products SET stock_quantity = stock_quantity + $3
     WHERE id = $1 AND location_id = $2
     RETURNING stock_quantity`,
    [input.productId, locationId, input.quantity],
  );
  if (!product) {
    // The FOREIGN KEY (product_id, location_id) on stock_movements already
    // guarantees the product exists and belongs to this location — reaching
    // here would mean the product row vanished between the two statements
    // of this same transaction, which withTransaction's rollback makes
    // unreachable in practice. Guarded anyway so a bug elsewhere fails loud
    // (NotFoundError) instead of returning a movement with no real balance.
    throw new NotFoundError("Produit introuvable.");
  }

  return { movement, balance: product.stock_quantity };
}

/** Recomputes a product's balance directly from the ledger — the reconstruction DEC-06 requires be possible. */
export async function getStockBalanceFromLedger(
  db: Queryable,
  locationId: number,
  productId: number,
): Promise<number> {
  const {
    rows: [row],
  } = await db.query<{ balance: string }>(
    `SELECT COALESCE(SUM(quantity), 0) AS balance
     FROM stock_movements
     WHERE location_id = $1 AND product_id = $2`,
    [locationId, productId],
  );
  return Number(row.balance);
}

export async function listStockMovements(
  db: Queryable,
  locationId: number,
  productId: number,
  limit = 100,
): Promise<StockMovementRow[]> {
  const { rows } = await db.query<StockMovementRow>(
    `SELECT id, location_id, product_id, quantity, type, reason, created_by,
            reference_type, reference_id, created_at
     FROM stock_movements
     WHERE location_id = $1 AND product_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [locationId, productId, limit],
  );
  return rows;
}
