import type { Queryable } from "./db";

/**
 * SEC-09: an append-only business audit log. There is deliberately no
 * update/delete function here — only INSERT (recordAuditEvent) and read
 * (listAuditEvents) — so no operational role can be granted a way to alter
 * history through this module. Production database grants (OPS-05) should
 * additionally revoke UPDATE/DELETE on audit_events from the application
 * role as defense in depth.
 */
export interface AuditEventInput {
  locationId: number;
  actorUserId: number | null;
  action: string;
  targetType: string;
  targetId?: string | number | null;
  before?: unknown;
  after?: unknown;
}

export async function recordAuditEvent(db: Queryable, input: AuditEventInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (location_id, actor_user_id, action, target_type, target_id, before_data, after_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.locationId,
      input.actorUserId,
      input.action,
      input.targetType,
      input.targetId != null ? String(input.targetId) : null,
      input.before !== undefined ? JSON.stringify(input.before) : null,
      input.after !== undefined ? JSON.stringify(input.after) : null,
    ],
  );
}

export interface AuditEvent {
  id: number;
  locationId: number;
  actorUserId: number | null;
  action: string;
  targetType: string;
  targetId: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

interface AuditEventRow {
  id: number;
  location_id: number;
  actor_user_id: number | null;
  action: string;
  target_type: string;
  target_id: string | null;
  before_data: unknown;
  after_data: unknown;
  created_at: string;
}

function mapRow(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    locationId: row.location_id,
    actorUserId: row.actor_user_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    before: row.before_data,
    after: row.after_data,
    createdAt: row.created_at,
  };
}

export async function listAuditEvents(
  db: Queryable,
  locationId: number,
  options: { limit?: number } = {},
): Promise<AuditEvent[]> {
  const limit = Math.min(options.limit ?? 100, 500);
  const { rows } = await db.query<AuditEventRow>(
    `SELECT id, location_id, actor_user_id, action, target_type, target_id, before_data, after_data, created_at
     FROM audit_events
     WHERE location_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [locationId, limit],
  );
  return rows.map(mapRow);
}
