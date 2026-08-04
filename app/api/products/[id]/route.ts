import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { apiRoute, jsonOk, parseIdParam, readJsonBody } from "@/lib/http";
import { updateProduct } from "@/lib/repositories/products";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface UpdateProductBody {
  name?: string;
  price?: string;
  stockQuantity?: number;
  alertThreshold?: number;
  isActive?: boolean;
}

export const PATCH = apiRoute<RouteParams>(async (request: NextRequest, { params }) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "catalog:manage");

  const { id } = await params;
  const productId = parseIdParam(id, "Identifiant produit");
  const body = await readJsonBody<UpdateProductBody>(request);
  const product = await updateProduct(pool, context.locationId, productId, body);
  return jsonOk(product);
});
