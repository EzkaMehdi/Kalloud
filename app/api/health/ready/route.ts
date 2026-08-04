import { pingDatabase } from "@/lib/db";
import { apiRoute, jsonOk } from "@/lib/http";

/**
 * FND-09: readiness checks the one dependency that matters (Postgres).
 * If pingDatabase() throws a connectivity error, apiRoute's shared error
 * mapping turns it into a 503 without ever crashing the process (P0-09).
 */
export const GET = apiRoute(async () => {
  await pingDatabase();
  return jsonOk({ status: "ready" });
});
