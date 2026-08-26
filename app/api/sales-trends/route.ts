import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { getSalesTrendsForPeriod } from "@/lib/services/trends";
import { parseSearchParams } from "@/lib/validation/parse";
import { metricsQuerySchema } from "@/lib/validation/schemas";

/**
 * BI-11: the route `BI-08` deliberately left unbuilt (own livrable: "le
 * service et ses tests, pas un écran"). `null` (no active service for
 * `period=service`) still answers `200` with `null` — an honest "nothing to
 * show yet", not a `404` for a request that named a perfectly valid period.
 */
export const GET = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "dashboard:view");

  const query = parseSearchParams(request, metricsQuerySchema);
  const trends = await getSalesTrendsForPeriod(context.locationId, query);
  return jsonOk(trends);
});
