import { pool } from "./db";
import { readSessionToken } from "./auth/cookies";
import { findAuthenticatedSession } from "./auth/session";
import type { Role } from "./authz";
import { UnauthenticatedError } from "./errors";
import { updateRequestContext } from "./logger";

/**
 * Everything a route handler is allowed to know about "who is asking and
 * for which establishment" (SEC-04). Built exclusively from the validated
 * session cookie: locationId/organizationId/role never come from the
 * request body or query string, so a client cannot impose an arbitrary
 * location_id onto a query.
 */
export interface RequestContext {
  userId: number;
  userEmail: string;
  userName: string;
  organizationId: number;
  locationId: number;
  role: Role;
  sessionId: number;
}

export async function getRequestContext(): Promise<RequestContext | null> {
  const token = await readSessionToken();
  if (!token) return null;

  const session = await findAuthenticatedSession(pool, token);
  if (!session) return null;

  const context: RequestContext = {
    userId: session.userId,
    userEmail: session.userEmail,
    userName: session.userName,
    organizationId: session.organizationId,
    locationId: session.locationId,
    role: session.role,
    sessionId: session.sessionId,
  };

  updateRequestContext({ userId: context.userId, locationId: context.locationId });
  return context;
}

/** Same as getRequestContext(), but throws the standard 401 instead of returning null. */
export async function requireRequestContext(): Promise<RequestContext> {
  const context = await getRequestContext();
  if (!context) {
    throw new UnauthenticatedError();
  }
  return context;
}
