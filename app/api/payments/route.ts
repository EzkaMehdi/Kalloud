import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { apiRoute, jsonOk } from "@/lib/http";
import { listPaymentsHistory } from "@/lib/repositories/payments";
import { parseSearchParams } from "@/lib/validation/parse";
import { paymentsHistoryQuerySchema } from "@/lib/validation/schemas";

/**
 * BI-02: "paiements" — every CHARGE/REFUND line, filterable and paginated,
 * for the cockpit's drill-down. `listPaymentsForOrder` (SALE-02) stays the
 * per-order read the receipt uses; this is the establishment-wide one.
 * Reserved like `/api/dashboard` (`dashboard:view`, OWNER/MANAGER) — see
 * app/api/sales/route.ts's note for why this differs from `/api/orders`.
 */
export const GET = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "dashboard:view");
  const query = parseSearchParams(request, paymentsHistoryQuerySchema);
  return jsonOk(await listPaymentsHistory(pool, context.locationId, query));
});
