import { withTransaction } from "../db";
import { NotFoundError, ValidationError } from "../errors";
import { recordAuditEvent } from "../audit";
import { fromCents } from "../money";
import { getActiveBusinessDay } from "../repositories/business-days";
import { decrementProductStock, lockActiveProductForCheckout } from "../repositories/products";
import { setDiningTableStatus } from "../repositories/tables";
import type { RequestContext } from "../context";
import type { PaymentMethod } from "../validation/primitives";
import type { CheckoutBody } from "../validation/schemas";

export type { PaymentMethod };

export interface CheckoutOrderResult {
  id: number;
  table_id: number | null;
  status: string;
  payment_method: PaymentMethod;
  cash_amount: number;
  card_amount: number;
  total_amount: number;
  created_at: string;
  closed_at: string;
}

export interface CheckoutResult {
  order: CheckoutOrderResult;
  total: number;
}

export interface MergedItem {
  productId: number;
  quantity: number;
  notes: string | null;
}

/**
 * Collapses repeated lines of the same product into one, and returns them
 * ordered by product id (API-02).
 *
 * Both properties matter, for different reasons. Merging: the stock check
 * used to run per line, so a ticket carrying the same product twice could
 * pass two checks of 3 units each against a stock of 5, then decrement to
 * -1. Ordering: `FOR UPDATE` taken in whatever order the client sent meant
 * two simultaneous sales of products {7, 12} and {12, 7} could each hold
 * what the other was waiting for — a deadlock Postgres resolves by aborting
 * one transaction with an error the cashier can do nothing about.
 *
 * Exported so the ordering guarantee can be asserted directly
 * (tests/unit/checkout-items.test.ts). An integration test cannot prove it:
 * reproducing a deadlock requires interleaving two transactions at an exact
 * point, which the test suite has no hook to force.
 *
 * Notes from merged lines are joined so none is silently dropped.
 */
export function mergeItemsByProduct(items: CheckoutBody["items"]): MergedItem[] {
  const merged = new Map<number, MergedItem>();

  for (const item of items) {
    const existing = merged.get(item.productId);
    const note = item.notes?.trim() || null;
    if (!existing) {
      merged.set(item.productId, {
        productId: item.productId,
        quantity: item.quantity,
        notes: note,
      });
      continue;
    }
    existing.quantity += item.quantity;
    if (note) {
      existing.notes = existing.notes ? `${existing.notes} — ${note}` : note;
    }
  }

  return [...merged.values()].sort((left, right) => left.productId - right.productId);
}

/**
 * Ports the prototype's atomic checkout (lock products, decrement stock,
 * create the order, free the table, all in one transaction) into the new
 * authenticated/scoped architecture. It intentionally keeps the original
 * payment-split behaviour and its known bug (`cardAmount || total`, audit
 * P0-02: a CASH sale is also recorded as CARD revenue) — the canonical,
 * server-validated `cash + card = total` computation is SALE-03 (phase 3).
 * What *is* fixed here: every lookup is scoped to context.locationId, the
 * caller must hold "orders:create", the sale is audited with its actor
 * (SEC-02/SEC-06/SEC-09), and lines are merged and locked in a deterministic
 * order (API-02, see mergeItemsByProduct).
 */
export async function performCheckout(
  context: RequestContext,
  input: CheckoutBody,
): Promise<CheckoutResult> {
  // Input validation happens at the route boundary against
  // checkoutBodySchema (API-01), before this function — and therefore before
  // the database — is reached at all. `input` is the schema's output type,
  // so ids, quantities and amounts are already known-good here.
  const mergedItems = mergeItemsByProduct(input.items);

  return withTransaction(async (client) => {
    let total = 0;
    const resolvedItems: {
      productId: number;
      quantity: number;
      unitPrice: number;
      notes: string | null;
    }[] = [];

    for (const item of mergedItems) {
      const product = await lockActiveProductForCheckout(
        client,
        context.locationId,
        item.productId,
      );
      if (!product) {
        throw new NotFoundError("Produit introuvable.");
      }
      if (product.stockQuantity < item.quantity) {
        throw new ValidationError(`Stock insuffisant pour "${product.name}".`);
      }
      const unitPrice = Number(product.price);
      total += unitPrice * item.quantity;
      resolvedItems.push({
        productId: item.productId,
        quantity: item.quantity,
        unitPrice,
        notes: item.notes,
      });
    }

    const businessDay = await getActiveBusinessDay(client, context.locationId);
    if (!businessDay) {
      throw new ValidationError("Aucune journée de caisse ouverte.");
    }

    // TODO(SALE-03): still reproduces P0-02 (see module doc comment) — the
    // fallback to `total` when no card amount is given is what records a
    // cash sale as card revenue. API-01 only changed the *unit*: amounts now
    // arrive as validated integer cents, converted here to the DECIMAL(10,2)
    // form Postgres stores. SALE-03 replaces this block with the canonical
    // server-side computation of cash + card = total.
    const cashAmount = fromCents(input.cashAmountCents);
    const cardAmount = input.cardAmountCents > 0 ? fromCents(input.cardAmountCents) : total;

    const {
      rows: [order],
    } = await client.query<CheckoutOrderResult>(
      `INSERT INTO orders (location_id, table_id, business_day_id, status, payment_method, cash_amount, card_amount, total_amount, closed_at)
       VALUES ($1, $2, $3, 'COMPLETED', $4, $5, $6, $7, now())
       RETURNING id, table_id, status, payment_method, cash_amount, card_amount, total_amount, created_at, closed_at`,
      [
        context.locationId,
        input.tableId,
        businessDay.id,
        input.paymentMethod,
        cashAmount,
        cardAmount,
        total,
      ],
    );

    for (const item of resolvedItems) {
      await client.query(
        "INSERT INTO order_items (order_id, product_id, quantity, unit_price, notes) VALUES ($1, $2, $3, $4, $5)",
        [order.id, item.productId, item.quantity, item.unitPrice, item.notes],
      );
      await decrementProductStock(client, context.locationId, item.productId, item.quantity);
    }

    if (input.tableId) {
      await setDiningTableStatus(client, context.locationId, input.tableId, "FREE");
    }

    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "order.checkout",
      targetType: "order",
      targetId: order.id,
      after: { total, paymentMethod: input.paymentMethod, itemCount: resolvedItems.length },
    });

    return { order, total };
  });
}
