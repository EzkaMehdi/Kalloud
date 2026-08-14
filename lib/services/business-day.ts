import { withTransaction } from "../db";
import { ConflictError, isUniqueViolation, ValidationError } from "../errors";
import { recordAuditEvent } from "../audit";
import { fromCents, toCents } from "../money";
import {
  type BusinessDayRow,
  closeBusinessDay,
  getActiveBusinessDay,
  getBusinessDaySummary,
  openBusinessDay,
} from "../repositories/business-days";
import { createCashMovement } from "../repositories/cash-movements";
import type { RequestContext } from "../context";

/**
 * CASH-01: opens the very first business day for a location, or any
 * subsequent one after a clean close. Before this existed, the only way
 * into `business_days` was the close-and-reopen call below, which requires
 * an active day to close first — a new establishment could never open its
 * first one through the API at all (scripts/seed.mjs worked around this
 * with a raw INSERT, which is exactly the kind of gap this closes).
 *
 * CASH-02: that combined call is gone, so this is now the single entry
 * point for opening a service, whether it is the first of an establishment
 * or the next one after a close.
 */
export async function openNewBusinessDay(
  context: RequestContext,
  openingCashCents: number,
): Promise<BusinessDayRow> {
  const openingCash = fromCents(openingCashCents);

  try {
    return await withTransaction(async (client) => {
      const activeDay = await getActiveBusinessDay(client, context.locationId);
      if (activeDay) {
        throw new ConflictError("Une journée de caisse est déjà ouverte pour cet établissement.");
      }

      const opened = await openBusinessDay(client, context.locationId, openingCash);
      await createCashMovement(client, context.locationId, {
        businessDayId: opened.id,
        type: "OPENING",
        amount: openingCash,
        reason: "Fond de caisse — ouverture de service",
        createdBy: context.userId,
      });

      await recordAuditEvent(client, {
        locationId: context.locationId,
        actorUserId: context.userId,
        action: "business_day.open",
        targetType: "business_day",
        targetId: opened.id,
        after: { openingCash },
      });

      return opened;
    });
  } catch (error) {
    // The pre-check above closes the common case with a clear message, but
    // it cannot see a second request racing it in another transaction — two
    // simultaneous "Ouvrir le service" taps, say. `one_open_business_day_per_
    // location` (migrations/0003) is what actually decides the winner; the
    // loser's INSERT fails a unique violation, which would otherwise surface
    // to the client as an opaque 500 instead of the same, honest 409.
    if (isUniqueViolation(error)) {
      throw new ConflictError("Une journée de caisse est déjà ouverte pour cet établissement.");
    }
    throw error;
  }
}

export interface CloseBusinessDayResult {
  closed: BusinessDayRow & { summary: Awaited<ReturnType<typeof getBusinessDaySummary>> };
}

/**
 * CASH-02: closes the active service, and nothing else. This replaces
 * `closeAndReopenBusinessDay`, which closed the day *and* opened the next
 * one in the same call — DEC-04 rules that out explicitly ("une nouvelle
 * journée peut être ouverte immédiatement (proposé par l'interface) mais
 * reste un choix explicite de l'utilisateur, jamais automatique"). Opening
 * is `openNewBusinessDay` above, reached by its own endpoint and its own
 * confirmation, so a cashier who only meant to close the till no longer
 * silently starts a second service — and no longer has a fund amount
 * imposed on that service by the closing dialog.
 *
 * A closed day is final (DEC-04): there is deliberately no reopen path.
 *
 * Scope note: the closing figure stays `opening_cash + cash_revenue`, the
 * same arithmetic this function already used. The canonical expected-cash
 * formula (adding movements in and out, net of cash refunds) is CASH-04,
 * and the counted amount and variance the user types in are CASH-05;
 * neither is anticipated here. Guarding two concurrent closes is CASH-06.
 */
export async function closeCurrentBusinessDay(
  context: RequestContext,
): Promise<CloseBusinessDayResult> {
  return withTransaction(async (client) => {
    const activeDay = await getActiveBusinessDay(client, context.locationId);
    if (!activeDay) {
      throw new ValidationError("Aucune journée ouverte.");
    }

    const summary = await getBusinessDaySummary(client, context.locationId, activeDay.id);
    // Summed in integer cents rather than with `Number(a) + Number(b)`:
    // adding two DECIMAL(10,2) values as binary floats can land a centime
    // off, and this figure is what the closing cash count is compared to
    // (DEC-05).
    const calculatedClosingCash = fromCents(
      toCents(activeDay.opening_cash) + toCents(summary.cash_revenue),
    );
    const closed = await closeBusinessDay(
      client,
      context.locationId,
      activeDay.id,
      calculatedClosingCash,
    );

    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "business_day.close",
      targetType: "business_day",
      targetId: activeDay.id,
      before: { status: activeDay.status },
      after: { status: closed.status, closingCash: calculatedClosingCash, summary },
    });

    return { closed: { ...closed, summary } };
  });
}
