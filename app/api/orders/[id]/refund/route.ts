import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { requireIdempotencyKey, withIdempotency } from "@/lib/idempotency";
import { refundOrder } from "@/lib/services/refunds";
import { parseIdParam, parseJsonBody } from "@/lib/validation/parse";
import { refundOrderSchema } from "@/lib/validation/schemas";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * ORD-10: refunds a paid order.
 *
 * "Permission manager" from the task, which DEC-07 already encodes as
 * `orders:refund` (OWNER and MANAGER only) — a cashier can cancel an unpaid
 * ticket but cannot hand money back.
 *
 * Idempotency-keyed like the checkout, and for the same reason: a refund
 * moves money. A retry after a lost response must return the refund that was
 * already recorded rather than hand the customer their money twice (API-02,
 * DEC-08).
 */
export const POST = apiRoute<RouteParams>(async (request: NextRequest, { params }) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "orders:refund");

  const idempotencyKey = requireIdempotencyKey(request);
  const { id } = await params;
  const orderId = parseIdParam(id, "Identifiant commande");
  const body = await parseJsonBody(request, refundOrderSchema);

  const { result, replayed } = await withIdempotency(
    context,
    { endpoint: "POST /api/orders/:id/refund", key: idempotencyKey, payload: { orderId, ...body } },
    () => refundOrder(context, orderId, body),
  );

  const response = jsonOk(result, { status: 201 });
  if (replayed) {
    response.headers.set("Idempotent-Replay", "true");
  }
  return response;
});
