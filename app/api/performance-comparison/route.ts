import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { getPerformanceComparison } from "@/lib/services/performance";
import { parseSearchParams } from "@/lib/validation/parse";
import { metricsQuerySchema } from "@/lib/validation/schemas";

/**
 * BI-11: the route `BI-07` deliberately left unbuilt — its own livrable was
 * "le service et ses tests, pas un écran". `metricsQuerySchema` (`BI-03`)
 * already mirrors `MetricsQuery` field-for-field, so this route validates
 * and forwards, nothing more.
 */
export const GET = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "dashboard:view");

  const query = parseSearchParams(request, metricsQuerySchema);
  const comparison = await getPerformanceComparison(context.locationId, query);
  return jsonOk(comparison);
});
