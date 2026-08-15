import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { adjustProductStock } from "@/lib/services/stock";
import { parseIdParam, parseJsonBody } from "@/lib/validation/parse";
import { adjustStockSchema } from "@/lib/validation/schemas";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * STK-04: records a stock adjustment as a delta.
 *
 * `PATCH` used to live here and took `{ quantity }` — the new absolute
 * balance, computed by the screen as `product.stock_quantity + amount` from
 * the copy it had loaded. A sale settled between render and click was
 * therefore erased, silently, with the ledger and the materialized column
 * left disagreeing. That endpoint is gone rather than deprecated: leaving an
 * absolute write reachable would leave the race reachable ("anciens
 * endpoints d'écriture absolue retirés").
 *
 * `POST` because each adjustment is a new entry in the ledger, not an edit
 * of the product: two identical receipts of 6 units are two real events, and
 * the movement history (DEC-06) records both.
 */
export const POST = apiRoute<RouteParams>(async (request: NextRequest, { params }) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "stock:adjust");

  const { id } = await params;
  const productId = parseIdParam(id, "Identifiant produit");
  const body = await parseJsonBody(request, adjustStockSchema);

  const result = await adjustProductStock(context, productId, body);
  return jsonOk(result, { status: 201 });
});
