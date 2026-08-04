import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk, readJsonBody } from "@/lib/http";
import { performCheckout, type CheckoutInput } from "@/lib/services/checkout";

export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "orders:create");

  const body = await readJsonBody<Partial<CheckoutInput>>(request);
  const result = await performCheckout(context, {
    tableId: body.tableId ?? null,
    items: body.items ?? [],
    paymentMethod: body.paymentMethod ?? "CARD",
    cashAmount: body.cashAmount ?? 0,
    cardAmount: body.cardAmount ?? 0,
  });
  return jsonOk(result, { status: 201 });
});
