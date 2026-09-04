import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { inviteMember, listTeam } from "@/lib/services/team";
import { parseJsonBody } from "@/lib/validation/parse";
import { inviteMemberSchema } from "@/lib/validation/schemas";

/**
 * SAAS-02: the establishment's team. `users:manage` is the OWNER's alone
 * (DEC-07), and it gates the read as well as the writes — the list carries
 * every colleague's e-mail address, which a cashier has no reason to
 * enumerate.
 */
export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  requirePermission(context.role, "users:manage");
  return jsonOk(await listTeam(context));
});

export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "users:manage");

  const body = await parseJsonBody(request, inviteMemberSchema);
  return jsonOk(await inviteMember(context, body), { status: 201 });
});
