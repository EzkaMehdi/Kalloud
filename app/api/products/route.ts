import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { apiRoute, jsonOk, readJsonBody } from "@/lib/http";
import { createProduct, listProducts } from "@/lib/repositories/products";

export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  const products = await listProducts(pool, context.locationId);
  return jsonOk(products);
});

interface CreateProductBody {
  categoryId?: number | null;
  name?: string;
  price?: string;
  stockQuantity?: number;
  alertThreshold?: number;
}

export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "catalog:manage");

  const body = await readJsonBody<CreateProductBody>(request);
  const product = await createProduct(pool, context.locationId, {
    categoryId: body.categoryId ?? null,
    name: body.name ?? "",
    price: body.price ?? "0",
    stockQuantity: body.stockQuantity,
    alertThreshold: body.alertThreshold,
  });
  return jsonOk(product, { status: 201 });
});
