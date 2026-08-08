import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { saveTicketItems } from "@/lib/services/tickets";
import { parseIdParam, parseJsonBody } from "@/lib/validation/parse";
import { saveTicketItemsSchema } from "@/lib/validation/schemas";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * ORD-05: saves the ticket's lines against the version the caller read.
 *
 * A stale version returns 409, never a silent overwrite — DEC-08's rule for
 * two devices editing the same ticket. The response always carries the
 * ticket as it now stands (including its new version), so a client never has
 * to guess what to send next.
 *
 * No idempotency key here, unlike the financial endpoints: the version *is*
 * the safety mechanism. Replaying the same save twice with the same version
 * fails the second time by construction, and a duplicate line list is not a
 * duplicate charge — nothing has been taken from the customer yet.
 */
export const PUT = apiRoute<RouteParams>(async (request: NextRequest, { params }) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "orders:create");

  const { id } = await params;
  const orderId = parseIdParam(id, "Identifiant ticket");
  const body = await parseJsonBody(request, saveTicketItemsSchema);

  const ticket = await saveTicketItems(context, orderId, body);
  return jsonOk(ticket);
});
