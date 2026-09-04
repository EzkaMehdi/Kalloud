import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { apiRoute, jsonOk } from "@/lib/http";
import { listOrderHistory } from "@/lib/repositories/orders";
import { parseSearchParams } from "@/lib/validation/parse";
import { orderHistoryQuerySchema } from "@/lib/validation/schemas";

/**
 * ORD-12: the real order history — filterable by status and date range,
 * paginated, and returning the total so a caller can say "20 of 137".
 *
 * Replaces the fixed "last 100, take the first 8" this endpoint used to be,
 * which was the last place the Bilan's history was effectively hardcoded.
 *
 * OPS-08: gated on `dashboard:view`, like its sibling history endpoints
 * `/api/sales` and `/api/payments`. It was the only door left open to the
 * same data: DEC-07 says a cashier sees their own service and "pas
 * l'historique complet", the Bilan screen is hidden from them and
 * `/api/dashboard` refuses them — but this endpoint returned the
 * establishment's paid orders, filterable by date and paginated, with the
 * amounts and the name of whoever took each sale.
 */
export const GET = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "dashboard:view");
  const query = parseSearchParams(request, orderHistoryQuerySchema);
  return jsonOk(await listOrderHistory(pool, context.locationId, query));
});
