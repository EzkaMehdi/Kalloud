import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { reorderTables } from "@/lib/services/configuration";
import { parseJsonBody } from "@/lib/validation/parse";
import { reorderTablesSchema } from "@/lib/validation/schemas";

/** CFG-03: arranging the floor plan is configuration, gated by `tables:manage`. */
export const PUT = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "tables:manage");
  const body = await parseJsonBody(request, reorderTablesSchema);
  return jsonOk(await reorderTables(context, body));
});
