import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { getReceipt } from "@/lib/services/receipts";
import { parseIdParam } from "@/lib/validation/parse";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * ORD-09: the receipt for an order.
 *
 * No permission beyond an authenticated session: a cashier hands the
 * customer their receipt, so gating it behind a manager role would make the
 * product unusable. Scoping is what protects it — `getReceipt` reads within
 * the caller's establishment only (SEC-06).
 */
export const GET = apiRoute<RouteParams>(async (_request, { params }) => {
  const context = await requireRequestContext();
  const { id } = await params;
  return jsonOk(await getReceipt(context, parseIdParam(id, "Identifiant commande")));
});
