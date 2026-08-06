import { withTransaction } from "../db";
import { NotFoundError, ValidationError } from "../errors";
import { recordAuditEvent } from "../audit";
import { fromCents } from "../money";
import { getActiveBusinessDay } from "../repositories/business-days";
import { nextOrderNumber } from "../repositories/orders";
import { decrementProductStock, lockActiveProductForCheckout } from "../repositories/products";
import { setDiningTableStatus } from "../repositories/tables";
import type { RequestContext } from "../context";
import type { PaymentMethod } from "../validation/primitives";
import type { CheckoutBody } from "../validation/schemas";

export type { PaymentMethod };

export interface CheckoutOrderResult {
  id: number;
  order_number: number;
  table_id: number | null;
  status: string;
  payment_method: PaymentMethod;
  cash_amount: number;
  card_amount: number;
  total_amount: number;
  created_at: string;
  paid_at: string;
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
 *
 * ORD-01: the order it creates is now `PAID` (not the old `COMPLETED`) with
 * a real `order_number`/`created_by`. It still inserts straight into `PAID`
 * rather than creating an `OPEN` row first and transitioning it — this was
 * already true before ORD-01 (the prototype never had a persisted ticket
 * either) and stays true here; DEC-03's `OPEN -> PAID` step only becomes
 * real once ORD-02 gives orders a persisted `OPEN` state to be created in.
 * `subtotal_amount`/`tax_amount` are left NULL: this function does not
 * compute tax, so writing a number would be a fabricated fiscal snapshot
 * (FND-14) — SALE-03 is what populates them for real.
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

    // Consumed inside this same transaction: if the checkout later rolls
    // back (e.g. the stock check above already threw), the number is never
    // committed to an order and the counter simply has a gap, which
    // nextOrderNumber's own doc comment explains is an accepted trade-off.
    const orderNumber = await nextOrderNumber(client, context.locationId);

    const {
      rows: [order],
    } = await client.query<CheckoutOrderResult>(
      `INSERT INTO orders (location_id, table_id, business_day_id, order_number, created_by, status, payment_method, cash_amount, card_amount, total_amount, paid_at)
       VALUES ($1, $2, $3, $4, $5, 'PAID', $6, $7, $8, $9, now())
       RETURNING id, order_number, table_id, status, payment_method, cash_amount, card_amount, total_amount, created_at, paid_at`,
      [
        context.locationId,
        input.tableId,
        businessDay.id,
        orderNumber,
        context.userId,
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
