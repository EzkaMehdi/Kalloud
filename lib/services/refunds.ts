import { withTransaction } from "../db";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { recordAuditEvent } from "../audit";
import { fromCents, toCents } from "../money";
import { listPaymentsForOrder, recordRefund, type PaymentRow } from "../repositories/payments";
import { listTicketItems, lockTicket } from "../repositories/tickets";
import { returnStockAtomically } from "./stock";
import type { RequestContext } from "../context";
import type { RefundOrderBody } from "../validation/schemas";

/**
 * ORD-10: refunding a paid order.
 *
 * DEC-05 and DEC-03 between them fix every rule applied here:
 *  - a refund never deletes or edits the original CHARGE lines, it adds
 *    REFUND lines linked to them;
 *  - a motive is mandatory, and the action is reserved to MANAGER/OWNER;
 *  - a partial refund leaves the order `PAID` with a lower net amount; only
 *    a refund covering the whole total moves it to `REFUNDED`.
 *
 * What "aucune suppression de vente" means concretely: the sale's rows are
 * append-only from here. Everything downstream — net revenue, expected cash,
 * the receipt — is computed by netting CHARGE against REFUND, never by
 * rewriting what was charged.
 */

export interface RefundResult {
  orderId: number;
  status: string;
  refunds: PaymentRow[];
  refundedTotal: string;
  netTotal: string;
  stockReturned: boolean;
}

/**
 * Splits a refund across the order's charge lines, oldest first.
 *
 * A MIXED sale has two charges (cash and card), and a partial refund has to
 * say which one it reverses — `payments.refunded_payment_id` is NOT NULL for
 * a REFUND precisely so no refund floats free of the charge it undoes.
 * Taking them in order means a partial refund comes off the cash side first,
 * which is also what a counter would do: hand back notes before reversing a
 * card payment.
 */
function allocateRefund(
  charges: { payment: PaymentRow; remainingCents: number }[],
  amountCents: number,
): { payment: PaymentRow; cents: number }[] {
  const allocation: { payment: PaymentRow; cents: number }[] = [];
  let left = amountCents;
  for (const charge of charges) {
    if (left <= 0) break;
    const take = Math.min(left, charge.remainingCents);
    if (take <= 0) continue;
    allocation.push({ payment: charge.payment, cents: take });
    left -= take;
  }
  if (left > 0) {
    throw new ValidationError(
      "Le montant du remboursement dépasse ce qui reste encaissé sur cette commande.",
    );
  }
  return allocation;
}

export async function refundOrder(
  context: RequestContext,
  orderId: number,
  input: RefundOrderBody,
): Promise<RefundResult> {
  return withTransaction(async (client) => {
    const locked = await lockTicket(client, context.locationId, orderId);
    if (!locked) {
      throw new NotFoundError("Commande introuvable.");
    }
    if (locked.status !== "PAID" && locked.status !== "REFUNDED") {
      throw new ConflictError(
        locked.status === "OPEN"
          ? "Ce ticket n'a pas été encaissé : annulez-le plutôt que de le rembourser."
          : "Une commande annulée ne peut pas être remboursée.",
      );
    }

    const payments = await listPaymentsForOrder(client, context.locationId, orderId);
    const charges = payments.filter((payment) => payment.type === "CHARGE");
    if (charges.length === 0) {
      throw new ValidationError("Cette commande ne porte aucun encaissement à rembourser.");
    }

    // What each charge still has left, after any earlier refund against it.
    const refundedByCharge = new Map<number, number>();
    for (const payment of payments) {
      if (payment.type !== "REFUND" || payment.refunded_payment_id === null) continue;
      refundedByCharge.set(
        payment.refunded_payment_id,
        (refundedByCharge.get(payment.refunded_payment_id) ?? 0) + toCents(payment.amount),
      );
    }
    const remaining = charges.map((payment) => ({
      payment,
      remainingCents: toCents(payment.amount) - (refundedByCharge.get(payment.id) ?? 0),
    }));
    const remainingTotalCents = remaining.reduce((sum, row) => sum + row.remainingCents, 0);
    if (remainingTotalCents <= 0) {
      throw new ConflictError("Cette commande a déjà été intégralement remboursée.");
    }

    // `amount` absent means "the whole remaining balance" — the common case,
    // and one the caller should not have to compute (and risk getting a cent
    // wrong) from figures the server already holds.
    const amountCents = input.amount ?? remainingTotalCents;
    if (amountCents <= 0) {
      throw new ValidationError("Le montant du remboursement doit être supérieur à zéro.");
    }

    const allocation = allocateRefund(remaining, amountCents);
    const refunds: PaymentRow[] = [];
    for (const { payment, cents } of allocation) {
      refunds.push(
        await recordRefund(client, context.locationId, {
          orderId,
          refundedPaymentId: payment.id,
          method: payment.method,
          amount: fromCents(cents),
          createdBy: context.userId,
        }),
      );
    }

    // DEC-03: only a refund covering everything still owed moves the order
    // to REFUNDED. A partial one leaves it PAID with a smaller net.
    const isFullyRefunded = amountCents >= remainingTotalCents;

    /**
     * Stock is returned only on a full refund, and the reason is honest
     * rather than conservative: a partial refund is an amount, not a list of
     * items, so nothing says *which* products came back. Putting a guess
     * into the ledger would corrupt the one number the stock screen exists
     * to state. A partial refund therefore leaves stock alone, and a manager
     * who did take goods back records that as its own movement (STK-06).
     */
    let stockReturned = false;
    if (isFullyRefunded) {
      const items = await listTicketItems(client, orderId);
      if (items.length > 0) {
        await returnStockAtomically(
          client,
          context.locationId,
          items.map((item) => ({ productId: item.product_id, quantity: item.quantity })),
          {
            reason: `Remboursement — commande #${locked.id}`,
            createdBy: context.userId,
            referenceType: "order",
            referenceId: String(orderId),
          },
        );
        stockReturned = true;
      }
      await client.query(
        `UPDATE orders
         SET status = 'REFUNDED', refunded_at = now(), version = version + 1
         WHERE location_id = $1 AND id = $2`,
        [context.locationId, orderId],
      );
    }

    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "order.refund",
      targetType: "order",
      targetId: orderId,
      before: { status: locked.status, remaining: fromCents(remainingTotalCents) },
      after: {
        amount: fromCents(amountCents),
        reason: input.reason,
        full: isFullyRefunded,
        stockReturned,
      },
    });

    const after = await listPaymentsForOrder(client, context.locationId, orderId);
    const refundedTotalCents = after
      .filter((payment) => payment.type === "REFUND")
      .reduce((sum, payment) => sum + toCents(payment.amount), 0);
    const chargedTotalCents = after
      .filter((payment) => payment.type === "CHARGE")
      .reduce((sum, payment) => sum + toCents(payment.amount), 0);

    return {
      orderId,
      status: isFullyRefunded ? "REFUNDED" : locked.status,
      refunds,
      refundedTotal: fromCents(refundedTotalCents),
      netTotal: fromCents(chargedTotalCents - refundedTotalCents),
      stockReturned,
    };
  });
}
