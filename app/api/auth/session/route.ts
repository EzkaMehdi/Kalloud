import { getRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";

/**
 * "Who am I" for the frontend shell (nav, role-based UI, dashboard access).
 * Deliberately returns 200 with `authenticated: false` rather than 401 when
 * there is no session: the absence of a session is the expected, normal
 * answer for this endpoint, not a failure.
 */
export const GET = apiRoute(async () => {
  const context = await getRequestContext();
  if (!context) {
    return jsonOk({ authenticated: false as const });
  }
  return jsonOk({
    authenticated: true as const,
    user: {
      id: context.userId,
      email: context.userEmail,
      name: context.userName,
      role: context.role,
    },
    organizationId: context.organizationId,
    locationId: context.locationId,
  });
});
