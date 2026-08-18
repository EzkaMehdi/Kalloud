import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { apiRoute, jsonOk } from "@/lib/http";
import { listSoldItems } from "@/lib/repositories/orders";
import { parseSearchParams } from "@/lib/validation/parse";
import { soldItemsQuerySchema } from "@/lib/validation/schemas";

/**
 * BI-02: "ventes" — every line actually charged, filterable and paginated,
 * for the cockpit's drill-down (BI-08, BI-11). Reserved like `/api/dashboard`
 * (`dashboard:view`, OWNER/MANAGER): unlike `/api/orders` (ORD-12, the
 * day-to-day order list a cashier also reads to pull up a receipt), this is
 * reporting detail for Phase 6's cockpit, not an operational screen.
 */
export const GET = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "dashboard:view");
  const query = parseSearchParams(request, soldItemsQuerySchema);
  return jsonOk(await listSoldItems(pool, context.locationId, query));
});
