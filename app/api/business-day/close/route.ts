import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk, readJsonBody } from "@/lib/http";
import { closeAndReopenBusinessDay } from "@/lib/services/business-day";

interface CloseBody {
  nextOpeningCash?: number;
}

export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "business_day:close");
  requirePermission(context.role, "business_day:open");

  const body = await readJsonBody<CloseBody>(request);
  const result = await closeAndReopenBusinessDay(context, Number(body.nextOpeningCash ?? 0));
  return jsonOk(result);
});
