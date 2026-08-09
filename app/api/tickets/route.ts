import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import {
  listOpenCounterSales,
  openDirectSaleTicket,
  openOrResumeTableTicket,
} from "@/lib/services/tickets";
import { parseJsonBody } from "@/lib/validation/parse";
import { openTicketSchema } from "@/lib/validation/schemas";

/**
 * ORD-07: the counter's open tickets.
 *
 * A table's ticket is reachable from its card on the floor plan; a direct
 * sale belongs to no table and would otherwise be unreachable the moment the
 * drawer closes — opened, abandoned, and impossible to resume or cancel.
 * "Un seul parcours" means the counter gets the same "reprendre un ticket"
 * affordance a table already has.
 */
export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  return jsonOk(await listOpenCounterSales(context));
});

/**
 * ORD-02/ORD-04: opens a table's ticket, or resumes the one already on it.
 *
 * Deliberately not idempotency-keyed like the financial endpoints (API-02):
 * opening a ticket twice is not a duplicate to prevent but a normal outcome
 * to converge on — the second call returns the first call's ticket, and the
 * database's `one_open_order_per_table` index guarantees there is only ever
 * one to return. `created` tells the caller which happened, so the UI can
 * say "ticket repris" rather than "nouvelle commande".
 */
export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "orders:create");

  const body = await parseJsonBody(request, openTicketSchema);

  if (body.tableId === null || body.tableId === undefined) {
    const ticket = await openDirectSaleTicket(context);
    return jsonOk({ ticket, created: true }, { status: 201 });
  }

  const { ticket, created } = await openOrResumeTableTicket(context, body.tableId);
  return jsonOk({ ticket, created }, { status: created ? 201 : 200 });
});
