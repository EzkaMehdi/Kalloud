import { ValidationError } from "../errors";
import { lockActiveProductForStockOperation } from "../repositories/products";
import { recordStockMovement, type StockMovementType } from "../repositories/stock-movements";
import type { Queryable } from "../db";

export interface StockDecrementItem {
  productId: number;
  quantity: number;
}

export interface StockMovementContext {
  type: StockMovementType;
  reason: string;
  createdBy: number;
  referenceType?: string | null;
  referenceId?: string | null;
}

/**
 * Collapses repeated lines of the same product into one, sorted by product
 * id. Mirrors checkout.ts's mergeItemsByProduct in spirit (aggregation
 * before locking, deterministic lock order to avoid a deadlock between two
 * operations that touch the same two products in opposite order) but is
 * its own, smaller version: this module doesn't carry order-line concepts
 * like per-line notes, so reusing that function's type would only add a
 * coupling this service doesn't need.
 */
function mergeByProduct(items: StockDecrementItem[]): StockDecrementItem[] {
  const merged = new Map<number, number>();
  for (const item of items) {
    merged.set(item.productId, (merged.get(item.productId) ?? 0) + item.quantity);
  }
  return [...merged.entries()]
    .map(([productId, quantity]) => ({ productId, quantity }))
    .sort((left, right) => left.productId - right.productId);
}

/**
 * STK-03: the reusable "decrement N products, atomically, refusing the
 * whole operation if any one of them doesn't have enough stock" service
 * DEC-06 asks for. Not wired to checkout.ts — DEC-06 itself assigns the
 * `SALE` movement's trigger to SALE-03, so that remains the caller that
 * will eventually use this, inside its own larger transaction (order +
 * payments + stock, all atomic together). Until then this exists, is
 * tested, and has no callers yet — the same position CASH-01's
 * openNewBusinessDay was in before this file existed.
 *
 * Must run inside the caller's own `withTransaction` (a `db` argument
 * rather than managing one itself), exactly like recordStockMovement: a
 * negative-stock refusal on line 3 of 5 must roll back lines 1 and 2 too,
 * and that rollback boundary belongs to the caller, not this function.
 */
export async function decrementStockAtomically(
  db: Queryable,
  locationId: number,
  items: StockDecrementItem[],
  movement: StockMovementContext,
): Promise<Map<number, number>> {
  const merged = mergeByProduct(items);
  const balances = new Map<number, number>();

  for (const item of merged) {
    const product = await lockActiveProductForStockOperation(db, locationId, item.productId);
    if (!product) {
      throw new ValidationError("Produit introuvable.");
    }
    if (product.stockQuantity < item.quantity) {
      throw new ValidationError(`Stock insuffisant pour "${product.name}".`);
    }

    const { balance } = await recordStockMovement(db, locationId, {
      productId: item.productId,
      quantity: -item.quantity,
      type: movement.type,
      reason: movement.reason,
      createdBy: movement.createdBy,
      referenceType: movement.referenceType,
      referenceId: movement.referenceId,
    });
    balances.set(item.productId, balance);
  }

  return balances;
}

/**
 * ORD-10: puts stock back for a fully refunded sale.
 *
 * The mirror of `decrementStockAtomically`, and deliberately not a call to
 * it with a negative quantity: there is no stock check to make here (adding
 * units can never take a balance below zero), and the `RETURN` movement type
 * is constrained to a positive quantity at the database level, so the two
 * really are different operations rather than one with a sign flipped.
 *
 * Products are merged and locked in id order for the same reason every other
 * multi-product write does it (API-02): a refund and a sale touching the same
 * two products in opposite order would otherwise be able to deadlock.
 */
export async function returnStockAtomically(
  db: Queryable,
  locationId: number,
  items: StockDecrementItem[],
  movement: Omit<StockMovementContext, "type">,
): Promise<Map<number, number>> {
  const balances = new Map<number, number>();

  for (const item of mergeByProduct(items)) {
    // Locks the row even though nothing can fail on the balance: the
    // movement and the materialized column must move together, and another
    // sale holding the same product must wait rather than read a balance
    // that is about to change (DEC-06's "solde matérialisé + ledger").
    const product = await lockActiveProductForStockOperation(db, locationId, item.productId);
    if (!product) {
      // A product deactivated since the sale. Refusing the whole refund over
      // it would trap the money, so the stock side is simply skipped — the
      // ledger stays truthful about what it does record.
      continue;
    }

    const { balance } = await recordStockMovement(db, locationId, {
      productId: item.productId,
      quantity: item.quantity,
      type: "RETURN",
      reason: movement.reason,
      createdBy: movement.createdBy,
      referenceType: movement.referenceType,
      referenceId: movement.referenceId,
    });
    balances.set(item.productId, balance);
  }

  return balances;
}
