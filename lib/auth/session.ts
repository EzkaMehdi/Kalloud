import type { Queryable } from "../db";
import type { Role } from "../authz";
import { generateToken, hashToken } from "./tokens";
import { SESSION_TTL_MS } from "./cookies";

export interface CreateSessionResult {
  token: string;
  sessionId: number;
  expiresAt: Date;
}

export interface SessionMeta {
  userAgent?: string | null;
  ipAddress?: string | null;
}

export async function createSession(
  db: Queryable,
  userId: number,
  meta: SessionMeta = {},
): Promise<CreateSessionResult> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const {
    rows: [row],
  } = await db.query<{ id: number }>(
    `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, tokenHash, expiresAt, meta.userAgent ?? null, meta.ipAddress ?? null],
  );
  return { token, sessionId: row.id, expiresAt };
}

export interface AuthenticatedSession {
  sessionId: number;
  userId: number;
  userEmail: string;
  userName: string;
  organizationId: number;
  locationId: number;
  role: Role;
}

/**
 * Resolves a raw cookie token into the user/organization/location/role it
 * grants, or null if it is missing, expired, revoked, or the account/
 * membership has been disabled in the meantime (SEC-04). When a user holds
 * more than one active membership (not created by any current onboarding
 * flow, but not forbidden by the schema either), the lowest membership id
 * wins — a documented MVP simplification, since DEC-01 targets one
 * organization per user for the pilot.
 */
export async function findAuthenticatedSession(
  db: Queryable,
  rawToken: string,
): Promise<AuthenticatedSession | null> {
  const tokenHash = hashToken(rawToken);
  const { rows } = await db.query<{
    session_id: number;
    user_id: number;
    user_email: string;
    user_name: string;
    organization_id: number;
    location_id: number;
    role: Role;
  }>(
    `SELECT s.id AS session_id, u.id AS user_id, u.email AS user_email, u.name AS user_name,
            m.organization_id, m.location_id, m.role
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN memberships m ON m.user_id = u.id AND m.status = 'ACTIVE'
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.status = 'ACTIVE'
     ORDER BY m.id
     LIMIT 1`,
    [tokenHash],
  );

  const row = rows[0];
  if (!row) return null;

  try {
    await db.query("UPDATE sessions SET last_used_at = now() WHERE id = $1", [row.session_id]);
  } catch {
    // Best-effort bookkeeping only; never fail authentication because of it.
  }

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    userEmail: row.user_email,
    userName: row.user_name,
    organizationId: row.organization_id,
    locationId: row.location_id,
    role: row.role,
  };
}

export async function revokeSessionByToken(db: Queryable, rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken);
  await db.query(
    "UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
    [tokenHash],
  );
}

/** Used on password change/reset so every other device is signed out immediately (SEC-03 "révocation"). */
export async function revokeAllSessionsForUser(db: Queryable, userId: number): Promise<void> {
  await db.query(
    "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  );
}
