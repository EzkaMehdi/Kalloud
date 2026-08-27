import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, csvOk } from "@/lib/http";
import { exportCashCsv } from "@/lib/services/exports";
import { parseSearchParams } from "@/lib/validation/parse";
import { metricsQuerySchema } from "@/lib/validation/schemas";

/**
 * BI-12/DEC-09: "caisse" — one CSV file, built on `listCashMovementsHistory`
 * (`BI-02`), the same read `/api/cash-movements/history` already serves
 * paginated. Reserved like every other cockpit reporting route
 * (`dashboard:view`, OWNER/MANAGER).
 *
 * BI-14: `metricsQuerySchema` (`BI-03`), same reasoning as
 * `app/api/exports/sales/route.ts` — the export follows the cockpit's own
 * currently-selected period (`GATE-6`).
 */
export const GET = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "dashboard:view");

  const query = parseSearchParams(request, metricsQuerySchema);
  const csv = await exportCashCsv(context.locationId, query);
  return csvOk(csv, "caisse.csv");
});
