import { withTransaction } from "../db";
import { ConflictError, NotFoundError, ValidationError, isUniqueViolation } from "../errors";
import { recordAuditEvent } from "../audit";
import { fromCents, toCents } from "../money";
import { getActiveBusinessDay } from "../repositories/business-days";
import { nextOrderNumber } from "../repositories/orders";
import { lockProductsForSale } from "../repositories/products";
import { findDiningTable } from "../repositories/tables";
import {
  bumpTicketVersion,
  cancelTicket as cancelTicketRow,
  createOpenTicket,
  findOpenTicketForTable,
  findTicketById,
  listOpenCounterTickets,
  loadTicket,
  lockTicket,
  refreshTicketTotal,
  replaceTicketItems,
  setTicketDiscount,
  setTicketNotes,
  type Ticket,
} from "../repositories/tickets";
import type { RequestContext } from "../context";
import type { CancelTicketBody, SaveTicketItemsBody, SetDiscountBody } from "../validation/schemas";

/**
 * ORD-02/ORD-04/ORD-05: the open ticket's lifecycle up to (but not
 * including) payment, which stays with SALE-03's checkout.
 *
 * The rule that shapes everything here: a ticket's contents are decided by
 * the server from its own catalog, exactly like a sale's are. The client
 * sends product ids and quantities; prices, availability and totals come
 * back from the database (SALE-01/SALE-04's "les IDs et prix viennent
 * uniquement du catalogue serveur", which does not stop applying just
 * because the order is not paid yet).
 */

/** Loads a ticket, refusing to serve one from another establishment as if it did not exist (SEC-06). */
export async function getTicket(context: RequestContext, orderId: number): Promise<Ticket> {
  const ticket = await withTransaction((client) => loadTicket(client, context.locationId, orderId));
  if (!ticket) {
    throw new NotFoundError("Ticket introuvable.");
  }
  return ticket;
}

/**
 * ORD-04: opens a table's ticket, or resumes the one already there.
 *
 * Idempotent by intent — tapping a table twice, or two servers approaching
 * it at once, must land on the same ticket rather than create a second one.
 * The database's `one_open_order_per_table` index is what actually
 * guarantees that; the read below is the fast path, and the unique-violation
 * branch is the correct answer to losing the race, not a retry-until-it-works
 * loop.
 */
export async function openOrResumeTableTicket(
  context: RequestContext,
  tableId: number,
): Promise<{ ticket: Ticket; created: boolean }> {
  return withTransaction(async (client) => {
    const table = await findDiningTable(client, context.locationId, tableId);
    if (!table) {
      throw new NotFoundError("Table introuvable.");
    }

    const existing = await findOpenTicketForTable(client, context.locationId, tableId);
    if (existing) {
      const ticket = await loadTicket(client, context.locationId, existing.id);
      return { ticket: ticket!, created: false };
    }

    const businessDay = await getActiveBusinessDay(client, context.locationId);
    if (!businessDay) {
      throw new ValidationError("Ouvrez une journée de caisse avant de prendre une commande.");
    }

    const orderNumber = await nextOrderNumber(client, context.locationId);
    let created;
    try {
      created = await createOpenTicket(client, context.locationId, {
        tableId,
        businessDayId: businessDay.id,
        orderNumber,
        createdBy: context.userId,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Another device opened this table's ticket between our read and
        // this insert. Their ticket is as valid as the one we were about to
        // create, so the honest answer is a conflict the caller resolves by
        // reloading — not a duplicate, and not a silent overwrite.
        throw new ConflictError(
          "Un ticket vient d'être ouvert sur cette table depuis un autre appareil. Rechargez le plan de salle.",
        );
      }
      throw error;
    }

    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "order.open",
      targetType: "order",
      targetId: created.id,
      after: { tableId, orderNumber: created.order_number },
    });

    const ticket = await loadTicket(client, context.locationId, created.id);
    return { ticket: ticket!, created: true };
  });
}

/** ORD-07 will fold this into one journey with the table flow; for now a counter sale gets its own ticket. */
export async function openDirectSaleTicket(context: RequestContext): Promise<Ticket> {
  return withTransaction(async (client) => {
    const businessDay = await getActiveBusinessDay(client, context.locationId);
    if (!businessDay) {
      throw new ValidationError("Ouvrez une journée de caisse avant de prendre une commande.");
    }

    const orderNumber = await nextOrderNumber(client, context.locationId);
    const created = await createOpenTicket(client, context.locationId, {
      tableId: null,
      businessDayId: businessDay.id,
      orderNumber,
      createdBy: context.userId,
    });

    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "order.open",
      targetType: "order",
      targetId: created.id,
      after: { tableId: null, orderNumber: created.order_number },
    });

    const ticket = await loadTicket(client, context.locationId, created.id);
    return ticket!;
  });
}

/**
 * ORD-05: persists the ticket's lines, priced from the catalog, guarded by
 * the caller's expected version.
 *
 * Lines are merged per product before pricing, for the same reason
 * performCheckout merges them (API-02): a ticket holding the same product
 * twice is one line of a larger quantity, and treating it as two invites
 * exactly the per-line arithmetic that let stock go negative.
 */
export async function saveTicketItems(
  context: RequestContext,
  orderId: number,
  input: SaveTicketItemsBody,
): Promise<Ticket> {
  return withTransaction(async (client) => {
    const locked = await lockTicket(client, context.locationId, orderId);
    if (!locked) {
      throw new NotFoundError("Ticket introuvable.");
    }
    if (locked.status !== "OPEN") {
      // A paid or cancelled order is a record, not a working document.
      throw new ValidationError(
        "Ce ticket n'est plus modifiable : il a déjà été encaissé ou annulé.",
      );
    }

    const merged = mergeByProduct(input.items);

    let priced: { productId: number; quantity: number; unitPrice: string; notes: string | null }[] =
      [];
    if (merged.length > 0) {
      const pricing = await lockProductsForSale(
        client,
        context.locationId,
        merged.map((item) => item.productId),
      );
      const pricingById = new Map(pricing.map((row) => [row.id, row]));

      priced = merged.map((item) => {
        const product = pricingById.get(item.productId);
        if (!product) {
          // Same conflation as the checkout: an id from another
          // establishment and a deactivated product are both "not sellable
          // here", and saying which would leak the difference (SEC-06).
          throw new NotFoundError("Produit introuvable.");
        }
        return {
          productId: item.productId,
          quantity: item.quantity,
          // The price is snapshotted onto the line as it is added, so a
          // ticket keeps quoting what the customer was told even if the
          // catalog changes mid-service. It is a server-side price either
          // way — never a number the client sent.
          unitPrice: product.price,
          notes: item.notes,
        };
      });
    }

    await replaceTicketItems(client, orderId, priced);
    // ORD-08: `undefined` leaves the note alone (a save that only touches
    // lines), `null` clears it. Distinguishing the two is why the schema
    // makes this nullish rather than optional.
    if (input.notes !== undefined) {
      await setTicketNotes(client, context.locationId, orderId, input.notes?.trim() || null);
    }
    // Bumped after the write, inside the same transaction: a caller whose
    // version is stale never reaches this, because the UPDATE matches no row
    // and the whole transaction rolls back with its line changes.
    await bumpTicketVersion(client, context.locationId, orderId, input.version);
    const newTotal = await refreshTicketTotal(client, context.locationId, orderId);

    // ORD-11: a percentage discount is relative to the ticket, so changing
    // the lines changes what it is worth. Re-resolving it here is what stops
    // a "10 %" set on a 20 € ticket from staying frozen at 2 € once the
    // ticket reaches 50 €.
    if (locked.status === "OPEN") {
      const current = await findTicketById(client, context.locationId, orderId);
      if (current?.discount_type && current.discount_value) {
        await setTicketDiscount(client, context.locationId, orderId, {
          type: current.discount_type,
          value: current.discount_value,
          amount: fromCents(
            resolveDiscountCents(
              { type: current.discount_type, value: toCents(current.discount_value) },
              toCents(newTotal),
            ),
          ),
          reason: current.discount_reason!,
        });
      }
    }

    const ticket = await loadTicket(client, context.locationId, orderId);
    return ticket!;
  });
}

/**
 * ORD-06: cancels an open ticket, with a motive that is recorded, audited,
 * and impossible to omit.
 *
 * No stock is returned and no payment is reversed, because neither ever
 * happened: an open ticket has taken nothing from the customer and nothing
 * from the shelf — SALE-03 decrements stock at payment. Cancelling one is
 * therefore a lifecycle transition, not a financial reversal; that is
 * ORD-10's job, on a `PAID` order.
 */
export async function cancelTicket(
  context: RequestContext,
  orderId: number,
  input: CancelTicketBody,
): Promise<Ticket> {
  return withTransaction(async (client) => {
    const locked = await lockTicket(client, context.locationId, orderId);
    if (!locked) {
      throw new NotFoundError("Ticket introuvable.");
    }
    if (locked.status !== "OPEN") {
      throw new ConflictError(
        locked.status === "PAID"
          ? "Ce ticket a déjà été encaissé : une vente payée s'annule par un remboursement."
          : "Ce ticket est déjà annulé.",
      );
    }

    const before = await loadTicket(client, context.locationId, orderId);
    await cancelTicketRow(client, context.locationId, orderId, input.reason);

    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "order.cancel",
      targetType: "order",
      targetId: orderId,
      before: { status: "OPEN", total: before?.total_amount, itemCount: before?.items.length },
      after: { status: "CANCELLED", reason: input.reason },
    });

    const ticket = await loadTicket(client, context.locationId, orderId);
    return ticket!;
  });
}

/** ORD-07: the counter's open tickets, which no floor-plan card can surface. */
export async function listOpenCounterSales(context: RequestContext) {
  return withTransaction((client) => listOpenCounterTickets(client, context.locationId));
}

interface MergedTicketItem {
  productId: number;
  quantity: number;
  notes: string | null;
}

function mergeByProduct(items: SaveTicketItemsBody["items"]): MergedTicketItem[] {
  const merged = new Map<number, MergedTicketItem>();
  for (const item of items) {
    const note = item.notes?.trim() || null;
    const existing = merged.get(item.productId);
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

/** Total of a ticket's lines in cents, for callers that need to compare against a payment split. */
export function ticketTotalCents(ticket: Ticket): number {
  return ticket.items.reduce((sum, item) => sum + toCents(item.unit_price) * item.quantity, 0);
}

/** Formats a cents total back into the DECIMAL string shape the API returns. */
export function formatTicketTotal(cents: number): string {
  return fromCents(cents);
}

/**
 * ORD-11: applies or clears a bounded discount on an open ticket.
 *
 * The amount is resolved here, against the ticket's current total, and
 * stored — a percentage recomputed later against a different total would
 * print a different figure on a receipt for a sale that already happened
 * (see migration 0014). Changing the ticket's lines afterwards re-resolves
 * it, which is why `saveTicketItems` recomputes it too.
 *
 * Reserved to OWNER/MANAGER at the route (`orders:discount`, DEC-07): a
 * discount is money given away, and DEC-05 puts it on the same footing as a
 * refund rather than as routine service work.
 */
export async function setTicketDiscountAmount(
  context: RequestContext,
  orderId: number,
  input: SetDiscountBody,
): Promise<Ticket> {
  return withTransaction(async (client) => {
    const locked = await lockTicket(client, context.locationId, orderId);
    if (!locked) {
      throw new NotFoundError("Ticket introuvable.");
    }
    if (locked.status !== "OPEN") {
      throw new ValidationError(
        "Ce ticket n'est plus modifiable : il a déjà été encaissé ou annulé.",
      );
    }

    const before = await loadTicket(client, context.locationId, orderId);
    const totalCents = toCents(before!.total_amount);
    const resolved = input.discount
      ? {
          type: input.discount.type,
          value: fromCents(input.discount.value),
          amount: fromCents(resolveDiscountCents(input.discount, totalCents)),
          reason: input.discount.reason,
        }
      : null;

    await setTicketDiscount(client, context.locationId, orderId, resolved);
    await bumpTicketVersion(client, context.locationId, orderId, input.version);

    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: resolved ? "order.discount" : "order.discount_removed",
      targetType: "order",
      targetId: orderId,
      before: { discount: before!.discount_amount },
      after: resolved
        ? {
            type: resolved.type,
            value: resolved.value,
            amount: resolved.amount,
            reason: resolved.reason,
          }
        : null,
    });

    const ticket = await loadTicket(client, context.locationId, orderId);
    return ticket!;
  });
}

/**
 * A discount can never exceed the order it applies to: DEC-05 describes it
 * as included in the total, and a negative total is not a sale — it is a
 * refund wearing a disguise (ORD-10 is how money goes back).
 */
export function resolveDiscountCents(
  discount: { type: "FIXED" | "PERCENT"; value: number },
  totalCents: number,
): number {
  const raw =
    discount.type === "FIXED"
      ? discount.value
      : // `value` is in cents-of-a-percent: 10 % arrives as 1000.
        Math.round((totalCents * discount.value) / 10_000);
  return Math.min(raw, totalCents);
}
