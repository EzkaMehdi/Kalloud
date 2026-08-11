import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { editProduct } from "@/lib/services/configuration";
import { parseIdParam, parseJsonBody } from "@/lib/validation/parse";
import { updateProductSchema } from "@/lib/validation/schemas";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const PATCH = apiRoute<RouteParams>(async (request: NextRequest, { params }) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "catalog:manage");

  const { id } = await params;
  const productId = parseIdParam(id, "Identifiant produit");
  // The body used to be forwarded to the repository as-is: any key the
  // client sent, with any type. The schema now bounds every field and
  // requires at least one of them (API-01).
  const body = await parseJsonBody(request, updateProductSchema);
  // CFG-02: through the service, so the change is audited.
  const product = await editProduct(context, productId, body);
  return jsonOk(product);
});
