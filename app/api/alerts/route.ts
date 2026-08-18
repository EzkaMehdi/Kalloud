import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { getAlerts } from "@/lib/services/alerts";

/**
 * BI-06: the cockpit's "à traiter maintenant" block. Reserved like the
 * other BI-0x reads (`dashboard:view`, OWNER/MANAGER) — reviewing a cash
 * discrepancy or a stalled ticket across the whole establishment is
 * reporting, not a cashier's day-to-day action.
 */
export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  requirePermission(context.role, "dashboard:view");
  return jsonOk(await getAlerts(context));
});
