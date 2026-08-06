import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { apiRoute, jsonOk } from "@/lib/http";
import { getActiveBusinessDay } from "@/lib/repositories/business-days";
import { getCashBalance } from "@/lib/repositories/cash-movements";

export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  const day = await getActiveBusinessDay(pool, context.locationId);
  if (!day) {
    // CASH-01: "0.00" alone read exactly like a real, open register at a
    // zero balance — indistinguishable from an establishment that simply
    // never opened a day. `businessDayOpen` is additive (existing callers
    // reading only `balance` are unaffected) so the true state is at least
    // available; wiring the caisse screen to act on it is CASH-02/CASH-07.
    return jsonOk({ balance: "0.00", businessDayOpen: false });
  }
  const balance = await getCashBalance(pool, context.locationId, day.id);
  return jsonOk({ balance, businessDayOpen: true });
});
