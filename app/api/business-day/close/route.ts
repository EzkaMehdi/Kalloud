import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { requireIdempotencyKey, withIdempotency } from "@/lib/idempotency";
import { closeCurrentBusinessDay } from "@/lib/services/business-day";
import { parseJsonBody } from "@/lib/validation/parse";
import { closeBusinessDaySchema } from "@/lib/validation/schemas";

/**
 * CASH-02: closes the active service and stops there — opening the next one
 * is its own endpoint and its own confirmation (DEC-04). It does not demand
 * `business_day:open` on top of `business_day:close`; that second permission
 * was only needed back when closing also opened, so someone allowed to close
 * but not to open could not close at all.
 *
 * CASH-05: the payload is the count, and it is required — closing on an
 * unstated amount is what "montant vide ou invalide refusé" forbids.
 *
 * CASH-06/API-02: a close is a financial write whose response can be lost.
 * Without a key, a cashier retrying after a timeout is told "aucune journée
 * ouverte" — indistinguishable from a close that never happened, for an act
 * that is irreversible (DEC-04). With one, the retry replays the original
 * close, count and variance included. Two *simultaneous* closes are a
 * different problem, handled a layer down by the row lock in
 * `lockActiveBusinessDay`; keys protect the sequential retry, locks protect
 * the concurrent one, and CASH-06 needs both.
 */
export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "business_day:close");

  const idempotencyKey = requireIdempotencyKey(request);
  const body = await parseJsonBody(request, closeBusinessDaySchema);

  const { result, replayed } = await withIdempotency(
    context,
    { endpoint: "POST /api/business-day/close", key: idempotencyKey, payload: body },
    () => closeCurrentBusinessDay(context, body),
  );

  const response = jsonOk(result);
  if (replayed) {
    response.headers.set("Idempotent-Replay", "true");
  }
  return response;
});
