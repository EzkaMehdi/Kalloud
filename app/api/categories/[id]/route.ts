import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { editCategory } from "@/lib/services/configuration";
import { parseIdParam, parseJsonBody } from "@/lib/validation/parse";
import { categorySchema } from "@/lib/validation/schemas";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const PUT = apiRoute<RouteParams>(async (request: NextRequest, { params }) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "catalog:manage");
  const { id } = await params;
  const body = await parseJsonBody(request, categorySchema);
  return jsonOk(await editCategory(context, parseIdParam(id, "Identifiant catégorie"), body));
});
