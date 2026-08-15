import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { apiRoute, jsonOk } from "@/lib/http";
import { getActiveBusinessDay, getBusinessDaySummary } from "@/lib/repositories/business-days";
import { getExpectedCash } from "@/lib/repositories/cash-movements";
import { getLocationSettings } from "@/lib/repositories/settings";
import { listOpenTickets } from "@/lib/repositories/tickets";

/**
 * Everything the closing screen needs, in one request.
 *
 * CASH-05 added the last two: `expectedCash` carries the four terms DEC-04
 * requires to be shown *above* the counted amount — a total alone cannot be
 * explained to a cashier who disagrees with it — and
 * `cashDiscrepancyThreshold` lets the form say which variances need a reason
 * before the user submits, rather than only refusing afterwards. The server
 * enforces the rule either way (CASH-05); this is so the screen does not have
 * to guess it.
 */
export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  const day = await getActiveBusinessDay(pool, context.locationId);
  if (!day) {
    throw new NotFoundError("Aucune journée ouverte.");
  }
  const [summary, expectedCash, settings, blockingTickets] = await Promise.all([
    getBusinessDaySummary(pool, context.locationId, day.id),
    getExpectedCash(pool, context.locationId, day.id),
    getLocationSettings(pool, context.locationId),
    // CASH-06: "liste des tickets bloquants affichée" (acceptance). Sent with
    // the rest so the screen can name them before the user tries to close,
    // rather than turning a refusal into a guessing game.
    listOpenTickets(pool, context.locationId),
  ]);
  return jsonOk({
    day,
    summary,
    expectedCash,
    cashDiscrepancyThreshold: settings.cashDiscrepancyThreshold,
    blockingTickets: blockingTickets.map((ticket) => ({
      id: ticket.id,
      order_number: ticket.order_number,
      table_name: ticket.table_name,
      total_amount: ticket.total_amount,
    })),
  });
});
