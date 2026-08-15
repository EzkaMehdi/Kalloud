import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { apiRoute, jsonOk } from "@/lib/http";
import { listStockCounts } from "@/lib/repositories/stock-counts";
import { recordStockCount } from "@/lib/services/stock";
import { parseIdParam, parseJsonBody } from "@/lib/validation/parse";
import { recordStockCountSchema } from "@/lib/validation/schemas";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * STK-07: a product's counting history — "stock avant, compté, différence,
 * auteur et date consultables", which is the acceptance criterion in full.
 * Readable by anyone who may see the catalogue; performing a count is what
 * requires `stock:adjust` (DEC-07).
 */
export const GET = apiRoute<RouteParams>(async (_request: NextRequest, { params }) => {
  const context = await requireRequestContext();
  const { id } = await params;
  const productId = parseIdParam(id, "Identifiant produit");

  return jsonOk(await listStockCounts(pool, context.locationId, productId));
});

export const POST = apiRoute<RouteParams>(async (request: NextRequest, { params }) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "stock:adjust");

  const { id } = await params;
  const productId = parseIdParam(id, "Identifiant produit");
  const body = await parseJsonBody(request, recordStockCountSchema);

  const result = await recordStockCount(
    context,
    productId,
    body.countedQuantity,
    body.note ?? null,
  );
  return jsonOk(result, { status: 201 });
});
