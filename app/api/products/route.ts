import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { apiRoute, jsonOk } from "@/lib/http";
import { fromCents } from "@/lib/money";
import { listProducts } from "@/lib/repositories/products";
import { createProductWithInitialStock } from "@/lib/services/products";
import { parseJsonBody } from "@/lib/validation/parse";
import { createProductSchema } from "@/lib/validation/schemas";

export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  const products = await listProducts(pool, context.locationId);
  return jsonOk(products);
});

export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "catalog:manage");

  // Previously an unnamed product became `""` and an unpriced one `"0"`,
  // both silently inserted. API-01 makes name and price required, and
  // enforces DEC-05's "2 décimales exactes" on the price — the rule that
  // rejects a 4,995 € product before it can ever be sold at a rounded price.
  const body = await parseJsonBody(request, createProductSchema);
  // STK-02: a non-zero starting stock is recorded as a real OPENING_BALANCE
  // movement, not just written to the materialized column — see
  // lib/services/products.ts for why.
  const product = await createProductWithInitialStock(context, {
    categoryId: body.categoryId ?? null,
    taxClassId: body.taxClassId ?? null,
    name: body.name,
    price: fromCents(body.price),
    unit: body.unit ?? null,
    stockQuantity: body.stockQuantity,
    alertThreshold: body.alertThreshold,
  });
  return jsonOk(product, { status: 201 });
});
