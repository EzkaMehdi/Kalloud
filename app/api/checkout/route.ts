import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { requireIdempotencyKey, withIdempotency } from "@/lib/idempotency";
import { performCheckout } from "@/lib/services/checkout";
import { parseJsonBody } from "@/lib/validation/parse";
import { checkoutBodySchema } from "@/lib/validation/schemas";

export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "orders:create");

  // The key is read before the body so a client that forgot it is told so
  // immediately, without the request being parsed or priced.
  const idempotencyKey = requireIdempotencyKey(request);
  // API-01: the schema, not this handler, decides what a valid ticket is —
  // and it decides before a single row is read. The previous version filled
  // every missing field with a default (`paymentMethod ?? "CARD"`), which
  // turned a malformed request into a silently mispriced card sale.
  const body = await parseJsonBody(request, checkoutBodySchema);

  // API-02: a double-click, or a retry after a lost response, resolves to
  // the one sale that was actually recorded (DEC-08).
  const { result, replayed } = await withIdempotency(
    context,
    { endpoint: "POST /api/checkout", key: idempotencyKey, payload: body },
    () => performCheckout(context, body),
  );

  const response = jsonOk(result, { status: 201 });
  if (replayed) {
    response.headers.set("Idempotent-Replay", "true");
  }
  return response;
});
