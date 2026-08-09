import type { PoolClient } from "pg";
import { withTransaction } from "../db";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { recordAuditEvent } from "../audit";
import { extractTaxCents, fromCents, toCents } from "../money";
import { getActiveBusinessDay } from "../repositories/business-days";
import { recordCharge } from "../repositories/payments";
import { lockProductsForSale } from "../repositories/products";
import { listTicketItems, lockTicket, type TicketItemRow } from "../repositories/tickets";
import { decrementStockAtomically } from "./stock";
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
  subtotal_amount: number;
  tax_amount: number;
  total_amount: number;
  created_at: string;
  paid_at: string;
}

export interface CheckoutResult {
  order: CheckoutOrderResult;
  total: number;
}

/** What callers hand in: `notes` may be absent, null, or text. */
export interface CheckoutLineInput {
  productId: number;
  quantity: number;
  notes?: string | null;
}

/** What comes back out: one line per product, `notes` normalised to text or null. */
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
export function mergeItemsByProduct(items: readonly CheckoutLineInput[]): MergedItem[] {
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
 * DEC-05's amounts-per-method rule, computed once the real total is known
 * (the schema cannot do this — it validates the *shape* of a request before
 * the catalog is ever consulted, see checkoutBodySchema's own doc comment).
 * For CASH/CARD the client's cashAmountCents/cardAmountCents are ignored
 * entirely — the whole point of "calcul uniquement côté serveur" is that
 * nothing the client sent decides the charged amount when there is only one
 * possible correct value. For MIXED, the client's split is the input (a
 * real decision — how much cash was actually handed over), verified against
 * the computed total rather than trusted blindly.
 */
function resolvePaymentSplit(
  paymentMethod: PaymentMethod,
  totalCents: number,
  input: Pick<CheckoutBody, "cashAmountCents" | "cardAmountCents">,
): { cashCents: number; cardCents: number } {
  if (paymentMethod === "CASH") {
    return { cashCents: totalCents, cardCents: 0 };
  }
  if (paymentMethod === "CARD") {
    return { cashCents: 0, cardCents: totalCents };
  }
  // MIXED: checkoutBodySchema already refused a zero cash or card side; what
  // it could not check is whether the two actually add up to this order's
  // real total.
  const { cashAmountCents, cardAmountCents } = input;
  if (cashAmountCents + cardAmountCents !== totalCents) {
    throw new ValidationError(
      "La somme des montants espèces et carte ne correspond pas au total de la commande.",
    );
  }
  return { cashCents: cashAmountCents, cardCents: cardAmountCents };
}

/**
 * Locks an existing ticket and returns its persisted lines, refusing
 * anything that is not an open ticket of this establishment.
 *
 * The `FOR UPDATE` matters as much as the status check: it holds the row for
 * the rest of the transaction, so two devices paying the same ticket at once
 * serialize here, and the second one finds it already `PAID` instead of
 * charging the customer twice. Idempotency (API-02) covers a retry of the
 * *same* request; this covers two genuinely different ones.
 */
async function lockOpenTicketForPayment(
  client: PoolClient,
  locationId: number,
  orderId: number,
): Promise<{ id: number; items: TicketItemRow[] }> {
  const locked = await lockTicket(client, locationId, orderId);
  if (!locked) {
    throw new NotFoundError("Ticket introuvable.");
  }
  if (locked.status !== "OPEN") {
    throw new ConflictError(
      locked.status === "PAID"
        ? "Ce ticket a déjà été encaissé."
        : "Ce ticket a été annulé et ne peut plus être encaissé.",
    );
  }
  return { id: locked.id, items: await listTicketItems(client, orderId) };
}

/**
 * SALE-03: the canonical, server-computed checkout — subtotal, tax, total,
 * payments and stock movements, all in one transaction. Replaces the
 * prototype flow this module carried since FND-08/API-02, and with it
 * P0-02 (a CASH sale recorded as CARD revenue too): `resolvePaymentSplit`
 * has no fallback branch, every payment method resolves to exactly one
 * pair of amounts.
 *
 * Two ways in since ORD-04. With an `orderId`, this pays a ticket that has
 * been sitting `OPEN` on a table — its lines come from the database and the
 * row transitions in place. Without one, it is a counter sale and the order
 * is created `PAID` outright, the only path that existed before ORD-02.
 * ORD-07 folds the second into the first, so every sale passes through a
 * real `OPEN` state.
 */
export async function performCheckout(
  context: RequestContext,
  input: CheckoutBody,
): Promise<CheckoutResult> {
  // Input validation happens at the route boundary against
  // checkoutBodySchema (API-01), before this function — and therefore before
  // the database — is reached at all. `input` is the schema's output type,
  // so ids, quantities and amounts are already known-good here.
  return withTransaction(async (client) => {
    // ORD-04/ORD-05: paying an existing ticket takes its contents from the
    // database, never from the request. The browser may have been open for
    // an hour, or another device may have added a round since — the ticket
    // row is what the customer is being charged for.
    const ticket = await lockOpenTicketForPayment(client, context.locationId, input.orderId);

    const mergedItems = mergeItemsByProduct(
      ticket.items.map((item) => ({
        productId: item.product_id,
        quantity: item.quantity,
        notes: item.notes,
      })),
    );
    if (mergedItems.length === 0) {
      throw new ValidationError("Ajoutez au moins un article avant d'encaisser.");
    }

    const productIds = mergedItems.map((item) => item.productId);
    const pricing = await lockProductsForSale(client, context.locationId, productIds);
    const pricingById = new Map(pricing.map((row) => [row.id, row]));

    let totalCents = 0;
    let taxCents = 0;
    const resolvedItems: {
      productId: number;
      quantity: number;
      unitPriceCents: number;
      taxRatePercent: string;
      notes: string | null;
    }[] = [];

    for (const item of mergedItems) {
      const product = pricingById.get(item.productId);
      if (!product) {
        // Not found and inactive are indistinguishable here on purpose —
        // lockProductsForSale filters on is_active too, same as the
        // prototype's lock did, so a missing id could be either.
        throw new NotFoundError("Produit introuvable.");
      }
      const unitPriceCents = toCents(product.price);
      const lineTotalCents = unitPriceCents * item.quantity;
      const lineTaxCents = extractTaxCents(lineTotalCents, Number(product.tax_rate_percent));
      totalCents += lineTotalCents;
      taxCents += lineTaxCents;
      resolvedItems.push({
        productId: item.productId,
        quantity: item.quantity,
        unitPriceCents,
        taxRatePercent: product.tax_rate_percent,
        notes: item.notes,
      });
    }
    const subtotalCents = totalCents - taxCents;

    const { cashCents, cardCents } = resolvePaymentSplit(input.paymentMethod, totalCents, input);

    const businessDay = await getActiveBusinessDay(client, context.locationId);
    if (!businessDay) {
      throw new ValidationError("Aucune journée de caisse ouverte.");
    }

    // ORD-07: one path. `OPEN -> PAID` as an UPDATE guarded on the status
    // the row was locked with, never a second INSERT — the ticket keeps its
    // identity, its number and the moment it was opened, so the floor plan
    // frees the table by the same fact that records the sale (ORD-03). The
    // parallel "create a PAID order outright" branch that direct sales used
    // is gone: it was the one way an order could exist without ever having
    // been open, and the conceptual duplicate ORD-07 set out to remove.
    const {
      rows: [order],
    } = await client.query<CheckoutOrderResult>(
      `UPDATE orders
       SET status = 'PAID', payment_method = $3, cash_amount = $4, card_amount = $5,
           subtotal_amount = $6, tax_amount = $7, total_amount = $8,
           business_day_id = COALESCE(business_day_id, $9), paid_at = now(), version = version + 1
       WHERE location_id = $1 AND id = $2 AND status = 'OPEN'
       RETURNING id, order_number, table_id, status, payment_method, cash_amount, card_amount, subtotal_amount, tax_amount, total_amount, created_at, paid_at`,
      [
        context.locationId,
        ticket.id,
        input.paymentMethod,
        fromCents(cashCents),
        fromCents(cardCents),
        fromCents(subtotalCents),
        fromCents(taxCents),
        fromCents(totalCents),
        businessDay.id,
      ],
    );
    // The lines are already there and already priced; rewrite them so the
    // stored unit prices match what was just charged.
    await client.query("DELETE FROM order_items WHERE order_id = $1", [order.id]);

    for (const item of resolvedItems) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, tax_rate_percent, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          order.id,
          item.productId,
          item.quantity,
          fromCents(item.unitPriceCents),
          // ORD-09: snapshotted with the price, so the receipt's per-rate
          // breakdown states what was charged rather than what today's
          // catalog would charge.
          item.taxRatePercent,
          item.notes,
        ],
      );
    }

    // STK-03: locks and decrements atomically, refusing the whole sale if
    // any line's stock is insufficient (ValidationError, rolling back
    // everything above). Re-locks the rows lockProductsForSale already
    // locked above — see that function's doc comment for why this is safe
    // and intentional rather than merged into one pass.
    await decrementStockAtomically(
      client,
      context.locationId,
      mergedItems.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      {
        type: "SALE",
        reason: `Vente — commande #${order.order_number}`,
        createdBy: context.userId,
        referenceType: "order",
        referenceId: String(order.id),
      },
    );

    // SALE-02: one CHARGE line per non-zero amount — a CASH/CARD sale gets
    // one, a MIXED sale gets two. Never a REFUND here; that is ORD-10.
    if (cashCents > 0) {
      await recordCharge(client, context.locationId, {
        orderId: order.id,
        method: "CASH",
        amount: fromCents(cashCents),
        createdBy: context.userId,
      });
    }
    if (cardCents > 0) {
      await recordCharge(client, context.locationId, {
        orderId: order.id,
        method: "CARD",
        amount: fromCents(cardCents),
        createdBy: context.userId,
      });
    }

    // ORD-03: nothing to free. The table was occupied because it carried an
    // OPEN order; that order is now PAID, so the floor plan already reads as
    // free on its next query. There is no second write to forget, and no
    // window in which the two could disagree.

    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "order.checkout",
      targetType: "order",
      targetId: order.id,
      after: {
        subtotal: subtotalCents,
        tax: taxCents,
        total: totalCents,
        paymentMethod: input.paymentMethod,
        itemCount: resolvedItems.length,
      },
    });

    return { order, total: totalCents / 100 };
  });
}
