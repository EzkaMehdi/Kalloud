import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { closeCurrentBusinessDay } from "@/lib/services/business-day";

/**
 * CASH-02: closes the active service and stops there.
 *
 * Two things changed from the combined action this replaces. It no longer
 * demands `business_day:open` on top of `business_day:close` — that second
 * permission was only needed because closing also opened the next service,
 * so someone allowed to close but not to open could not close at all. And it
 * no longer reads a body: `nextOpeningCash` fed the reopen half, which now
 * belongs to `POST /api/business-day` and its own explicit confirmation
 * (DEC-04). A stale client still posting `{nextOpeningCash}` here has that
 * body ignored and gets exactly one closed service — which is the point:
 * the failure mode of an out-of-date caller is "no service was opened",
 * never "a service was opened without anyone choosing to".
 */
export const POST = apiRoute(async () => {
  const context = await requireRequestContext();
  requirePermission(context.role, "business_day:close");

  const result = await closeCurrentBusinessDay(context);
  return jsonOk(result);
});
