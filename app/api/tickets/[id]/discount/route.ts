import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { setTicketDiscountAmount } from "@/lib/services/tickets";
import { parseIdParam, parseJsonBody } from "@/lib/validation/parse";
import { setDiscountSchema } from "@/lib/validation/schemas";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * ORD-11: applies or clears a ticket's discount.
 *
 * `orders:discount` (OWNER/MANAGER, DEC-07) — a cashier can ring a sale up
 * but cannot decide to charge less for it. Guarded by the same optimistic
 * version as the lines, because a discount is part of the ticket's state:
 * two devices must not be able to set one against a line list that has
 * since changed.
 */
export const PUT = apiRoute<RouteParams>(async (request: NextRequest, { params }) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "orders:discount");

  const { id } = await params;
  const orderId = parseIdParam(id, "Identifiant ticket");
  const body = await parseJsonBody(request, setDiscountSchema);

  return jsonOk(await setTicketDiscountAmount(context, orderId, body));
});
