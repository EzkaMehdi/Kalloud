import type { NextRequest } from "next/server";
import { recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { pool } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { apiRoute, jsonOk, readJsonBody } from "@/lib/http";
import { getActiveBusinessDay } from "@/lib/repositories/business-days";
import {
  createCashMovement,
  listCashMovements,
  type CashMovementType,
} from "@/lib/repositories/cash-movements";

export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  const movements = await listCashMovements(pool, context.locationId);
  return jsonOk(movements);
});

interface CreateMovementBody {
  type?: CashMovementType;
  amount?: number;
  reason?: string;
}

export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "cash_movement:create");

  const body = await readJsonBody<CreateMovementBody>(request);
  if (body.type !== "IN" && body.type !== "OUT") {
    throw new ValidationError('Type de mouvement invalide (attendu "IN" ou "OUT").');
  }
  if (typeof body.amount !== "number" || !Number.isFinite(body.amount) || body.amount <= 0) {
    throw new ValidationError("Le montant doit être un nombre positif.");
  }
  if (!body.reason || !body.reason.trim()) {
    throw new ValidationError("Le motif est requis.");
  }

  const day = await getActiveBusinessDay(pool, context.locationId);
  if (!day) {
    throw new ValidationError("Ouvrez une journée avant d'enregistrer un mouvement.");
  }

  const movement = await createCashMovement(pool, context.locationId, {
    businessDayId: day.id,
    type: body.type,
    amount: body.amount,
    reason: body.reason.trim(),
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
