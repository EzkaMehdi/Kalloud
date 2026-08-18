import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { apiRoute, jsonOk } from "@/lib/http";
import { listCashMovementsHistory } from "@/lib/repositories/cash-movements";
import { parseSearchParams } from "@/lib/validation/parse";
import { cashMovementsHistoryQuerySchema } from "@/lib/validation/schemas";

/**
 * BI-02: "caisse" — the establishment's whole movement history, filterable
 * and paginated, for the cockpit's drill-down. Deliberately its own route
 * rather than a widened `GET /api/cash-movements` (CASH-07): that endpoint
 * answers "what is in the open service's journal right now" and returns
 * `[]` with no service open, on purpose — folding a historical query into
 * it would either break that contract or quietly reintroduce "yesterday's
 * movements under today's balance", the exact ambiguity CASH-07 closed.
 * Reserved like `/api/dashboard` (`dashboard:view`, OWNER/MANAGER); the live
 * journal at `/api/cash-movements` stays open to a cashier's own shift.
 */
export const GET = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "dashboard:view");
  const query = parseSearchParams(request, cashMovementsHistoryQuerySchema);
  return jsonOk(await listCashMovementsHistory(pool, context.locationId, query));
});
