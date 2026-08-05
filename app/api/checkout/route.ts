import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { performCheckout } from "@/lib/services/checkout";
import { parseJsonBody } from "@/lib/validation/parse";
import { checkoutBodySchema } from "@/lib/validation/schemas";

export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "orders:create");

  // API-01: the schema, not this handler, decides what a valid ticket is —
  // and it decides before a single row is read. The previous version filled
  // every missing field with a default (`paymentMethod ?? "CARD"`), which
  // turned a malformed request into a silently mispriced card sale.
  const body = await parseJsonBody(request, checkoutBodySchema);
  const result = await performCheckout(context, body);
  return jsonOk(result, { status: 201 });
});
