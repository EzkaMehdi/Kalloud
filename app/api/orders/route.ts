import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { apiRoute, jsonOk } from "@/lib/http";
import { listOrders } from "@/lib/repositories/orders";

export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  const orders = await listOrders(pool, context.locationId);
  return jsonOk(orders);
});
