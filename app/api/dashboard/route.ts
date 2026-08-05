import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { getDashboardSummary } from "@/lib/services/dashboard";
import { parseSearchParams } from "@/lib/validation/parse";
import { dashboardQuerySchema } from "@/lib/validation/schemas";

export const GET = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "dashboard:view");

  // `?period=nonsense` silently fell back to "day" and `?month=99` reached
  // the date arithmetic as-is. Both are now explicit 400s (API-01); an
  // absent `period` still legitimately defaults to "day", via the schema.
  const { period, year, month } = parseSearchParams(request, dashboardQuerySchema);

  const summary = await getDashboardSummary(context.locationId, { period, year, month });
  return jsonOk(summary);
});
