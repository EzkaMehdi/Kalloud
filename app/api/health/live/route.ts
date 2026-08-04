import { apiRoute, jsonOk } from "@/lib/http";

/**
 * FND-09: liveness only asserts "the process can respond", never touching
 * the database, so an outage there cannot make an orchestrator kill and
 * restart a perfectly healthy app server (see /api/health/ready for that).
 */
export const GET = apiRoute(async () => {
  return jsonOk({ status: "live" });
});
