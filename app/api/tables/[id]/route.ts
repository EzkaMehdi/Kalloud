import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { editDiningTableName, setDiningTableActivation } from "@/lib/services/configuration";
import { parseIdParam, parseJsonBody } from "@/lib/validation/parse";
import { updateDiningTableSchema } from "@/lib/validation/schemas";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * CFG-03: renaming or deactivating a table — both floor-plan configuration,
 * gated by `tables:manage` (OWNER/MANAGER, DEC-07).
 *
 * The FREE/OCCUPIED branch this handler used to carry is gone with ORD-03:
 * occupancy is derived from the table's open ticket, so there is no status
 * for a client to set. Deactivation is refused while a ticket is open —
 * silently hiding a table someone is still serving is exactly what CFG-03's
 * acceptance criterion rules out.
 */
export const PATCH = apiRoute<RouteParams>(async (request: NextRequest, { params }) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "tables:manage");

  const { id } = await params;
  const tableId = parseIdParam(id, "Identifiant table");
  const body = await parseJsonBody(request, updateDiningTableSchema);

  if (body.isActive !== undefined) {
    return jsonOk(await setDiningTableActivation(context, tableId, { isActive: body.isActive }));
  }
  return jsonOk(await editDiningTableName(context, tableId, body.name!));
});
