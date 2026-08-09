import type { NextRequest } from "next/server";
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
 */
export const GET = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  const query = parseSearchParams(request, orderHistoryQuerySchema);
  return jsonOk(await listOrderHistory(pool, context.locationId, query));
});
