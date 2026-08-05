import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { closeAndReopenBusinessDay } from "@/lib/services/business-day";
import { parseJsonBody } from "@/lib/validation/parse";
import { closeBusinessDaySchema } from "@/lib/validation/schemas";

export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "business_day:close");
  requirePermission(context.role, "business_day:open");

  // `Number(body.nextOpeningCash ?? 0)` used to turn "abc" into NaN and hand
  // it straight to a DECIMAL column; the schema rejects it first (API-01).
  const body = await parseJsonBody(request, closeBusinessDaySchema);
  const result = await closeAndReopenBusinessDay(context, body.nextOpeningCash ?? 0);
  return jsonOk(result);
});
