import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { getCashReconciliation } from "@/lib/services/cash-reconciliation";

/**
 * BI-11: the route `BI-09` deliberately left unbuilt (own livrable: "le
 * service et ses tests, pas un écran"). No query — the reconciliation has
 * exactly one subject, the current or last-closed session (`DEC-04`), the
 * same reason `/api/cash-summary` takes none either.
 */
export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  requirePermission(context.role, "dashboard:view");

  const reconciliation = await getCashReconciliation(context.locationId);
  return jsonOk(reconciliation);
});
