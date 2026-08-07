import { withTransaction } from "../db";
import { NotFoundError, ValidationError } from "../errors";
import { recordAuditEvent } from "../audit";
import { extractTaxCents, fromCents, toCents } from "../money";
import { getActiveBusinessDay } from "../repositories/business-days";
import { nextOrderNumber } from "../repositories/orders";
import { recordCharge } from "../repositories/payments";
import { lockProductsForSale } from "../repositories/products";
import { setDiningTableStatus } from "../repositories/tables";
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
 * SALE-03: the canonical, server-computed checkout — subtotal, tax, total,
 * payments and stock movements, all in one transaction. Replaces the
 * prototype flow this module carried since FND-08/API-02, and with it
 * P0-02 (a CASH sale recorded as CARD revenue too): `resolvePaymentSplit`
 * has no fallback branch, every payment method resolves to exactly one
 * pair of amounts.
 *
 * Still creates the order directly as `PAID`, with no persisted `OPEN`
 * step — true since before ORD-01 (see that task's note in git history),
 * unchanged here; ORD-02 is what gives orders a real `OPEN` state to pass
 * through first.
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
    const productIds = mergedItems.map((item) => item.productId);
    const pricing = await lockProductsForSale(client, context.locationId, productIds);
    const pricingById = new Map(pricing.map((row) => [row.id, row]));

    let totalCents = 0;
    let taxCents = 0;
    const resolvedItems: {
      productId: number;
      quantity: number;
      unitPriceCents: number;
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
        notes: item.notes,
      });
    }
    const subtotalCents = totalCents - taxCents;

    const { cashCents, cardCents } = resolvePaymentSplit(input.paymentMethod, totalCents, input);

    const businessDay = await getActiveBusinessDay(client, context.locationId);
    if (!businessDay) {
      throw new ValidationError("Aucune journée de caisse ouverte.");
    }

    // Consumed inside this same transaction: if the checkout later rolls
    // back (e.g. the stock check below throws), the number is never
    // committed to an order and the counter simply has a gap, which
    // nextOrderNumber's own doc comment explains is an accepted trade-off.
    const orderNumber = await nextOrderNumber(client, context.locationId);

    const {
      rows: [order],
    } = await client.query<CheckoutOrderResult>(
      `INSERT INTO orders (location_id, table_id, business_day_id, order_number, created_by, status, payment_method, cash_amount, card_amount, subtotal_amount, tax_amount, total_amount, paid_at)
       VALUES ($1, $2, $3, $4, $5, 'PAID', $6, $7, $8, $9, $10, $11, now())
       RETURNING id, order_number, table_id, status, payment_method, cash_amount, card_amount, subtotal_amount, tax_amount, total_amount, created_at, paid_at`,
      [
        context.locationId,
        input.tableId,
        businessDay.id,
        orderNumber,
        context.userId,
        input.paymentMethod,
        fromCents(cashCents),
        fromCents(cardCents),
        fromCents(subtotalCents),
        fromCents(taxCents),
        fromCents(totalCents),
      ],
    );

    for (const item of resolvedItems) {
      await client.query(
        "INSERT INTO order_items (order_id, product_id, quantity, unit_price, notes) VALUES ($1, $2, $3, $4, $5)",
        [order.id, item.productId, item.quantity, fromCents(item.unitPriceCents), item.notes],
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

    if (input.tableId) {
      await setDiningTableStatus(client, context.locationId, input.tableId, "FREE");
    }

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
