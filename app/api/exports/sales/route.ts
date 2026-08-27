import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, csvOk } from "@/lib/http";
import { exportSalesCsv } from "@/lib/services/exports";
import { parseSearchParams } from "@/lib/validation/parse";
import { metricsQuerySchema } from "@/lib/validation/schemas";

/**
 * BI-12/DEC-09: "ventes" — one CSV file, built on `listSoldItems` (`BI-02`),
 * the same read `/api/sales` already serves paginated. Reserved like every
 * other cockpit reporting route (`dashboard:view`, OWNER/MANAGER).
 *
 * BI-14: takes `metricsQuerySchema` (`BI-03`) — the same period contract
 * `/api/performance-comparison`/`/api/sales-trends` already use — rather
 * than a bespoke `from`/`to` pair, so the file downloaded from the cockpit's
 * "Ventes" link always describes exactly the period the cockpit had open,
 * never the establishment's whole history regardless of what was on screen
 * (`GATE-6`, "l'export respecte exactement les filtres").
 */
export const GET = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "dashboard:view");

  const query = parseSearchParams(request, metricsQuerySchema);
  const csv = await exportSalesCsv(context.locationId, query);
  return csvOk(csv, "ventes.csv");
});
