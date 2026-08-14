import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { apiRoute, jsonOk } from "@/lib/http";
import { getActiveBusinessDay } from "@/lib/repositories/business-days";
import { openNewBusinessDay } from "@/lib/services/business-day";
import { parseJsonBody } from "@/lib/validation/parse";
import { openBusinessDaySchema } from "@/lib/validation/schemas";

export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  const day = await getActiveBusinessDay(pool, context.locationId);
  if (!day) {
    throw new NotFoundError("Aucune journée ouverte.");
  }
  return jsonOk(day);
});

// CASH-01: the only way into `business_days` used to be the close endpoint,
// which back then also reopened, and which requires an active day to close
// first. A location that never had one — every new establishment, on day
// one — had no way to open its first through the API at all.
//
// CASH-02: this is now the *only* way a service is opened. Closing no longer
// opens anything, so every business day in the system traces back to a
// deliberate call here (DEC-04).
export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "business_day:open");

  const body = await parseJsonBody(request, openBusinessDaySchema);
  const opened = await openNewBusinessDay(context, body.openingCash ?? 0);
  return jsonOk(opened, { status: 201 });
});
