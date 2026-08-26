import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, csvOk } from "@/lib/http";
import { exportStockCsv } from "@/lib/services/exports";
import { parseSearchParams } from "@/lib/validation/parse";
import { exportRangeQuerySchema } from "@/lib/validation/schemas";

/**
 * BI-12/DEC-09: "stock" — one CSV file, built on `listStockMovementsHistory`
 * (`BI-02`), the same read `/api/stock-movements` already serves paginated.
 * Reserved like every other cockpit reporting route (`dashboard:view`,
 * OWNER/MANAGER).
 */
export const GET = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "dashboard:view");

  const range = parseSearchParams(request, exportRangeQuerySchema);
  const csv = await exportStockCsv(context.locationId, range);
  return csvOk(csv, "stock.csv");
});
