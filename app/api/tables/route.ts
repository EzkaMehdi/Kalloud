import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { apiRoute, jsonOk } from "@/lib/http";
import { listAllDiningTables, listDiningTables } from "@/lib/repositories/tables";
import { addDiningTable } from "@/lib/services/configuration";
import { parseJsonBody } from "@/lib/validation/parse";
import { createDiningTableSchema } from "@/lib/validation/schemas";

/**
 * The floor plan lists active tables only; the configuration screen asks for
 * everything with `?all=true` (CFG-03), so a deactivated table stays
 * reachable to be turned back on.
 */
export const GET = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  const all = new URL(request.url).searchParams.get("all") === "true";
  return jsonOk(
    all
      ? await listAllDiningTables(pool, context.locationId)
      : await listDiningTables(pool, context.locationId),
  );
});

export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "tables:manage");

  const body = await parseJsonBody(request, createDiningTableSchema);
  // CFG-03: through the service, so the creation is audited.
  return jsonOk(await addDiningTable(context, body), { status: 201 });
});
