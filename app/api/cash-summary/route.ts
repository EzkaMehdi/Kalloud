import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { apiRoute, jsonOk } from "@/lib/http";
import { getActiveBusinessDay } from "@/lib/repositories/business-days";
import { getExpectedCash } from "@/lib/repositories/cash-movements";

export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  const day = await getActiveBusinessDay(pool, context.locationId);
  if (!day) {
    // CASH-01: "0.00" alone read exactly like a real, open register at a
    // zero balance — indistinguishable from an establishment that simply
    // never opened a day. `businessDayOpen` tells the two apart; CASH-02
    // is what made the caisse screen act on it.
    return jsonOk({ balance: "0.00", businessDayOpen: false });
  }

  // CASH-04: the same function the closing uses, so the figure a cashier
  // watches all service cannot disagree with the one they are asked to
  // reconcile against. `balance` is kept as the total's name for existing
  // callers; `expectedCash` carries the terms behind it, which DEC-04
  // requires the closing screen to show (CASH-05).
  const expectedCash = await getExpectedCash(pool, context.locationId, day.id);
  return jsonOk({ balance: expectedCash.expected, businessDayOpen: true, expectedCash });
});
