import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { apiRoute, jsonOk, readJsonBody } from "@/lib/http";
import { createDiningTable, listDiningTables } from "@/lib/repositories/tables";

export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  const tables = await listDiningTables(pool, context.locationId);
  return jsonOk(tables);
});

interface CreateTableBody {
  name?: string;
}

export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "tables:manage");

  const body = await readJsonBody<CreateTableBody>(request);
  if (!body.name || !body.name.trim()) {
    throw new ValidationError("Le nom de la table est requis.");
  }
  const table = await createDiningTable(pool, context.locationId, body.name.trim());
  return jsonOk(table, { status: 201 });
});
