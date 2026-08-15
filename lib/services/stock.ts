import { recordAuditEvent } from "../audit";
import { NotFoundError, ValidationError } from "../errors";
import { lockActiveProductForStockOperation } from "../repositories/products";
import {
  attachMovementToStockCount,
  createStockCount,
  type StockCountRow,
} from "../repositories/stock-counts";
import { recordStockMovement, type StockMovementType } from "../repositories/stock-movements";
import { withTransaction, type Queryable } from "../db";
import type { ManualStockMovementType } from "../validation/primitives";
import type { RequestContext } from "../context";

export interface AdjustStockInput {
  /** Signed, as the ledger itself is (DEC-06). */
  delta: number;
  type: ManualStockMovementType;
  reason: string;
}

export interface AdjustStockResult {
  movement: Awaited<ReturnType<typeof recordStockMovement>>["movement"];
  balance: number;
}

/**
 * STK-04: the one way a human changes a product's stock.
 *
 * It replaces `PATCH /api/products/[id]/stock`, which took the new *total*
 * and overwrote the column with it. The screen produced that total as
 * `product.stock_quantity + amount` from the copy it had loaded, so a sale
 * settled between the page render and the click was erased — the balance
 * went back to what the client believed, and the ledger and the column
 * disagreed with no record of why. A delta cannot do that: it says how much
 * to move, never what the answer should be, so a concurrent sale simply
 * composes with it.
 *
 * The row is locked for the same reason every other stock write locks it:
 * the movement and the materialized balance must move together (DEC-06).
 *
 * Negative balances are refused, except for `CORRECTION` — DEC-06 allows one
 * "exceptionnelle, documentée" catch-up to land below zero, and the reason
 * is mandatory precisely so it is documented.
 */
export async function adjustProductStock(
  context: RequestContext,
  productId: number,
  input: AdjustStockInput,
): Promise<AdjustStockResult> {
  return withTransaction(async (client) => {
    const product = await lockActiveProductForStockOperation(client, context.locationId, productId);
    if (!product) {
      throw new NotFoundError("Produit introuvable.");
    }

    const balanceAfter = product.stockQuantity + input.delta;
    if (balanceAfter < 0 && input.type !== "CORRECTION") {
      throw new ValidationError(
        `Stock insuffisant pour "${product.name}" : le solde passerait à ${balanceAfter}.`,
      );
    }

    const { movement, balance } = await recordStockMovement(client, context.locationId, {
      productId,
      quantity: input.delta,
      type: input.type,
      reason: input.reason,
      createdBy: context.userId,
    });

    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "stock.adjust",
      targetType: "product",
      targetId: productId,
      before: { stockQuantity: product.stockQuantity },
      after: { delta: input.delta, type: input.type, reason: input.reason, stockQuantity: balance },
    });

    return { movement, balance };
  });
}

export interface StockCountResult {
  count: StockCountRow;
  balance: number;
}

/**
 * STK-07/DEC-06: a physical count. The user states what they actually
 * counted; the system works out the rest.
 *
 * The theoretical balance is read under the row lock the correction is
 * written with, not before it — otherwise a sale settling mid-count would
 * make the recorded "stock avant" a figure that was already false when it
 * was written down, and the écart would blame the counter for someone
 * else's transaction.
 *
 * A count that matches records no movement: `quantity <> 0` forbids an
 * empty one, and inventing a zero-quantity `CORRECTION` to have something
 * to point at would put a line in the ledger describing an event that did
 * not happen. The count row is the trace in that case — which is why it
 * exists as its own table (migrations/0018).
 *
 * The correction is deliberately typed `CORRECTION` whatever the direction:
 * it is the one movement type DEC-06 allows either way, and the one whose
 * meaning is "the ledger was wrong, here is the catch-up".
 */
export async function recordStockCount(
  context: RequestContext,
  productId: number,
  countedQuantity: number,
  note: string | null,
): Promise<StockCountResult> {
  return withTransaction(async (client) => {
    const product = await lockActiveProductForStockOperation(client, context.locationId, productId);
    if (!product) {
      throw new NotFoundError("Produit introuvable.");
    }

    const theoretical = product.stockQuantity;
    const difference = countedQuantity - theoretical;
    let count = await createStockCount(client, context.locationId, {
      productId,
      theoreticalQuantity: theoretical,
      countedQuantity,
      note,
      createdBy: context.userId,
    });

    let balance = theoretical;
    if (difference !== 0) {
      const applied = await recordStockMovement(client, context.locationId, {
        productId,
        quantity: difference,
        type: "CORRECTION",
        reason: note?.trim()
          ? `Inventaire : ${note.trim()}`
          : `Inventaire : ${theoretical} théorique, ${countedQuantity} compté`,
        createdBy: context.userId,
        referenceType: "stock_count",
        referenceId: String(count.id),
      });
      balance = applied.balance;
      count = await attachMovementToStockCount(
        client,
        context.locationId,
        count.id,
        applied.movement.id,
      );
    }

    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "stock.count",
      targetType: "product",
      targetId: productId,
      before: { stockQuantity: theoretical },
      after: { counted: countedQuantity, difference, stockQuantity: balance },
    });

    return { count, balance };
  });
}

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
