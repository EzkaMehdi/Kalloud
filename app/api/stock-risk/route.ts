import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { getStockAtRisk } from "@/lib/services/stock-risk";

/**
 * BI-10: the cockpit's stock-at-risk block. Reserved like the other BI-0x
 * reporting routes (`dashboard:view`, OWNER/MANAGER) — see
 * app/api/sales/route.ts's note for why this differs from `/api/products`,
 * which any authenticated role reads to sell.
 */
export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  requirePermission(context.role, "dashboard:view");
  return jsonOk(await getStockAtRisk(context.locationId));
});
