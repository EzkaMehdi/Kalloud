import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { cancelTicket } from "@/lib/services/tickets";
import { parseIdParam, parseJsonBody } from "@/lib/validation/parse";
import { cancelTicketSchema } from "@/lib/validation/schemas";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * ORD-06: cancels an open ticket.
 *
 * Gated by "orders:cancel_open", the permission DEC-07 already defined for
 * exactly this — distinct from "orders:refund", because cancelling a ticket
 * nobody has paid for is routine service work, while reversing a completed
 * sale is not (ORD-10).
 *
 * The motive is required by the schema and by the database, and the whole
 * thing is written to the audit log with its actor: three layers saying the
 * same thing, because "aucune annulation silencieuse" is the criterion.
 */
export const POST = apiRoute<RouteParams>(async (request: NextRequest, { params }) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "orders:cancel_open");

  const { id } = await params;
  const orderId = parseIdParam(id, "Identifiant ticket");
  const body = await parseJsonBody(request, cancelTicketSchema);

  const ticket = await cancelTicket(context, orderId, body);
  return jsonOk(ticket);
});
