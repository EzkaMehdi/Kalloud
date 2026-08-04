import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { apiRoute, jsonOk, parseIdParam, readJsonBody } from "@/lib/http";
import {
  renameDiningTable,
  setDiningTableStatus,
  type DiningTableStatus,
} from "@/lib/repositories/tables";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface UpdateTableBody {
  name?: string;
  status?: DiningTableStatus;
}

/**
 * Renaming a table is floor-plan configuration ("tables:manage", OWNER/
 * MANAGER only); flipping FREE/OCCUPIED is routine service activity that
 * any operational role can do while seating a customer ("orders:create").
 * The single endpoint mirrors the prototype's shape; ORD-03 (phase 4A)
 * removes the status branch entirely once it is derived from open orders.
 */
export const PATCH = apiRoute<RouteParams>(async (request: NextRequest, { params }) => {
  const context = await requireRequestContext();
  const { id } = await params;
  const tableId = parseIdParam(id, "Identifiant table");
  const body = await readJsonBody<UpdateTableBody>(request);

  if (body.name !== undefined) {
    requirePermission(context.role, "tables:manage");
    const table = await renameDiningTable(pool, context.locationId, tableId, body.name);
    return jsonOk(table);
  }

  if (body.status !== undefined) {
    if (body.status !== "FREE" && body.status !== "OCCUPIED") {
      throw new ValidationError('Statut de table invalide (attendu "FREE" ou "OCCUPIED").');
    }
    requirePermission(context.role, "orders:create");
    const table = await setDiningTableStatus(pool, context.locationId, tableId, body.status);
    return jsonOk(table);
  }

  throw new ValidationError("Indiquez au moins un champ à modifier (name ou status).");
});
