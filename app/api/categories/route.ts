import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { apiRoute, jsonOk } from "@/lib/http";
import { listCategories } from "@/lib/repositories/categories";
import { addCategory } from "@/lib/services/configuration";
import { parseJsonBody } from "@/lib/validation/parse";
import { categorySchema } from "@/lib/validation/schemas";

export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  return jsonOk(await listCategories(pool, context.locationId));
});

/** CFG-02: the catalogue is `catalog:manage` (OWNER/MANAGER, DEC-07). */
export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "catalog:manage");
  const body = await parseJsonBody(request, categorySchema);
  return jsonOk(await addCategory(context, body), { status: 201 });
});
