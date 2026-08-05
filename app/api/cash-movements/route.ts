import type { NextRequest } from "next/server";
import { recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { apiRoute, jsonOk } from "@/lib/http";
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

  // API-01: type, amount and reason are now checked by
  // createCashMovementSchema before this handler runs — including the
  // 2-decimal rule (DEC-05) the previous `typeof body.amount === "number"`
  // check let through.
  const body = await parseJsonBody(request, createCashMovementSchema);

  const day = await getActiveBusinessDay(pool, context.locationId);
  if (!day) {
    throw new ValidationError("Ouvrez une journée avant d'enregistrer un mouvement.");
  }

  const movement = await createCashMovement(pool, context.locationId, {
    businessDayId: day.id,
    type: body.type,
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
    after: { type: movement.type, amount: movement.amount, reason: movement.reason },
  });

  return jsonOk(movement, { status: 201 });
});
