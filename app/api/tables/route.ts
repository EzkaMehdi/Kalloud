import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { apiRoute, jsonOk } from "@/lib/http";
import { createDiningTable, listDiningTables } from "@/lib/repositories/tables";
import { parseJsonBody } from "@/lib/validation/parse";
import { createDiningTableSchema } from "@/lib/validation/schemas";

export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  const tables = await listDiningTables(pool, context.locationId);
  return jsonOk(tables);
});

export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "tables:manage");

  const body = await parseJsonBody(request, createDiningTableSchema);
  const table = await createDiningTable(pool, context.locationId, body.name);
  return jsonOk(table, { status: 201 });
});
