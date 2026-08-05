import type { NextRequest } from "next/server";
import { recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { apiRoute, jsonOk } from "@/lib/http";
import { overwriteProductStockQuantity } from "@/lib/repositories/products";
import { parseIdParam, parseJsonBody } from "@/lib/validation/parse";
import { updateStockSchema } from "@/lib/validation/schemas";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * TODO(STK-04, phase 5B): absolute-write endpoint kept only for continuity
 * with the current stock screen; it will be replaced by a delta mutation
 * carrying a type/reason (see lib/repositories/products.ts).
 */
export const PATCH = apiRoute<RouteParams>(async (request: NextRequest, { params }) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "stock:adjust");

  const { id } = await params;
  const productId = parseIdParam(id, "Identifiant produit");
  const body = await parseJsonBody(request, updateStockSchema);

  const product = await overwriteProductStockQuantity(
    pool,
    context.locationId,
    productId,
    body.quantity,
  );
  await recordAuditEvent(pool, {
    locationId: context.locationId,
    actorUserId: context.userId,
    action: "product.stock_overwrite",
    targetType: "product",
    targetId: productId,
    after: { quantity: body.quantity },
  });
  return jsonOk(product);
});
