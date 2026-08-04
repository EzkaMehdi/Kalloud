import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { apiRoute, jsonOk } from "@/lib/http";
import { getActiveBusinessDay } from "@/lib/repositories/business-days";
import { getCashBalance } from "@/lib/repositories/cash-movements";

export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  const day = await getActiveBusinessDay(pool, context.locationId);
  if (!day) {
    return jsonOk({ balance: "0.00" });
  }
  const balance = await getCashBalance(pool, context.locationId, day.id);
  return jsonOk({ balance });
});
