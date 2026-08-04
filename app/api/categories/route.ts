import { pool } from "@/lib/db";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { listCategories } from "@/lib/repositories/categories";

export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  const categories = await listCategories(pool, context.locationId);
  return jsonOk(categories);
});
