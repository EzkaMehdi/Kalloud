import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { apiRoute, jsonOk } from "@/lib/http";
import { renameDiningTable } from "@/lib/repositories/tables";
import { parseIdParam, parseJsonBody } from "@/lib/validation/parse";
import { updateDiningTableSchema } from "@/lib/validation/schemas";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Renaming a table is floor-plan configuration ("tables:manage", OWNER/
 * MANAGER only). The FREE/OCCUPIED branch this handler used to carry is
 * gone with ORD-03: occupancy is derived from the table's open ticket, so
 * there is no status left for a client to set — the browser's optimistic
 * `PATCH {status: "OCCUPIED"}`, which could leave a table occupied forever
 * when the order that justified it never happened, has no replacement by
 * design. Opening a ticket is `POST /api/tickets`.
 */
export const PATCH = apiRoute<RouteParams>(async (request: NextRequest, { params }) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "tables:manage");

  const { id } = await params;
  const tableId = parseIdParam(id, "Identifiant table");
  const body = await parseJsonBody(request, updateDiningTableSchema);

  const table = await renameDiningTable(pool, context.locationId, tableId, body.name);
  return jsonOk(table);
});
