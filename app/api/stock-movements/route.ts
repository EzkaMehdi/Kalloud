import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { apiRoute, jsonOk } from "@/lib/http";
import { listStockMovementsHistory } from "@/lib/repositories/stock-movements";
import { parseSearchParams } from "@/lib/validation/parse";
import { stockMovementsHistoryQuerySchema } from "@/lib/validation/schemas";

/**
 * BI-02: "stock" — the establishment's whole ledger, across every product,
 * filterable and paginated, for the cockpit's drill-down. Distinct from the
 * per-product read `listStockMovements` (STK-01) already serves — this has
 * no single `product_id` to scope by first. Reserved like `/api/dashboard`
 * (`dashboard:view`, OWNER/MANAGER); reading the stock levels themselves
 * (`/api/products`) stays open to a cashier, but the movement *history* is
 * reporting detail.
 */
export const GET = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "dashboard:view");
  const query = parseSearchParams(request, stockMovementsHistoryQuerySchema);
  return jsonOk(await listStockMovementsHistory(pool, context.locationId, query));
});
