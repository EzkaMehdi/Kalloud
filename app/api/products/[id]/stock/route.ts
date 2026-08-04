import type { NextRequest } from "next/server";
import { recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { apiRoute, jsonOk, parseIdParam, readJsonBody } from "@/lib/http";
import { overwriteProductStockQuantity } from "@/lib/repositories/products";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface UpdateStockBody {
  quantity?: number;
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
  const body = await readJsonBody<UpdateStockBody>(request);
  if (typeof body.quantity !== "number" || !Number.isFinite(body.quantity) || body.quantity < 0) {
    throw new ValidationError("Quantité invalide.");
  }

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
