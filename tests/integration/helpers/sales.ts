import { performCheckout, type CheckoutResult } from "../../../lib/services/checkout";
import { openDirectSaleTicket, saveTicketItems } from "../../../lib/services/tickets";
import { parseOrThrow } from "../../../lib/validation/parse";
import { checkoutBodySchema } from "../../../lib/validation/schemas";
import type { RequestContext } from "../../../lib/context";

/**
 * Rings up a sale the way the application now does it: open a ticket, put
 * lines on it, settle it.
 *
 * ORD-07 removed the "hand the server a line list and get a paid order back"
 * shortcut — every sale settles a ticket that was `OPEN` first, so there is
 * no second path left for a test to take either. This helper exists so the
 * suites whose subject is something else (tax, stock movements, payments)
 * keep expressing "a sale of these items happened" in one line, instead of
 * each repeating the three-step dance and drifting apart.
 */
export interface SaleLine {
  productId: number;
  quantity: number;
  notes?: string | null;
}

export interface SalePayment {
  paymentMethod: "CASH" | "CARD" | "MIXED";
  cashAmount?: string;
  cardAmount?: string;
}

export async function sell(
  context: RequestContext,
  lines: SaleLine[],
  payment: SalePayment = { paymentMethod: "CARD" },
): Promise<CheckoutResult> {
  const ticket = await openTicketWith(context, lines);
  return performCheckout(
    context,
    parseOrThrow(checkoutBodySchema, { orderId: ticket.id, ...payment }),
  );
}

/** The first two steps on their own, for tests that need the ticket before paying it. */
export async function openTicketWith(context: RequestContext, lines: SaleLine[]) {
  const ticket = await openDirectSaleTicket(context);
  if (lines.length === 0) return ticket;
  return saveTicketItems(context, ticket.id, { version: ticket.version, items: lines });
}

/** Builds a validated checkout payload for an existing ticket. */
export function paymentFor(orderId: number, payment: SalePayment = { paymentMethod: "CARD" }) {
  return parseOrThrow(checkoutBodySchema, { orderId, ...payment });
}
