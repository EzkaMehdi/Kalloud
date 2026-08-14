import type { NextRequest } from "next/server";
import { recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { apiRoute, jsonOk } from "@/lib/http";
import { requireIdempotencyKey, withIdempotency } from "@/lib/idempotency";
import { fromCents } from "@/lib/money";
import { getActiveBusinessDay } from "@/lib/repositories/business-days";
import { createCashMovement, listCashMovements } from "@/lib/repositories/cash-movements";
import { parseJsonBody } from "@/lib/validation/parse";
import { createCashMovementSchema } from "@/lib/validation/schemas";

export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  const movements = await listCashMovements(pool, context.locationId);
  return jsonOk(movements);
});

export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "cash_movement:create");

  const idempotencyKey = requireIdempotencyKey(request);
  // API-01: type, amount and reason are now checked by
  // createCashMovementSchema before this handler runs — including the
  // 2-decimal rule (DEC-05) the previous `typeof body.amount === "number"`
  // check let through.
  const body = await parseJsonBody(request, createCashMovementSchema);

  // API-02: a cash movement is a financial write like a sale. Two identical
  // "sortie de 20 €" rows are indistinguishable from one real withdrawal
  // recorded twice, and the cash count at closing would never balance.
  const { result, replayed } = await withIdempotency(
    context,
    { endpoint: "POST /api/cash-movements", key: idempotencyKey, payload: body },
    async () => {
      const day = await getActiveBusinessDay(pool, context.locationId);
      if (!day) {
        throw new ValidationError("Ouvrez une journée avant d'enregistrer un mouvement.");
      }

      const movement = await createCashMovement(pool, context.locationId, {
        businessDayId: day.id,
        type: body.type,
        category: body.category,
        amount: fromCents(body.amountCents),
        reason: body.reason,
        createdBy: context.userId,
      });

      await recordAuditEvent(pool, {
        locationId: context.locationId,
        actorUserId: context.userId,
        action: "cash_movement.create",
        targetType: "cash_movement",
        targetId: movement.id,
        // CASH-03: the category is part of what makes the movement
        // auditable. Without it the trail records that 200 € left the till
        // but not whether that was a purchase or the end-of-service
        // withdrawal — the one distinction CASH-04 reconciles against.
        after: {
          type: movement.type,
          category: movement.category,
          amount: movement.amount,
          reason: movement.reason,
        },
      });

      return movement;
    },
  );

  const response = jsonOk(result, { status: 201 });
  if (replayed) {
    response.headers.set("Idempotent-Replay", "true");
  }
  return response;
});
