import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { apiRoute, jsonOk } from "@/lib/http";
import { getActiveBusinessDay } from "@/lib/repositories/business-days";

export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  const day = await getActiveBusinessDay(pool, context.locationId);
  if (!day) {
    throw new NotFoundError("Aucune journée ouverte.");
  }
  return jsonOk(day);
});
