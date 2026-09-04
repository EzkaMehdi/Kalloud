import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { changeMemberRole, setMemberStatus } from "@/lib/services/team";
import { parseIdParam, parseJsonBody } from "@/lib/validation/parse";
import { updateMemberSchema } from "@/lib/validation/schemas";

interface RouteParams {
  params: Promise<{ userId: string }>;
}

/**
 * SAAS-02: changing a member's role, or suspending and restoring them.
 *
 * The user id is addressed directly rather than through a membership id
 * because that is what the team screen holds; the service resolves it
 * through this location's memberships, so an id from another establishment
 * is not found rather than modified.
 */
export const PATCH = apiRoute<RouteParams>(async (request: NextRequest, { params }) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "users:manage");

  const { userId } = await params;
  const targetUserId = parseIdParam(userId, "Identifiant utilisateur");
  const body = await parseJsonBody(request, updateMemberSchema);

  if (body.role !== undefined) {
    return jsonOk(await changeMemberRole(context, targetUserId, body.role));
  }
  return jsonOk(await setMemberStatus(context, targetUserId, body.isActive!));
});
