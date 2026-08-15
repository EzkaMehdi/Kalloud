import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { closeCurrentBusinessDay } from "@/lib/services/business-day";
import { parseJsonBody } from "@/lib/validation/parse";
import { closeBusinessDaySchema } from "@/lib/validation/schemas";

/**
 * CASH-02: closes the active service and stops there — opening the next one
 * is its own endpoint and its own confirmation (DEC-04). It does not demand
 * `business_day:open` on top of `business_day:close`; that second permission
 * was only needed back when closing also opened, so someone allowed to close
 * but not to open could not close at all.
 *
 * CASH-05: the payload is the count. The body is required again — closing on
 * an unstated amount is exactly what "montant vide ou invalide refusé"
 * forbids — so a stale client posting nothing now gets a 400 naming the
 * missing field rather than silently closing on a calculated figure.
 */
export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "business_day:close");

  const body = await parseJsonBody(request, closeBusinessDaySchema);
  const result = await closeCurrentBusinessDay(context, body);
  return jsonOk(result);
});
