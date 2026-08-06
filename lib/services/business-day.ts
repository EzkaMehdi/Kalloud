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
 * into `business_days` was `closeAndReopenBusinessDay` below, which
 * requires an active day to close first — a new establishment could never
 * open its first one through the API at all (scripts/seed.mjs worked
 * around this with a raw INSERT, which is exactly the kind of gap this
 * closes). CASH-02 (phase 5A) is what gives "open" and "close" their own
 * distinct, separately-confirmed UI actions per DEC-04; this is the
 * service layer that makes standalone opening possible at all.
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

export interface CloseAndReopenResult {
  closed: BusinessDayRow & { summary: Awaited<ReturnType<typeof getBusinessDaySummary>> };
  opened: BusinessDayRow;
}

/**
 * TODO(CASH-02, phase 5A): the prototype (and this port) combines "close"
 * and "open the next service" into a single action, which DEC-04 explicitly
 * decided against for the final product ("Nouvelle journée" must become two
 * distinct, separately confirmed actions). Kept as one call here only to
 * preserve current behaviour while the rest of the security/foundation work
 * lands; CASH-02 replaces this with `closeBusinessDay`/`openBusinessDay`
 * exposed as separate, explicitly-confirmed endpoints.
 */
export async function closeAndReopenBusinessDay(
  context: RequestContext,
  nextOpeningCashCents: number,
): Promise<CloseAndReopenResult> {
  const nextOpeningCash = fromCents(nextOpeningCashCents);

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

    const opened = await openBusinessDay(client, context.locationId, nextOpeningCash);
    await createCashMovement(client, context.locationId, {
      businessDayId: opened.id,
      type: "OPENING",
      amount: nextOpeningCash,
      reason: "Fond de caisse — nouvelle journée",
      createdBy: context.userId,
    });

    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "business_day.close_and_reopen",
      targetType: "business_day",
      targetId: activeDay.id,
      before: { status: activeDay.status },
      after: { closedId: closed.id, openedId: opened.id, summary },
    });

    return { closed: { ...closed, summary }, opened };
  });
}
